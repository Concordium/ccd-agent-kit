import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';

import { createIdentityMonitor } from '../../src/core/identityMonitor.js';
import type { IdentityMonitorCandidate,IdentitySummary,IdentityWorkflow } from '../../src/core/workflowTypes.js';
import { IDENTITY_ID,NETWORK,awaitingRecord } from '../workflowFixtures.js';

const START = 1_900_000_000_000;
const ATTEMPT = '018f47a2-43d2-7ad9-8b5e-89d810f95a22';

function candidate(reservedAt = START): IdentityMonitorCandidate {
  return {
    record: { ...awaitingRecord(), requestAttemptId: ATTEMPT },
    reservedAt,
  };
}

function summary(status: IdentitySummary['status'] = 'pending'): IdentitySummary {
  return {
    identityId: IDENTITY_ID, network: NETWORK, identityProviderIndex: 7,
    identityIndex: 2, status,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function fixture(
  candidates: IdentityMonitorCandidate[] = [candidate()],
  onChange: ((summary: IdentitySummary) => void | Promise<void>) | null = vi.fn(async () => undefined),
  includeNow = true,
) {
  const workflow = {
    monitorIdentity: vi.fn(async () => summary()),
  } as unknown as IdentityWorkflow;
  const store = {
    listIdentityMonitorCandidates: vi.fn(async () => structuredClone(candidates)),
  };
  const getIdentityRequestTimeoutMs = vi.fn(async () => 86_400_000);
  const monitor = createIdentityMonitor({
    workflow, store, getIdentityRequestTimeoutMs,
    ...(onChange === null ? {} : { onChange }),
    ...(includeNow ? { now: () => Date.now() } : {}),
  });
  return { monitor, workflow, store, getIdentityRequestTimeoutMs, onChange };
}

describe('automatic identity monitor', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
  });

  afterEach(() => vi.useRealTimers());

  it('resumes durable attempts five seconds after startup and uses attempt-bound input', async () => {
    const h = fixture([candidate()], vi.fn(async () => undefined), false);
    h.monitor.start();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(h.workflow.monitorIdentity).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.workflow.monitorIdentity).toHaveBeenCalledExactlyOnceWith({
      network: NETWORK, identityId: IDENTITY_ID, expectedAttemptId: ATTEMPT,
    });
    expect(h.getIdentityRequestTimeoutMs).toHaveBeenCalledExactlyOnceWith(NETWORK);
    await h.monitor.stop();
  });

  it('backs off deterministically for pending and inconclusive checks without overlapping one identity', async () => {
    const h = fixture();
    vi.mocked(h.workflow.monitorIdentity)
      .mockResolvedValueOnce(summary('pending'))
      .mockRejectedValueOnce(new Error('provider unavailable'))
      .mockResolvedValueOnce(summary('issued'));
    h.monitor.start();

    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.workflow.monitorIdentity).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(h.workflow.monitorIdentity).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.workflow.monitorIdentity).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(19_999);
    expect(h.workflow.monitorIdentity).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.workflow.monitorIdentity).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(h.workflow.monitorIdentity).toHaveBeenCalledTimes(3);
    await h.monitor.stop();
  });

  it('caps backoff at five minutes and clips the last delay to the reservation deadline', async () => {
    const timeout = 620_000;
    const h = fixture();
    h.getIdentityRequestTimeoutMs.mockResolvedValue(timeout);
    h.monitor.start();

    await vi.advanceTimersByTimeAsync(5_000 + 10_000 + 20_000 + 40_000 + 80_000 + 160_000);
    expect(h.workflow.monitorIdentity).toHaveBeenCalledTimes(6);
    await vi.advanceTimersByTimeAsync(299_999);
    expect(h.workflow.monitorIdentity).toHaveBeenCalledTimes(6);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.workflow.monitorIdentity).toHaveBeenCalledTimes(7);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.workflow.monitorIdentity).toHaveBeenCalledTimes(7);
    await h.monitor.stop();
  });

  it('does not start a check at or after the deadline and does not release or mutate storage', async () => {
    const h = fixture([candidate(START - 86_400_000)]);
    h.monitor.start();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(h.workflow.monitorIdentity).not.toHaveBeenCalled();
    expect(h.store.listIdentityMonitorCandidates.mock.calls.length).toBeGreaterThan(1);
    await h.monitor.stop();
  });

  it('notifies the projected unknown summary when the deadline arrives without a provider check', async () => {
    const h = fixture([candidate(START - 86_400_000 + 5_000)]);
    h.monitor.start();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(h.onChange).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.workflow.monitorIdentity).not.toHaveBeenCalled();
    expect(h.onChange).toHaveBeenCalledExactlyOnceWith({
      identityId: IDENTITY_ID, network: NETWORK, identityProviderIndex: 7,
      identityIndex: 2, status: 'unknown', sourceId: expect.any(String),
    });
    await h.monitor.stop();
  });

  it('wake discovers a new durable attempt without duplicating an already scheduled identity', async () => {
    const h = fixture([]);
    h.monitor.start();
    await vi.advanceTimersByTimeAsync(0);
    h.store.listIdentityMonitorCandidates.mockResolvedValue([candidate()]);
    h.monitor.wake();
    h.monitor.wake();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.workflow.monitorIdentity).toHaveBeenCalledOnce();
    await h.monitor.stop();
  });

  it('stop cancels timers, waits for an in-flight check, and schedules no follow-up', async () => {
    const h = fixture();
    const operation = deferred<IdentitySummary>();
    vi.mocked(h.workflow.monitorIdentity).mockReturnValue(operation.promise);
    h.monitor.start();
    await vi.advanceTimersByTimeAsync(5_000);
    const stopped = h.monitor.stop();
    let settled = false;
    void stopped.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    operation.resolve(summary('pending'));
    await stopped;
    await vi.advanceTimersByTimeAsync(600_000);
    expect(h.workflow.monitorIdentity).toHaveBeenCalledOnce();
  });

  it('treats change-notification failure as best effort after a durable terminal result', async () => {
    const notify = vi.fn(async () => { throw new Error('host unsubscribed /private/socket'); });
    const h = fixture([candidate()], notify);
    vi.mocked(h.workflow.monitorIdentity).mockResolvedValue(summary('issued'));
    h.monitor.start();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(notify).toHaveBeenCalledExactlyOnceWith(summary('issued'));
    await vi.advanceTimersByTimeAsync(600_000);
    expect(h.workflow.monitorIdentity).toHaveBeenCalledOnce();
    await expect(h.monitor.stop()).resolves.toBeUndefined();
  });

  it('retries candidate-scan and timeout-configuration failures on later discovery scans', async () => {
    const h = fixture();
    h.store.listIdentityMonitorCandidates
      .mockRejectedValueOnce(new Error('protected path'))
      .mockResolvedValue([candidate()]);
    h.getIdentityRequestTimeoutMs.mockRejectedValueOnce(new Error('settings unavailable'));
    h.monitor.start();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.store.listIdentityMonitorCandidates).toHaveBeenCalledTimes(2);
    expect(h.workflow.monitorIdentity).not.toHaveBeenCalled();
    h.monitor.wake();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.workflow.monitorIdentity).toHaveBeenCalledOnce();
    await h.monitor.stop();
  });

  it('replaces changed attempts and cancels candidates removed by a wake scan', async () => {
    const first = candidate();
    const h = fixture([first]);
    h.monitor.start();
    await vi.advanceTimersByTimeAsync(0);
    const replacement = candidate();
    replacement.record.requestAttemptId = '018f47a2-43d2-7ad9-8b5e-89d810f95a23';
    h.store.listIdentityMonitorCandidates.mockResolvedValue([replacement]);
    h.monitor.wake();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.workflow.monitorIdentity).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      expectedAttemptId: replacement.record.requestAttemptId,
    }));

    h.store.listIdentityMonitorCandidates.mockResolvedValue([]);
    h.monitor.wake();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(h.workflow.monitorIdentity).toHaveBeenCalledOnce();
    await h.monitor.stop();
  });

  it('drops a scheduled attempt whose durable attempt ID disappears before its timer fires', async () => {
    const value = candidate();
    const h = fixture();
    h.store.listIdentityMonitorCandidates.mockResolvedValue([value]);
    h.monitor.start();
    await vi.advanceTimersByTimeAsync(0);
    delete value.record.requestAttemptId;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.workflow.monitorIdentity).not.toHaveBeenCalled();
    await h.monitor.stop();
  });

  it('is idempotent on repeated start/wake and ignores a scan that settles after stop', async () => {
    const scan = deferred<IdentityMonitorCandidate[]>();
    const h = fixture();
    h.store.listIdentityMonitorCandidates.mockReturnValue(scan.promise);
    h.monitor.start();
    h.monitor.start();
    h.monitor.wake();
    const stopped = h.monitor.stop();
    scan.resolve([candidate()]);
    await stopped;
    await vi.advanceTimersByTimeAsync(600_000);
    expect(h.store.listIdentityMonitorCandidates).toHaveBeenCalledOnce();
    expect(h.workflow.monitorIdentity).not.toHaveBeenCalled();
  });

  it('ignores wake and stop before start', async () => {
    const h = fixture();
    h.monitor.wake();
    await expect(h.monitor.stop()).resolves.toBeUndefined();
    expect(h.store.listIdentityMonitorCandidates).not.toHaveBeenCalled();
  });

  it('handles an already elapsed deadline after asynchronous timeout lookup without scheduling provider work', async () => {
    const h = fixture();
    const timeout = deferred<number>();
    h.getIdentityRequestTimeoutMs.mockReturnValue(timeout.promise);
    h.monitor.start();
    await vi.advanceTimersByTimeAsync(86_400_001);
    timeout.resolve(86_400_000);
    await Promise.resolve();
    expect(h.workflow.monitorIdentity).not.toHaveBeenCalled();
    await h.monitor.stop();
  });

  it.each(['void', 'throw'] as const)('keeps deadline notification best effort when callback returns %s', async (behavior) => {
    const onChange = behavior === 'void'
      ? vi.fn(() => undefined)
      : vi.fn(() => { throw new Error('host notification failed'); });
    const h = fixture([candidate(START - 86_400_000 + 5_000)], onChange);
    h.monitor.start();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(onChange).toHaveBeenCalledOnce();
    expect(h.workflow.monitorIdentity).not.toHaveBeenCalled();
    await h.monitor.stop();
  });

  it('prunes a completed marker after durable state no longer contains that attempt', async () => {
    const h = fixture();
    vi.mocked(h.workflow.monitorIdentity).mockResolvedValue(summary('issued'));
    h.monitor.start();
    await vi.advanceTimersByTimeAsync(5_000);
    h.store.listIdentityMonitorCandidates.mockResolvedValue([]);
    h.monitor.wake();
    await vi.advanceTimersByTimeAsync(0);
    const replacement = candidate(Date.now());
    replacement.record.requestAttemptId = '018f47a2-43d2-7ad9-8b5e-89d810f95a23';
    h.store.listIdentityMonitorCandidates.mockResolvedValue([replacement]);
    h.monitor.wake();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.workflow.monitorIdentity).toHaveBeenCalledTimes(2);
    await h.monitor.stop();
  });

  it('completes terminal and deadline attempts when no change callback is configured', async () => {
    const terminal = fixture([candidate()], null);
    vi.mocked(terminal.workflow.monitorIdentity).mockResolvedValue(summary('issued'));
    terminal.monitor.start();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(terminal.workflow.monitorIdentity).toHaveBeenCalledOnce();
    await terminal.monitor.stop();

    const expired = candidate(Date.now() - 86_400_000 + 5_000);
    delete expired.record.sourceId;
    expired.record.label = '@pending';
    const deadline = fixture([expired], null);
    deadline.monitor.start();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(deadline.workflow.monitorIdentity).not.toHaveBeenCalled();
    await deadline.monitor.stop();
  });

  it('swallows an asynchronously rejected deadline notification', async () => {
    const onChange = vi.fn(async () => { throw new Error('notification rejected'); });
    const h = fixture([candidate(START - 86_400_000 + 5_000)], onChange);
    h.monitor.start();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(onChange).toHaveBeenCalledOnce();
    await h.monitor.stop();
  });

  it('projects only present optional metadata in a deadline notification', async () => {
    const value = candidate(START - 86_400_000 + 5_000);
    delete value.record.sourceId;
    value.record.label = '@pending';
    const onChange = vi.fn();
    const h = fixture([value], onChange);
    h.monitor.start();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ label: 'pending', status: 'unknown' }));
    expect(onChange.mock.calls[0]![0]).not.toHaveProperty('sourceId');
    await h.monitor.stop();
  });

  it('drops a deadline notification if its durable attempt ID disappears first', async () => {
    const value = candidate(START - 86_400_000 + 5_000);
    const onChange = vi.fn();
    const h = fixture([value], onChange);
    h.store.listIdentityMonitorCandidates.mockResolvedValue([value]);
    h.monitor.start();
    await vi.advanceTimersByTimeAsync(0);
    delete value.record.requestAttemptId;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(onChange).not.toHaveBeenCalled();
    expect(h.workflow.monitorIdentity).not.toHaveBeenCalled();
    await h.monitor.stop();
  });

  it('does not reschedule an inconclusive old check after its attempt is replaced', async () => {
    const oldCheck = deferred<IdentitySummary>();
    const h = fixture();
    vi.mocked(h.workflow.monitorIdentity).mockReturnValueOnce(oldCheck.promise);
    h.monitor.start();
    await vi.advanceTimersByTimeAsync(5_000);
    const replacement = candidate(Date.now());
    replacement.record.requestAttemptId = '018f47a2-43d2-7ad9-8b5e-89d810f95a23';
    h.store.listIdentityMonitorCandidates.mockResolvedValue([replacement]);
    h.monitor.wake();
    oldCheck.reject(new Error('old provider failure'));
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.workflow.monitorIdentity).toHaveBeenCalledTimes(2);
    await h.monitor.stop();
  });

  it('does not retry a candidate scan that fails after stop', async () => {
    const scan = deferred<IdentityMonitorCandidate[]>();
    const h = fixture();
    h.store.listIdentityMonitorCandidates.mockReturnValue(scan.promise);
    h.monitor.start();
    const stopped = h.monitor.stop();
    scan.reject(new Error('late scan failure'));
    await stopped;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.store.listIdentityMonitorCandidates).toHaveBeenCalledOnce();
  });

  it('handles the deadline elapsing between candidate validation and timer scheduling', async () => {
    const value = candidate(START);
    const workflow = { monitorIdentity: vi.fn() } as unknown as IdentityWorkflow;
    const store = { listIdentityMonitorCandidates: vi.fn(async () => [value]) };
    const onChange = vi.fn();
    const times = [START, START, START + 100];
    const monitor = createIdentityMonitor({
      workflow, store, getIdentityRequestTimeoutMs: async () => 100,
      now: () => times.shift() ?? START + 100, onChange,
    });
    monitor.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(workflow.monitorIdentity).not.toHaveBeenCalled();
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ status: 'unknown' }));
    await monitor.stop();
  });


  it('keeps scanning when startup candidates are already expired and later discovers a new attempt', async () => {
    const expired = candidate(START - 86_400_000);
    const h = fixture([expired]);
    h.monitor.start();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.workflow.monitorIdentity).not.toHaveBeenCalled();

    const current = candidate(Date.now());
    current.record.id = 'ab'.repeat(32);
    current.record.requestAttemptId = '018f47a2-43d2-7ad9-8b5e-89d810f95a23';
    h.store.listIdentityMonitorCandidates.mockResolvedValue([expired, current]);
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.workflow.monitorIdentity).toHaveBeenCalledExactlyOnceWith({
      network: NETWORK, identityId: current.record.id,
      expectedAttemptId: current.record.requestAttemptId,
    });
    await h.monitor.stop();
  });

  it('never overlaps replacement attempts and stop waits for the removed in-flight check', async () => {
    const oldCheck = deferred<IdentitySummary>();
    const h = fixture();
    vi.mocked(h.workflow.monitorIdentity).mockReturnValueOnce(oldCheck.promise);
    h.monitor.start();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.workflow.monitorIdentity).toHaveBeenCalledOnce();

    const replacement = candidate(Date.now());
    replacement.record.requestAttemptId = '018f47a2-43d2-7ad9-8b5e-89d810f95a23';
    h.store.listIdentityMonitorCandidates.mockResolvedValue([replacement]);
    h.monitor.wake();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.workflow.monitorIdentity).toHaveBeenCalledOnce();

    const stopped = h.monitor.stop();
    let settled = false;
    void stopped.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    oldCheck.resolve(summary('issued'));
    await stopped;
    expect(h.onChange).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(h.workflow.monitorIdentity).toHaveBeenCalledOnce();
  });
});
