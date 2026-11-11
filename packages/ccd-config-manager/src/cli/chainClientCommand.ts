import { z } from 'zod';
import {
  loadChainClientConfig,
  resetChainClientConfig,
  updateChainClientStartupRefreshConfig,
  type AccountCredentialsStartupRefreshConfig,
} from '@ccd-agent-kit/config-utils';
import { validateCliOptions } from '@ccd-agent-kit/cli-utils';

export interface RunChainClientCommandOptions {
  request: ChainClientCommandRequest;
  stdout: string[];
  stderr: string[];
}

/** Operational request for ccd-chain-client configuration after Commander parsing. */
export type ChainClientCommandRequest =
  | { kind: 'show' }
  | { kind: 'startup-refresh-set'; enabled?: string; maxAge?: string; failureRetry?: string; concurrency?: string }
  | { kind: 'startup-refresh-reset' };

const chainClientCommandMessages = {
  noChanges: 'No changes specified.',
} as const;

const durationSchema = z.string().regex(/^\d+[smhd]$/, 'Expected duration like 5m, 24h, or 7d.');

/** Runs ccd-chain-client persisted configuration commands. */
export async function runChainClientCommand(options: RunChainClientCommandOptions): Promise<number> {
  const { request } = options;
  switch (request.kind) {
    case 'show':
      return runShow(options);
    case 'startup-refresh-set':
      return runStartupRefreshSet(options, request);
    case 'startup-refresh-reset':
      return runStartupRefreshReset(options);
  }
}

function runShow(options: RunChainClientCommandOptions): number {
  writeConfig(options.stdout, loadChainClientConfig());
  return 0;
}

function runStartupRefreshSet(options: RunChainClientCommandOptions, request: Extract<ChainClientCommandRequest, { kind: 'startup-refresh-set' }>): number {
  try {
    const patch = validateCliOptions(
      z.object({
        enabled: z
          .enum(['true', 'false'])
          .transform((value) => value === 'true')
          .optional(),
        maxAge: durationSchema.optional(),
        failureRetry: durationSchema.optional(),
        concurrency: z.coerce.number().int().positive().optional(),
      }),
      Object.fromEntries(Object.entries(request).filter(([, value]) => value !== undefined)),
    );
    if (Object.keys(patch).length === 0) {
      options.stdout.push(chainClientCommandMessages.noChanges);
      return 0;
    }
    writeConfig(options.stdout, updateChainClientStartupRefreshConfig(patch));
    return 0;
  } catch (error) {
    options.stderr.push(error instanceof Error ? error.message : String(error));
    return 2;
  }
}

function runStartupRefreshReset(options: RunChainClientCommandOptions): number {
  try {
    writeConfig(options.stdout, resetChainClientConfig());
    return 0;
  } catch (error) {
    options.stderr.push(error instanceof Error ? error.message : String(error));
    return 2;
  }
}

function writeConfig(stdout: string[], config: { accountCredentials: { startupRefresh: AccountCredentialsStartupRefreshConfig } }): void {
  const refresh = config.accountCredentials.startupRefresh;
  stdout.push(
    'ccd-chain-client configuration:',
    `  accountCredentials.startupRefresh.enabled: ${refresh.enabled}`,
    `  accountCredentials.startupRefresh.maxAge: ${refresh.maxAge}`,
    `  accountCredentials.startupRefresh.failureRetry: ${refresh.failureRetry}`,
    `  accountCredentials.startupRefresh.concurrency: ${refresh.concurrency}`,
  );
}
