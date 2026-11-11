import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { httpConfigSchema, parseConfig } from '../../src/config.js';
import { makeTestTempDir } from '../helpers/tempDir.js';

describe('parseConfig', () => {
  const previousConfigHome = process.env.XDG_CONFIG_HOME;

  beforeEach(() => {
    const dir = makeTestTempDir('ccd-config-test-');
    process.env.XDG_CONFIG_HOME = dir;
  });

  afterEach(() => {
    if (previousConfigHome === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = previousConfigHome;
    }
  });

  it('applies defaults for an empty environment', () => {
    const result = parseConfig({});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({
      network: 'mainnet',
      defaultNetworkSource: 'config',
      grpc: { endpoint: 'grpc.mainnet.concordium.software:20000', tls: true, timeoutMs: 15000 },
      transport: 'stdio',
      accountCredentials: { startupRefresh: { enabled: true, maxAgeMs: 86_400_000, failureRetryMs: 300_000, concurrency: 3 } },
    });
  });

  it('parses account credential startup refresh runtime overrides', () => {
    const result = parseConfig({
      CCD_ACCOUNT_CREDENTIALS_STARTUP_REFRESH: 'false',
      CCD_ACCOUNT_CREDENTIALS_STARTUP_REFRESH_MAX_AGE: '7d',
      CCD_ACCOUNT_CREDENTIALS_STARTUP_REFRESH_FAILURE_RETRY: '10m',
      CCD_ACCOUNT_CREDENTIALS_STARTUP_REFRESH_CONCURRENCY: '5',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.accountCredentials.startupRefresh).toEqual({
      enabled: false,
      maxAgeMs: 604_800_000,
      failureRetryMs: 600_000,
      concurrency: 5,
    });
  });

  it('rejects invalid startup refresh runtime overrides', () => {
    const result = parseConfig({
      CCD_ACCOUNT_CREDENTIALS_STARTUP_REFRESH: 'sometimes',
      CCD_ACCOUNT_CREDENTIALS_STARTUP_REFRESH_MAX_AGE: 'soon',
      CCD_ACCOUNT_CREDENTIALS_STARTUP_REFRESH_FAILURE_RETRY: 'later',
      CCD_ACCOUNT_CREDENTIALS_STARTUP_REFRESH_CONCURRENCY: '0',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join('\n')).toContain('STARTUP_REFRESH must be');
    expect(result.errors.join('\n')).toContain('MAX_AGE');
    expect(result.errors.join('\n')).toContain('FAILURE_RETRY');
    expect(result.errors.join('\n')).toContain('CONCURRENCY');
  });

  it('selects the testnet default endpoint', () => {
    const result = parseConfig({ CCD_NETWORK: 'testnet' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.network).toBe('testnet');
    expect(result.value.defaultNetworkSource).toBe('session');
    expect(result.value.grpc.endpoint).toBe('grpc.testnet.concordium.software:20000');
  });

  it('selects networks by full CAIP-2 identifier', () => {
    const result = parseConfig({ CCD_NETWORK: 'ccd:4221332d34e1694168c2a0c0b3fd0f27' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.network).toBe('testnet');
    expect(result.value.defaultNetworkSource).toBe('session');
    expect(result.value.grpc.endpoint).toBe('grpc.testnet.concordium.software:20000');
  });

  it('honours an explicit endpoint override', () => {
    const result = parseConfig({ CCD_GRPC_ENDPOINT: '127.0.0.1:20001' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.grpc.endpoint).toBe('127.0.0.1:20001');
  });

  it('parses tls=false from the environment', () => {
    const result = parseConfig({ CCD_GRPC_TLS: 'false' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.grpc.tls).toBe(false);
  });

  it('parses tls=true from the environment', () => {
    const result = parseConfig({ CCD_GRPC_TLS: 'true' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.grpc.tls).toBe(true);
  });

  it('rejects invalid TLS values', () => {
    const result = parseConfig({ CCD_GRPC_TLS: 'sometimes' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContain('CCD_GRPC_TLS must be "true" or "false".');
  });

  it('parses a numeric timeout', () => {
    const result = parseConfig({ CCD_GRPC_TIMEOUT_MS: '25000' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.grpc.timeoutMs).toBe(25000);
  });

  it('rejects a non-numeric timeout', () => {
    const result = parseConfig({ CCD_GRPC_TIMEOUT_MS: 'soon' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => e.includes('timeoutMs'))).toBe(true);
  });

  it('rejects an unknown network', () => {
    const result = parseConfig({ CCD_NETWORK: 'moonnet' });
    expect(result.ok).toBe(false);
  });

  it('configures the HTTP transport from env', () => {
    const result = parseConfig({
      MCP_TRANSPORT: 'http',
      MCP_HTTP_PORT: '8080',
      MCP_HTTP_PATH: '/concordium',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.transport).toBe('http');
    expect(result.value.http).toEqual({ port: 8080, path: '/concordium' });
  });

  it('uses HTTP defaults when only the HTTP transport is selected', () => {
    const result = parseConfig({ MCP_TRANSPORT: 'http' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.http).toEqual({ port: 3000, path: '/mcp' });
  });

  it('validates HTTP paths on the exported runtime schema', () => {
    expect(httpConfigSchema.safeParse({ port: 3000, path: 'concordium' }).success).toBe(false);
  });

  it('rejects an unknown transport', () => {
    const result = parseConfig({ MCP_TRANSPORT: 'websocket' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContain('Unknown transport "websocket". Expected one of: stdio, http.');
  });

  it('rejects an invalid HTTP port', () => {
    const result = parseConfig({ MCP_TRANSPORT: 'http', MCP_HTTP_PORT: '0' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContain('MCP_HTTP_PORT: expected a valid TCP port for http, got "0".');
  });

  it('does not set http when transport is stdio', () => {
    const result = parseConfig({ MCP_TRANSPORT: 'stdio' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.http).toBeUndefined();
  });

  it('parses second and hour startup refresh durations', () => {
    const result = parseConfig({
      CCD_ACCOUNT_CREDENTIALS_STARTUP_REFRESH_MAX_AGE: '30s',
      CCD_ACCOUNT_CREDENTIALS_STARTUP_REFRESH_FAILURE_RETRY: '2h',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.accountCredentials.startupRefresh.maxAgeMs).toBe(30_000);
    expect(result.value.accountCredentials.startupRefresh.failureRetryMs).toBe(7_200_000);
  });

  it('collects multiple validation errors', () => {
    const result = parseConfig({ CCD_NETWORK: 'moonnet', CCD_GRPC_TIMEOUT_MS: 'soon' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.length).toBeGreaterThanOrEqual(2);
  });
});
