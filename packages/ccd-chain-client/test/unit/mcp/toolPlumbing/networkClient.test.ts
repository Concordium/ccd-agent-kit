import type { ResolvedNetwork } from '@ccd-agent-kit/config-utils';
import { describe, expect, it, vi } from 'vitest';

import type { ServerConfig } from '../../../../src/config.js';
import { createCachingNetworkClientProvider } from '../../../../src/mcp/toolPlumbing/networkClient.js';
import { snapshotNetworkConfig } from '../../../helpers/networkSnapshot.js';

const mocks = vi.hoisted(() => ({
  endpoints: [] as Array<{ host: string; port: number; tls: boolean }>,
  selected: undefined as ResolvedNetwork | undefined,
}));

vi.mock('@ccd-agent-kit/config-utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ccd-agent-kit/config-utils')>()),
  resolveNetwork: vi.fn(() => mocks.selected!),
}));
vi.mock('../../../../src/concordium/client.js', () => ({
  ConcordiumNodeQueries: class {
    constructor(readonly grpc: unknown) {}
  },
  createConcordiumClient: vi.fn((endpoint: { host: string; port: number; tls: boolean }) => {
    mocks.endpoints.push(endpoint);
    return { endpoint };
  }),
}));

function resolved(name: string, digit: string, host: string): ResolvedNetwork {
  return { name, config: snapshotNetworkConfig(digit, host) };
}

function serverConfig(startup: ResolvedNetwork): ServerConfig {
  return {
    network: startup.name,
    defaultNetworkSource: 'session',
    resolvedNetwork: startup,
    grpc: { endpoint: 'startup.example:21000', tls: true, timeoutMs: 10_000 },
    transport: 'stdio',
    accountCredentials: {
      startupRefresh: { enabled: false, maxAgeMs: 60_000, failureRetryMs: 1_000, concurrency: 1 },
    },
  };
}

describe('network client snapshot acquisition', () => {
  it('keeps caller snapshots stable while resolving current names and caching each endpoint', () => {
    const captured = resolved('localnet', 'a', 'old.example');
    const replacement = resolved('localnet', 'b', 'new.example');
    mocks.selected = replacement;
    mocks.endpoints.length = 0;
    const provider = createCachingNetworkClientProvider(serverConfig(captured));
    expect(mocks.endpoints).toHaveLength(0);

    const replacementClient = provider.getClient('localnet');
    expect(mocks.endpoints).toHaveLength(1);
    expect(provider.getClient('localnet').client).toBe(replacementClient.client);
    expect(mocks.endpoints).toHaveLength(1);
    const capturedClient = provider.getClient(captured);

    expect(mocks.endpoints).toEqual([
      { host: 'new.example', port: 20000, tls: false },
      { host: 'startup.example', port: 21000, tls: true },
    ]);
    expect(replacementClient.client).not.toBe(capturedClient.client);
    expect(provider.getClient(captured).client).toBe(capturedClient.client);
    expect(mocks.endpoints).toHaveLength(2);
  });
});
