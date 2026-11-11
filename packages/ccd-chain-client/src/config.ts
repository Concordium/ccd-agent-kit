import { z } from 'zod';
import {
  getDefaultNetwork,
  loadChainClientConfig,
  resolveNetwork,
  type AccountCredentialsStartupRefreshConfig,
  type NetworkConfig,
  type ResolvedNetwork,
} from '@ccd-agent-kit/config-utils';

export type Network = string;

export const TRANSPORTS = ['stdio', 'http'] as const;
export type Transport = (typeof TRANSPORTS)[number];
export const DEFAULT_NETWORK_SOURCES = ['session', 'config'] as const;
export type DefaultNetworkSource = (typeof DEFAULT_NETWORK_SOURCES)[number];

export const grpcConfigSchema = z.object({
  endpoint: z.string().describe('gRPC v2 node endpoint as host[:port].'),
  tls: z.boolean().describe('Use TLS when connecting to the node.'),
  timeoutMs: z.number().int().positive().describe('gRPC request timeout in milliseconds.'),
});

export const httpConfigSchema = z.object({
  port: z.number().int().positive().describe('HTTP transport port.'),
  path: z.string().startsWith('/').describe('HTTP transport base path.'),
});
export type HttpConfig = z.infer<typeof httpConfigSchema>;

export const accountCredentialsStartupRefreshConfigSchema = z.object({
  enabled: z.boolean(),
  maxAgeMs: z.number().int().positive(),
  failureRetryMs: z.number().int().positive(),
  concurrency: z.number().int().positive(),
});
export type AccountCredentialsStartupRefreshRuntimeConfig = z.infer<
  typeof accountCredentialsStartupRefreshConfigSchema
>;

export const serverConfigSchema = z.object({
  network: z.string().min(1),
  defaultNetworkSource: z.enum(DEFAULT_NETWORK_SOURCES),
  grpc: grpcConfigSchema,
  transport: z.enum(TRANSPORTS),
  http: httpConfigSchema.optional(),
  accountCredentials: z.object({ startupRefresh: accountCredentialsStartupRefreshConfigSchema }),
});
/** Runtime server configuration with the immutable startup network identity captured during parsing. */
export type ServerConfig = z.infer<typeof serverConfigSchema> & { resolvedNetwork: ResolvedNetwork };

/** Shape of the environment source consumed by `parseConfig`. */
export type ConfigSource = Record<string, string | undefined>;

export type ParseConfigResult = { ok: true; value: ServerConfig } | { ok: false; errors: string[] };

/**
 * Parses and validates a `ConfigSource` into a `ServerConfig`.
 * Never throws; invalid input yields `{ ok: false, errors }`.
 */
export function parseConfig(source: ConfigSource): ParseConfigResult {
  const errors: string[] = [];

  const defaultNetwork = getDefaultNetwork();
  const defaultNetworkSource: DefaultNetworkSource = source.CCD_NETWORK !== undefined ? 'session' : 'config';
  const requestedNetwork = source.CCD_NETWORK ?? defaultNetwork.name;
  let network = requestedNetwork;
  let resolvedNetwork: NetworkConfig | undefined = defaultNetwork.config;
  try {
    const resolved = resolveNetwork(requestedNetwork);
    network = resolved.name;
    resolvedNetwork = resolved.config;
  } catch {
    resolvedNetwork = undefined;
  }

  let endpoint: string;
  if (source.CCD_GRPC_ENDPOINT !== undefined) {
    endpoint = source.CCD_GRPC_ENDPOINT;
  } else if (resolvedNetwork !== undefined) {
    endpoint = `${resolvedNetwork.grpc.host}:${resolvedNetwork.grpc.port}`;
  } else {
    endpoint = '';
    errors.push(`Network '${requestedNetwork}' not found.`);
  }

  let tls = resolvedNetwork?.grpc.ssl ?? true;
  if (source.CCD_GRPC_TLS !== undefined) {
    if (source.CCD_GRPC_TLS === 'true') tls = true;
    else if (source.CCD_GRPC_TLS === 'false') tls = false;
    else errors.push('CCD_GRPC_TLS must be "true" or "false".');
  }

  let timeoutMs = 15000;
  if (source.CCD_GRPC_TIMEOUT_MS !== undefined) {
    const parsed = Number(source.CCD_GRPC_TIMEOUT_MS);
    if (Number.isSafeInteger(parsed) && parsed > 0) timeoutMs = parsed;
    else errors.push('CCD_GRPC_TIMEOUT_MS: expected a positive integer for timeoutMs.');
  }

  let transport: Transport = 'stdio';
  if (source.MCP_TRANSPORT !== undefined) {
    if (TRANSPORTS.includes(source.MCP_TRANSPORT as Transport)) {
      transport = source.MCP_TRANSPORT as Transport;
    } else {
      errors.push(`Unknown transport "${source.MCP_TRANSPORT}". Expected one of: ${TRANSPORTS.join(', ')}.`);
    }
  }

  let http: HttpConfig | undefined;
  if (transport === 'http') {
    const portRaw = source.MCP_HTTP_PORT ?? '3000';
    const port = Number(portRaw);
    if (!(Number.isSafeInteger(port) && port > 0 && port <= 65535)) {
      errors.push(`MCP_HTTP_PORT: expected a valid TCP port for http, got "${portRaw}".`);
    } else {
      http = { port, path: source.MCP_HTTP_PATH ?? '/mcp' };
    }
  }

  const persistedMcpConfig = loadChainClientConfig();
  const startupRefresh = parseStartupRefreshConfig(source, persistedMcpConfig.accountCredentials.startupRefresh, errors);

  if (errors.length > 0) return { ok: false, errors };

  const value = {
    network: network as Network,
    defaultNetworkSource,
    grpc: { endpoint, tls, timeoutMs },
    transport,
    ...(http !== undefined && { http }),
    accountCredentials: { startupRefresh },
  };
  Object.defineProperty(value, 'resolvedNetwork', {
    value: { name: network, config: resolvedNetwork! },
    enumerable: false,
  });
  return { ok: true, value: value as ServerConfig };
}

function parseStartupRefreshConfig(
  source: ConfigSource,
  persisted: AccountCredentialsStartupRefreshConfig,
  errors: string[],
): AccountCredentialsStartupRefreshRuntimeConfig {
  let enabled = persisted.enabled;
  if (source.CCD_ACCOUNT_CREDENTIALS_STARTUP_REFRESH !== undefined) {
    if (source.CCD_ACCOUNT_CREDENTIALS_STARTUP_REFRESH === 'true') enabled = true;
    else if (source.CCD_ACCOUNT_CREDENTIALS_STARTUP_REFRESH === 'false') enabled = false;
    else errors.push('CCD_ACCOUNT_CREDENTIALS_STARTUP_REFRESH must be "true" or "false".');
  }

  const maxAge = source.CCD_ACCOUNT_CREDENTIALS_STARTUP_REFRESH_MAX_AGE ?? persisted.maxAge;
  const failureRetry = source.CCD_ACCOUNT_CREDENTIALS_STARTUP_REFRESH_FAILURE_RETRY ?? persisted.failureRetry;
  const maxAgeMs = parseDurationMs(maxAge);
  const failureRetryMs = parseDurationMs(failureRetry);
  if (maxAgeMs === undefined) {
    errors.push('CCD_ACCOUNT_CREDENTIALS_STARTUP_REFRESH_MAX_AGE: expected duration like 5m, 24h, or 7d.');
  }
  if (failureRetryMs === undefined) {
    errors.push('CCD_ACCOUNT_CREDENTIALS_STARTUP_REFRESH_FAILURE_RETRY: expected duration like 5m, 24h, or 7d.');
  }

  let concurrency = persisted.concurrency;
  if (source.CCD_ACCOUNT_CREDENTIALS_STARTUP_REFRESH_CONCURRENCY !== undefined) {
    const parsed = Number(source.CCD_ACCOUNT_CREDENTIALS_STARTUP_REFRESH_CONCURRENCY);
    if (Number.isSafeInteger(parsed) && parsed > 0) concurrency = parsed;
    else errors.push('CCD_ACCOUNT_CREDENTIALS_STARTUP_REFRESH_CONCURRENCY: expected a positive integer.');
  }

  return { enabled, maxAgeMs: maxAgeMs ?? 1, failureRetryMs: failureRetryMs ?? 1, concurrency };
}

function parseDurationMs(value: string): number | undefined {
  const match = /^(\d+)([smhd])$/.exec(value);
  if (match === null) return undefined;
  const amount = Number(match[1]);
  if (!Number.isSafeInteger(amount) || amount <= 0) return undefined;
  const multipliers = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;
  return amount * multipliers[match[2] as keyof typeof multipliers];
}
