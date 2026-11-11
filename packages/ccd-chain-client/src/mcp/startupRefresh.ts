import {
  loadAccountCredentials,
  loadNetworks,
  setAccountCredentialObservation,
  setAccountCredentialRefreshError,
} from '@ccd-agent-kit/config-utils';
import { caip2Reference } from '@ccd-agent-kit/sdk-utils';
import type { ServerConfig } from '../config.js';
import { isCompleteAccountCredentialObservation } from './accountCredentialsCache.js';
import type { NetworkClientProvider } from './toolPlumbing/toolTypes.js';
import { accountCredentialRefreshErrorFromUnknown } from './accounts/refreshErrors.js';

export interface StartupRefreshSummary {
  refreshed: number;
  skipped: number;
  failed: number;
}

export type StartupRefreshLogger = (line: string) => void;

/** Refreshes existing account-credential cache entries in the background on MCP startup. */
export async function refreshCachedAccountCredentialsOnStartup(
  config: ServerConfig,
  clients: NetworkClientProvider,
): Promise<StartupRefreshSummary> {
  const refreshConfig = config.accountCredentials.startupRefresh;
  const summary: StartupRefreshSummary = { refreshed: 0, skipped: 0, failed: 0 };
  if (!refreshConfig.enabled) return summary;

  const now = Date.now();
  const jobs: Array<() => Promise<void>> = [];
  for (const [networkName, network] of Object.entries(loadNetworks().networks)) {
    const caip2Ref = caip2Reference(network.caip2);
    for (const [address, observation] of Object.entries(loadAccountCredentials(caip2Ref))) {
      if (shouldSkipRefresh(observation.sourceBlock.time, observation.refreshError?.attempted, now, refreshConfig)) {
        summary.skipped += 1;
        continue;
      }
      jobs.push(async () => {
        try {
          const client = clients.getClient(networkName).client;
          const result = await client.getFinalizedAccountCredentials(address);
          if (!isCompleteAccountCredentialObservation(result.observation)) {
            throw { kind: 'node', message: 'The node returned an incomplete account credential observation.' };
          }
          setAccountCredentialObservation(result.canonicalAddress, result.observation, caip2Ref);
          summary.refreshed += 1;
        } catch (error) {
          setAccountCredentialRefreshError(address, accountCredentialRefreshErrorFromUnknown(error), caip2Ref);
          summary.failed += 1;
        }
      });
    }
  }

  await runBounded(jobs, refreshConfig.concurrency);
  return summary;
}

export function startStartupRefresh(input: {
  config: ServerConfig;
  clients: NetworkClientProvider;
  stderr: StartupRefreshLogger;
}): void {
  void refreshCachedAccountCredentialsOnStartup(input.config, input.clients)
    .then((summary) => {
      if (summary.refreshed + summary.skipped + summary.failed > 0) {
        input.stderr(
          `ccd-chain-client-mcp: account credential startup refresh: refreshed=${summary.refreshed} skipped=${summary.skipped} failed=${summary.failed}`,
        );
      }
    })
    .catch(() => {
      input.stderr('ccd-chain-client-mcp: account credential startup refresh failed.');
    });
}

function shouldSkipRefresh(
  sourceBlockTime: string,
  refreshErrorAttempted: string | undefined,
  now: number,
  config: ServerConfig['accountCredentials']['startupRefresh'],
): boolean {
  if (refreshErrorAttempted !== undefined && isRecentPastTimestamp(refreshErrorAttempted, now, config.failureRetryMs)) {
    return true;
  }
  return isRecentPastTimestamp(sourceBlockTime, now, config.maxAgeMs);
}

function isRecentPastTimestamp(value: string, now: number, maxAgeMs: number): boolean {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp <= now && now - timestamp < maxAgeMs;
}

async function runBounded(jobs: Array<() => Promise<void>>, concurrency: number): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
    while (next < jobs.length) {
      const job = jobs[next]!;
      next += 1;
      await job();
    }
  });
  await Promise.all(workers);
}
