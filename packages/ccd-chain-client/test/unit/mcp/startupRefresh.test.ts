import type { AccountCredentialObservation } from '@ccd-agent-kit/config-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerConfig } from '../../../src/config.js';
import {
  refreshCachedAccountCredentialsOnStartup,
  startStartupRefresh,
} from '../../../src/mcp/startupRefresh.js';
import { createStaticNetworkClientProvider, FakeConcordiumClient } from '../../helpers/fakes.js';
import { SENDER, accountObservation, keyPair } from '../../mcp/transactions/internal/helpers.js';

const configStore = vi.hoisted(() => ({
  observations: {} as Record<string, AccountCredentialObservation>,
  loadNetworks: vi.fn(() => ({
    networks: { mainnet: { caip2: 'ccd:9dd9ca4d19e9393877d2c44b70f89acb' } },
  })),
  set: vi.fn(),
  setError: vi.fn(),
}));

vi.mock('@ccd-agent-kit/config-utils', () => ({
  loadAccountCredentials: () => configStore.observations,
  loadNetworks: configStore.loadNetworks,
  setAccountCredentialObservation: configStore.set,
  setAccountCredentialRefreshError: configStore.setError,
}));

function serverConfig(enabled = true): ServerConfig {
  return {
    network: 'mainnet',
    resolvedNetwork: {
      name: 'mainnet',
      config: {
        caip2: 'ccd:9dd9ca4d19e9393877d2c44b70f89acb',
        genesisHash: '9dd9ca4d19e9393877d2c44b70f89acbfc0883c2243e5eeaecc0d1cd0503f478',
        grpc: { host: 'localhost', port: 20000, ssl: false },
      },
    },
    defaultNetworkSource: 'config',
    grpc: { endpoint: 'localhost:20000', tls: false, timeoutMs: 15_000 },
    transport: 'stdio',
    accountCredentials: {
      startupRefresh: { enabled, maxAgeMs: 86_400_000, failureRetryMs: 300_000, concurrency: 2 },
    },
  };
}

describe('startup credential refresh decisions', () => {
  beforeEach(() => {
    configStore.observations = {};
    vi.clearAllMocks();
    configStore.loadNetworks.mockReturnValue({
      networks: { mainnet: { caip2: 'ccd:9dd9ca4d19e9393877d2c44b70f89acb' } },
    });
  });

  it('does no work when disabled', async () => {
    const client = new FakeConcordiumClient();
    await expect(
      refreshCachedAccountCredentialsOnStartup(
        serverConfig(false),
        createStaticNetworkClientProvider(client, 'mainnet'),
      ),
    ).resolves.toEqual({ refreshed: 0, skipped: 0, failed: 0 });
    expect(client.calls.getFinalizedAccountCredentials ?? 0).toBe(0);
  });

  it('skips fresh observations and recent failures', async () => {
    const keys = await keyPair('5');
    const fresh = accountObservation(keys.verifyKey);
    fresh.sourceBlock.time = new Date().toISOString();
    const failed = structuredClone(fresh);
    failed.sourceBlock.time = '2020-01-01T00:00:00.000Z';
    failed.refreshError = { attempted: new Date().toISOString(), kind: 'node', message: 'unavailable' };
    configStore.observations = { [SENDER]: fresh, other: failed };

    await expect(
      refreshCachedAccountCredentialsOnStartup(
        serverConfig(),
        createStaticNetworkClientProvider(new FakeConcordiumClient(), 'mainnet'),
      ),
    ).resolves.toEqual({ refreshed: 0, skipped: 2, failed: 0 });
  });

  it('stores typed query results and sanitized failures', async () => {
    const keys = await keyPair('6');
    const stale = accountObservation(keys.verifyKey);
    stale.sourceBlock.time = '2020-01-01T00:00:00.000Z';
    configStore.observations = { [SENDER]: stale, missing: stale };
    const client = new FakeConcordiumClient({
      accountCredentialObservations: { [SENDER]: { canonicalAddress: SENDER, observation: stale } },
    });

    await expect(
      refreshCachedAccountCredentialsOnStartup(serverConfig(), createStaticNetworkClientProvider(client, 'mainnet')),
    ).resolves.toEqual({ refreshed: 1, skipped: 0, failed: 1 });
    expect(configStore.set).toHaveBeenCalledWith(SENDER, stale, '9dd9ca4d19e9393877d2c44b70f89acb');
    expect(configStore.setError).toHaveBeenCalledWith(
      'missing',
      expect.objectContaining({ kind: 'not_found', message: 'Account was not found.' }),
      '9dd9ca4d19e9393877d2c44b70f89acb',
    );
  });

  it('does not persist private dependency failure details', async () => {
    const keys = await keyPair('9');
    const stale = accountObservation(keys.verifyKey);
    stale.sourceBlock.time = '2020-01-01T00:00:00.000Z';
    configStore.observations = { [SENDER]: stale };
    const client = new FakeConcordiumClient();
    vi.spyOn(client, 'getFinalizedAccountCredentials').mockRejectedValue({
      kind: 'node',
      message: 'PRIVATE_PERSISTED_SENTINEL',
    });

    await expect(
      refreshCachedAccountCredentialsOnStartup(serverConfig(), createStaticNetworkClientProvider(client, 'mainnet')),
    ).resolves.toEqual({ refreshed: 0, skipped: 0, failed: 1 });
    const persisted = configStore.setError.mock.calls[0]?.[1];
    expect(persisted).toMatchObject({ kind: 'node', message: 'Account credential refresh failed at the node.' });
    expect(Date.parse(persisted?.attempted ?? '')).not.toBeNaN();
    expect(JSON.stringify(persisted)).not.toContain('PRIVATE_PERSISTED_SENTINEL');
  });

  it('rejects incomplete refreshes without replacing cached state', async () => {
    const keys = await keyPair('8');
    const stale = accountObservation(keys.verifyKey);
    stale.sourceBlock.time = '2020-01-01T00:00:00.000Z';
    const incomplete = structuredClone(stale);
    delete incomplete.credentials['0']!.threshold;
    configStore.observations = { [SENDER]: stale };
    const client = new FakeConcordiumClient({
      accountCredentialObservations: { [SENDER]: { canonicalAddress: SENDER, observation: incomplete } },
    });

    await expect(
      refreshCachedAccountCredentialsOnStartup(serverConfig(), createStaticNetworkClientProvider(client, 'mainnet')),
    ).resolves.toEqual({ refreshed: 0, skipped: 0, failed: 1 });
    expect(configStore.set).not.toHaveBeenCalled();
    expect(configStore.setError).toHaveBeenCalledWith(
      SENDER,
      expect.objectContaining({ kind: 'node', message: 'Account credential refresh failed at the node.' }),
      '9dd9ca4d19e9393877d2c44b70f89acb',
    );
  });

  it('does not write private top-level failure details to stderr', async () => {
    configStore.loadNetworks.mockImplementationOnce(() => {
      throw new Error('PRIVATE_TOP_LEVEL_SENTINEL');
    });
    const stderr = vi.fn();

    startStartupRefresh({
      config: serverConfig(),
      clients: createStaticNetworkClientProvider(new FakeConcordiumClient(), 'mainnet'),
      stderr,
    });

    await vi.waitFor(() => {
      expect(stderr).toHaveBeenCalledWith('ccd-chain-client-mcp: account credential startup refresh failed.');
    });
    expect(stderr.mock.calls.flat().join('\n')).not.toContain('PRIVATE_TOP_LEVEL_SENTINEL');
  });

  it('reports a non-empty startup refresh summary', async () => {
    const keys = await keyPair('4');
    const stale = accountObservation(keys.verifyKey);
    stale.sourceBlock.time = '2020-01-01T00:00:00.000Z';
    configStore.observations = { [SENDER]: stale };
    const client = new FakeConcordiumClient({
      accountCredentialObservations: { [SENDER]: { canonicalAddress: SENDER, observation: stale } },
    });
    const stderr = vi.fn();

    startStartupRefresh({
      config: serverConfig(),
      clients: createStaticNetworkClientProvider(client, 'mainnet'),
      stderr,
    });

    await vi.waitFor(() => {
      expect(stderr).toHaveBeenCalledWith(
        'ccd-chain-client-mcp: account credential startup refresh: refreshed=1 skipped=0 failed=0',
      );
    });
  });

  it.each([
    ['invalid source block time', 'not-a-time', undefined],
    ['future source block time', '2999-01-01T00:00:00.000Z', undefined],
    ['invalid failure time', '2020-01-01T00:00:00.000Z', 'not-a-time'],
    ['future failure time', '2020-01-01T00:00:00.000Z', '2999-01-01T00:00:00.000Z'],
  ])('refreshes observations with %s', async (_label, sourceBlockTime, attempted) => {
    const keys = await keyPair('7');
    const stale = accountObservation(keys.verifyKey);
    stale.sourceBlock.time = sourceBlockTime;
    if (attempted !== undefined) stale.refreshError = { attempted, kind: 'node', message: 'unavailable' };
    configStore.observations = { [SENDER]: stale };
    const client = new FakeConcordiumClient({
      accountCredentialObservations: { [SENDER]: { canonicalAddress: SENDER, observation: stale } },
    });

    await expect(
      refreshCachedAccountCredentialsOnStartup(serverConfig(), createStaticNetworkClientProvider(client, 'mainnet')),
    ).resolves.toEqual({ refreshed: 1, skipped: 0, failed: 0 });
    expect(client.calls.getFinalizedAccountCredentials).toBe(1);
  });
});
