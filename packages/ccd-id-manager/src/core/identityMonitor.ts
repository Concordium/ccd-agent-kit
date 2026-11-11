import type {
  IdentityMonitorCandidate, IdentityStore, IdentityWorkflow,
} from './workflowTypes.js';
import { identityLabelValue } from './identityLabels.js';

const INITIAL_DELAY_MS = 5_000;
const MAX_DELAY_MS = 300_000;

/** Lifecycle of the package-local background identity monitor. */
export interface IdentityMonitor {
  /** Start discovering and monitoring durable identity attempts. */
  start(): void;
  /** Rescan durable state after a request may have created an attempt. */
  wake(): void;
  /** Cancel follow-up work and wait for checks already in flight. */
  stop(): Promise<void>;
}

interface ScheduledAttempt {
  candidate: IdentityMonitorCandidate;
  deadline: number;
  delay: number;
  timer?: ReturnType<typeof setTimeout>;
}

/** Dependencies for {@link createIdentityMonitor}. */
export interface IdentityMonitorOptions {
  workflow: IdentityWorkflow;
  store: Pick<IdentityStore, 'listIdentityMonitorCandidates'>;
  getIdentityRequestTimeoutMs(network: string): Promise<number>;
  now?: () => number;
  /** Best-effort notification after a durable terminal summary change. */
  onChange?: (summary: Awaited<ReturnType<IdentityWorkflow['monitorIdentity']>>) => void | Promise<void>;
}

/**
 * Create one in-process worker for bounded, attempt-bound identity recovery checks.
 * Durable workflow and reservation state remain owned by the injected workflow and store.
 */
export function createIdentityMonitor(options: IdentityMonitorOptions): IdentityMonitor {
  const now = options.now ?? Date.now;
  const attempts = new Map<string, ScheduledAttempt>();
  const completedAttempts = new Set<string>();
  const inFlightOperations = new Map<string, Promise<void>>();
  let running = false;
  let scan: Promise<void> | undefined;
  let discoveryTimer: ReturnType<typeof setTimeout> | undefined;

  const keyFor = (candidate: IdentityMonitorCandidate) =>
    `${candidate.record.selection.network}:${candidate.record.id}`;
  const attemptKey = (key: string, attemptId: string) => `${key}:${attemptId}`;

  const notify = async (summary: Awaited<ReturnType<IdentityWorkflow['monitorIdentity']>>) => {
    if (options.onChange === undefined) return;
    try { await options.onChange(summary); }
    catch { /* Resource notifications are best effort. */ }
  };

  const clearDiscoveryTimer = () => {
    if (discoveryTimer !== undefined) clearTimeout(discoveryTimer);
    discoveryTimer = undefined;
  };

  const scheduleDiscovery = () => {
    if (!running || discoveryTimer !== undefined) return;
    discoveryTimer = setTimeout(() => {
      discoveryTimer = undefined;
      requestScan();
    }, INITIAL_DELAY_MS);
  };

  const removeAttempt = (key: string, attempt: ScheduledAttempt) => {
    if (attempt.timer !== undefined) clearTimeout(attempt.timer);
    attempts.delete(key);
  };

  const notifyUnknown = (key: string, attempt: ScheduledAttempt) => {
    const requestAttemptId = attempt.candidate.record.requestAttemptId;
    if (!running || attempts.get(key) !== attempt || requestAttemptId === undefined) return;
    completedAttempts.add(attemptKey(key, requestAttemptId));
    removeAttempt(key, attempt);
    const record = attempt.candidate.record;
    void notify({
      identityId: record.id,
      network: record.selection.network,
      identityProviderIndex: record.selection.identityProviderIndex,
      identityIndex: record.selection.identityIndex,
      status: 'unknown' as const,
      ...(record.sourceId === undefined ? {} : { sourceId: record.sourceId }),
      ...(record.label === undefined ? {} : { label: identityLabelValue(record.label) }),
    });
  };

  const scheduleAttempt = (key: string, attempt: ScheduledAttempt, delay: number) => {
    if (!running || attempts.get(key) !== attempt) return;
    const remaining = attempt.deadline - now();
    if (remaining <= 0) {
      notifyUnknown(key, attempt);
      return;
    }
    attempt.timer = setTimeout(() => {
      delete attempt.timer;
      if (now() >= attempt.deadline) {
        notifyUnknown(key, attempt);
        return;
      }
      const requestAttemptId = attempt.candidate.record.requestAttemptId;
      if (requestAttemptId === undefined) {
        removeAttempt(key, attempt);
        return;
      }
      const existingOperation = inFlightOperations.get(key);
      if (existingOperation !== undefined) {
        void existingOperation.finally(() => scheduleAttempt(key, attempt, 0));
        return;
      }
      const operation = (async () => {
        try {
          const summary = await options.workflow.monitorIdentity({
            network: attempt.candidate.record.selection.network,
            identityId: attempt.candidate.record.id,
            expectedAttemptId: requestAttemptId,
          });
          if (!running || attempts.get(key) !== attempt) return;
          if (summary.status !== 'pending') {
            completedAttempts.add(attemptKey(key, requestAttemptId));
            removeAttempt(key, attempt);
            await notify(summary);
            return;
          }
        } catch {
          // Provider, context, and source failures are inconclusive and use the same backoff.
        }
        if (!running || attempts.get(key) !== attempt) return;
        attempt.delay = Math.min(attempt.delay * 2, MAX_DELAY_MS);
        scheduleAttempt(key, attempt, Math.min(attempt.delay, attempt.deadline - now()));
      })();
      inFlightOperations.set(key, operation);
      void operation.finally(() => {
        inFlightOperations.delete(key);
        if (running && attempts.size === 0) scheduleDiscovery();
      });
    }, Math.min(delay, remaining));
  };

  const discover = async () => {
    let candidates: IdentityMonitorCandidate[];
    try {
      candidates = await options.store.listIdentityMonitorCandidates(now());
    } catch {
      if (running) scheduleDiscovery();
      return;
    }
    if (!running) return;
    const durableAttempts = new Set<string>();
    for (const candidate of candidates) {
      const attemptId = candidate.record.requestAttemptId;
      if (attemptId === undefined) continue;
      const key = keyFor(candidate);
      const durableAttempt = attemptKey(key, attemptId);
      durableAttempts.add(durableAttempt);
      if (completedAttempts.has(durableAttempt)) continue;
      const current = attempts.get(key);
      if (current?.candidate.record.requestAttemptId === attemptId) {
        continue;
      }
      if (current !== undefined) removeAttempt(key, current);
      try {
        const timeout = await options.getIdentityRequestTimeoutMs(candidate.record.selection.network);
        const deadline = candidate.reservedAt + timeout;
        if (!Number.isSafeInteger(deadline) || deadline <= now()) continue;
        const attempt: ScheduledAttempt = {
          candidate, deadline, delay: INITIAL_DELAY_MS,
        };
        attempts.set(key, attempt);
        scheduleAttempt(key, attempt, INITIAL_DELAY_MS);
      } catch {
        // Configuration lookup failures are retried by a later durable-state scan.
      }
    }
    for (const [key, attempt] of attempts) {
      const attemptId = attempt.candidate.record.requestAttemptId;
      if (attemptId !== undefined && !durableAttempts.has(attemptKey(key, attemptId))) removeAttempt(key, attempt);
    }
    for (const attempt of completedAttempts) {
      if (!durableAttempts.has(attempt)) completedAttempts.delete(attempt);
    }
    scheduleDiscovery();
  };

  function requestScan(): void {
    if (!running || scan !== undefined) return;
    const operation = discover();
    scan = operation;
    void operation.finally(() => {
      scan = undefined;
    });
  }

  return {
    start() {
      if (running) return;
      running = true;
      requestScan();
    },
    wake() {
      if (!running) return;
      clearDiscoveryTimer();
      requestScan();
    },
    async stop() {
      if (!running && scan === undefined && attempts.size === 0) return;
      running = false;
      clearDiscoveryTimer();
      for (const attempt of attempts.values()) {
        if (attempt.timer !== undefined) clearTimeout(attempt.timer);
      }
      const pending = [scan, ...inFlightOperations.values()]
        .filter((operation): operation is Promise<void> => operation !== undefined);
      await Promise.allSettled(pending);
      attempts.clear();
      completedAttempts.clear();
      inFlightOperations.clear();
    },
  };
}
