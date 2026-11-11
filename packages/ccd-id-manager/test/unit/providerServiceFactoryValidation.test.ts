import { beforeEach,describe,expect,it,vi } from 'vitest';
import { resolveProviderNetwork } from '../../src/core/providers/serviceFactory.js';

const mocks = vi.hoisted(() => ({ resolveNetwork: vi.fn() }));
vi.mock('@ccd-agent-kit/config-utils', async importOriginal => ({
  ...await importOriginal<typeof import('@ccd-agent-kit/config-utils')>(),
  resolveNetwork: mocks.resolveNetwork,
}));

describe('provider service-factory network validation', () => {
  beforeEach(() => mocks.resolveNetwork.mockReset());

  it('projects the config-owned canonical network fields', () => {
    const config = {
      genesisHash: '12'.repeat(32), caip2: `ccd:${'12'.repeat(16)}`,
      grpc: { host: 'node.example', port: 20_000, ssl: true },
    };
    mocks.resolveNetwork.mockReturnValue({ name: 'configured', config });
    expect(resolveProviderNetwork('configured')).toEqual({ caip2: config.caip2, genesisHash: config.genesisHash });
    expect(mocks.resolveNetwork).toHaveBeenCalledExactlyOnceWith('configured');
  });

  it('sanitizes a config resolution failure', () => {
    mocks.resolveNetwork.mockReturnValue(undefined);
    let failure: unknown;
    try { resolveProviderNetwork('missing'); } catch (error) { failure = error; }
    expect(failure).toMatchObject({ code: 'INVALID_NETWORK' });
    expect(String(failure)).not.toContain('/private');
  });
});
