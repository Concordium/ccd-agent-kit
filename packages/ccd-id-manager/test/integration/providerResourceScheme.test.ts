import { describe,expect,it,vi } from 'vitest';
import type { IdentitySourceService } from '../../src/core/sources/types.js';
import type { IdentityWorkflow } from '../../src/core/workflowTypes.js';
import { buildIdentityMcpServer } from '../../src/mcp/server.js';
import { identityProviderServiceFixture,TEST_CANONICAL_NETWORK } from '../helpers.js';
import { rpc,withMcpTestClient } from '../mcpTestHelpers.js';

vi.mock('../../src/core/providers/serviceFactory.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/core/providers/serviceFactory.js')>(),
  resolveProviderNetwork: vi.fn(() => TEST_CANONICAL_NETWORK),
}));

describe('identity-provider resource scheme', () => {
  it.each(['https://testnet/identity-providers', 'file://identity-providers/'])(
    'rejects the unregistered URI %s without reading provider state',
    async (uri) => {
      const providers = identityProviderServiceFixture();
      const workflow = {} as IdentityWorkflow;
      const sources = {} as IdentitySourceService;
      const server = buildIdentityMcpServer(workflow, sources, providers);
      await withMcpTestClient(server, async client => {
        const response = await rpc(client, { jsonrpc: '2.0', id: 2, method: 'resources/read', params: { uri } });
        expect('error' in response).toBe(true);
        expect(providers.inventory).not.toHaveBeenCalled();
      });
    },
  );
});
