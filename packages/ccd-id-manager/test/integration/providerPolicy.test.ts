import { beforeEach,describe,expect,it,vi } from 'vitest';
import { IdentityProviderError } from '../../src/core/providers/error.js';
import type { IdentitySourceService } from '../../src/core/sources/types.js';
import type { IdentityWorkflow } from '../../src/core/workflowTypes.js';
import { buildIdentityMcpServer } from '../../src/mcp/server.js';
import { identityProviderServiceFixture,TEST_CANONICAL_NETWORK } from '../helpers.js';
import { identityWorkflowFixture,rpc,withMcpTestClient } from '../mcpTestHelpers.js';

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
  it('resolves an enabled MCP provider before source or workflow side effects', async () => {
    const providers = identityProviderServiceFixture({
      resolve: vi.fn(async () => { throw Object.assign(new IdentityProviderError('PROVIDER_DISABLED'), { detail: 'disabled private endpoint' }); }),
    });
    const sources = { resolve: vi.fn(), list: vi.fn(), records: vi.fn() } as unknown as IdentitySourceService;
    const identityWorkflow = workflow();
    const server = buildIdentityMcpServer(identityWorkflow, sources, providers);
    await withMcpTestClient(server, async client => {
      const response = await rpc(client, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: {
        name: 'request_identity', arguments: { network: 'testnet', source: 'PrimaryKey', identityProvider: 'Primary', identityIndex: 7 },
      } });
      expect(providers.resolve).toHaveBeenCalledExactlyOnceWith({
        network: TEST_CANONICAL_NETWORK, selector: 'Primary', requireEnabled: true,
      });
      expect(sources.resolve).not.toHaveBeenCalled();
      expect(identityWorkflow.request).not.toHaveBeenCalled();
      expect(JSON.stringify(response)).not.toContain('private endpoint');
    });
  });

  it('passes an explicit numeric selector when MCP request uses the configured network default', async () => {
    const providers = identityProviderServiceFixture();
    const sources = {
      resolve: vi.fn(),
      list: vi.fn(),
      records: vi.fn(),
    } as unknown as IdentitySourceService;
    const identityWorkflow = workflow();
    vi.mocked(identityWorkflow.request).mockResolvedValue({ ok: true } as never);
    const server = buildIdentityMcpServer(identityWorkflow, sources, providers);
    await withMcpTestClient(server, async client => {
      await rpc(client, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: {
        name: 'request_identity', arguments: { source: 'PrimaryKey', identityProvider: 4, identityIndex: 7 },
      } });
      expect(providers.resolve).toHaveBeenCalledWith({
        network: TEST_CANONICAL_NETWORK, selector: 4, requireEnabled: true,
      });
    });
  });
});
