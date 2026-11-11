import { isStringRecord, readJsonFile, writeJsonFile } from './jsonFile.js';
import { getChainClientConfigPath } from './paths.js';

/** Startup refresh settings for cached account credentials. */
export interface AccountCredentialsStartupRefreshConfig {
  /** Whether ccd-chain-client should refresh existing cached credentials on startup. */
  enabled: boolean;
  /** Friendly duration string controlling when a successful observation is stale. */
  maxAge: string;
  /** Friendly duration string controlling retry delay after a failed startup refresh. */
  failureRetry: string;
  /** Maximum concurrent startup refresh requests. */
  concurrency: number;
}

/** Persisted ccd-chain-client configuration shared by ccd-config-manager and ccd-chain-client. */
export interface ChainClientConfig {
  accountCredentials: {
    startupRefresh: AccountCredentialsStartupRefreshConfig;
  };
}

const DEFAULT_CHAIN_CLIENT_CONFIG: ChainClientConfig = {
  accountCredentials: { startupRefresh: { enabled: true, maxAge: '24h', failureRetry: '5m', concurrency: 3 } },
};

function isDurationString(value: unknown): value is string {
  return typeof value === 'string' && /^\d+[smhd]$/.test(value);
}

function isStartupRefreshConfig(value: unknown): value is AccountCredentialsStartupRefreshConfig {
  const candidate = value as Partial<AccountCredentialsStartupRefreshConfig> | undefined;
  return (
    typeof candidate?.enabled === 'boolean' &&
    isDurationString(candidate.maxAge) && isDurationString(candidate.failureRetry) &&
    typeof candidate.concurrency === 'number' && Number.isSafeInteger(candidate.concurrency) &&
    candidate.concurrency > 0
  );
}

function normalizeChainClientConfig(value: unknown): ChainClientConfig | undefined {
  if (!isStringRecord(value) || !isStringRecord(value.accountCredentials)) return undefined;
  const startupRefresh = value.accountCredentials.startupRefresh;
  return isStartupRefreshConfig(startupRefresh) ? { accountCredentials: { startupRefresh } } : undefined;
}

/** Loads persisted ccd-chain-client configuration, falling back to built-in defaults when missing or invalid. */
export function loadChainClientConfig(): ChainClientConfig {
  return readJsonFile(getChainClientConfigPath(), normalizeChainClientConfig) ?? structuredClone(DEFAULT_CHAIN_CLIENT_CONFIG);
}

/** Saves persisted ccd-chain-client configuration. */
export function saveChainClientConfig(config: ChainClientConfig): void {
  writeJsonFile(getChainClientConfigPath(), config);
}

/** Updates persisted ccd-chain-client startup refresh settings. */
export function updateChainClientStartupRefreshConfig(patch: Partial<AccountCredentialsStartupRefreshConfig>): ChainClientConfig {
  const next: ChainClientConfig = {
    accountCredentials: { startupRefresh: { ...loadChainClientConfig().accountCredentials.startupRefresh, ...patch } },
  };
  if (!isStartupRefreshConfig(next.accountCredentials.startupRefresh)) {
    throw new Error('Invalid ccd-chain-client startup refresh configuration.');
  }
  saveChainClientConfig(next);
  return next;
}

/** Resets persisted ccd-chain-client configuration to built-in defaults. */
export function resetChainClientConfig(): ChainClientConfig {
  const config = structuredClone(DEFAULT_CHAIN_CLIENT_CONFIG);
  saveChainClientConfig(config);
  return config;
}
