import { beforeEach,describe,expect,it,vi } from 'vitest';
import { runCli } from '../../src/cli/index.js';
import { IdentityProviderError } from '../../src/core/providers/error.js';
import { loadIdentityContext } from '../../src/core/workflowInfrastructure.js';
import type { IdentityWorkflow } from '../../src/core/workflowTypes.js';
import { identityProviderServiceFixture,TEST_CANONICAL_NETWORK } from '../helpers.js';
import { identityWorkflowFixture } from '../mcpTestHelpers.js';
import { startSelection } from '../workflowFixtures.js';

const networkMocks = vi.hoisted(() => ({ resolveProviderNetwork: vi.fn(() => ({
  caip2: `ccd:${'12'.repeat(16)}`, genesisHash: '12'.repeat(32),
})) }));
vi.mock('../../src/core/providers/serviceFactory.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/core/providers/serviceFactory.js')>(),
  resolveProviderNetwork: networkMocks.resolveProviderNetwork,
}));

function workflow(): IdentityWorkflow {
  return identityWorkflowFixture();
}

describe('identity-provider action policy', () => {
  beforeEach(() => vi.clearAllMocks());
  it('allows an explicit complete disabled provider through CLI policy and passes only trusted workflow input', async () => {
    const providers = identityProviderServiceFixture();
    const identityWorkflow = workflow();
    const stdout = vi.fn<(text: string) => void>();
    const stderr = vi.fn<(text: string) => void>();
    vi.mocked(identityWorkflow.request).mockResolvedValue({
      identityId: '35'.repeat(32), network: TEST_CANONICAL_NETWORK.caip2,
      identityProviderIndex: 4, identityIndex: 7, status: 'pending', outcome: 'requested',
    });

    await expect(runCli([
      'identity', 'request', '--network', 'testnet', '--source', 'PrimaryKey',
      '--idp', 'Primary', '--identity-index', '7',
    ], { workflow: identityWorkflow, providerService: providers, resolveProviderNetwork: networkMocks.resolveProviderNetwork, stdout, stderr }))
      .resolves.toBe(0);

    expect(providers.resolve).toHaveBeenCalledExactlyOnceWith({
      network: TEST_CANONICAL_NETWORK, selector: 'Primary', requireEnabled: false,
    });
    expect(identityWorkflow.request).toHaveBeenCalledExactlyOnceWith({
      network: TEST_CANONICAL_NETWORK.caip2, source: 'PrimaryKey', identityProviderIndex: 4, identityIndex: 7,
    });
    expect(vi.mocked(identityWorkflow.request).mock.calls[0]![0]).not.toHaveProperty('walletProxyUrl');
  });

  it('rejects disabled configuration before reading finalized node context and ignores inert historical proxy metadata', async () => {
    const providers = identityProviderServiceFixture({
      resolve: vi.fn(async () => { throw new IdentityProviderError('PROVIDER_DISABLED'); }),
    });
    const readNodeContext = vi.fn();
    const selected = startSelection();
    const historical = {
      network: selected.network, rootPublicKey: selected.rootPublicKey,
      identityProviderIndex: selected.identityProviderIndex, identityIndex: selected.identityIndex,
      ...(selected.device === undefined ? {} : { device: selected.device }),
      walletProxyUrl: 'https://attacker.example/private',
    };

    await expect(loadIdentityContext(historical, { providers, readNodeContext, requireEnabled: true }))
      .rejects.toMatchObject({ code: 'PROVIDER_DISABLED' });
    expect(providers.resolve).toHaveBeenCalledWith({
      network: TEST_CANONICAL_NETWORK, selector: historical.identityProviderIndex, requireEnabled: true,
    });
    expect(readNodeContext).not.toHaveBeenCalled();
  });
});
