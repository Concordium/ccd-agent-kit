import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { IdentitySourceService } from '../../src/core/sources/types.js';
import { buildIdentityMcpServer } from '../../src/mcp/server.js';
import { identityProviderServiceFixture, TEST_CANONICAL_NETWORK } from '../helpers.js';
import {
  connectMcpTestClient,
  identityWorkflowFixture,
  mcpResourcePayload,
  mcpResult,
  rpc,
} from '../mcpTestHelpers.js';

const OTHER_NETWORK = { caip2: `ccd:${'34'.repeat(16)}`, genesisHash: '34'.repeat(32) };
const mocks = vi.hoisted(() => ({
  resolveNetwork: vi.fn(),
  listSortedNetworks: vi.fn(() => ['alpha', 'zeta']),
  loadNetworks: vi.fn(),
  adapter: { list: vi.fn(), resolveDefault: vi.fn(), resolve: vi.fn() },
}));
vi.mock('@ccd-agent-kit/config-utils', async importOriginal => ({
  ...await importOriginal<typeof import('@ccd-agent-kit/config-utils')>(),
  listSortedNetworks: mocks.listSortedNetworks,
  loadNetworks: mocks.loadNetworks,
  createNetworkResourceAdapter: vi.fn(() => mocks.adapter),
}));
vi.mock('../../src/core/providers/serviceFactory.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/core/providers/serviceFactory.js')>(),
  resolveProviderNetwork: mocks.resolveNetwork,
}));

const ID = '35'.repeat(32);

function sources(): IdentitySourceService {
  return {
    resolve: vi.fn(), list: vi.fn(async () => []), records: vi.fn(async () => []),
    inspect: vi.fn(), createAgreement: vi.fn(), refresh: vi.fn(async () => undefined),
  };
}

describe('identity MCP resource protocol', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveNetwork.mockImplementation(selector => selector === 'zeta' ? OTHER_NETWORK : TEST_CANONICAL_NETWORK);
    mocks.listSortedNetworks.mockReturnValue(['alpha', 'zeta']);
    mocks.loadNetworks.mockReturnValue({
      default: 'alpha',
      networks: {
        zeta: { caip2: OTHER_NETWORK.caip2 },
        alpha: { caip2: TEST_CANONICAL_NETWORK.caip2 },
      },
    });
    const alpha = { name: 'alpha', caip2: TEST_CANONICAL_NETWORK.caip2, value: TEST_CANONICAL_NETWORK };
    const zeta = { name: 'zeta', caip2: OTHER_NETWORK.caip2, value: OTHER_NETWORK };
    mocks.adapter.list.mockReturnValue([alpha, zeta]);
    mocks.adapter.resolveDefault.mockReturnValue(alpha);
    mocks.adapter.resolve.mockImplementation(selector => selector === 'zeta' ? zeta : alpha);
  });

  it('advertises and reads identity resources through MCP dispatch', async () => {
    const summary = {
      identityId: ID, network: TEST_CANONICAL_NETWORK.caip2, identityProviderIndex: 4,
      identityIndex: 7, status: 'pending' as const, label: 'Agent-Label',
    };
    const workflow = identityWorkflowFixture({ list: vi.fn(async () => [summary]) });
    const server = buildIdentityMcpServer(workflow, sources(), identityProviderServiceFixture());
    const client = await connectMcpTestClient(server);
    try {
      const listed = mcpResult(await rpc(client, {
        jsonrpc: '2.0', id: 2, method: 'resources/templates/list', params: {},
      }));
      expect(listed.resourceTemplates).toEqual(expect.arrayContaining([
        expect.objectContaining({ uriTemplate: 'ccd://{network}/identities' }),
      ]));

      const resources = mcpResult(await rpc(client, {
        jsonrpc: '2.0', id: 5, method: 'resources/list', params: {},
      }));
      expect(resources.resources).toEqual(expect.arrayContaining([
        expect.objectContaining({ uri: 'ccd://identities' }),
      ]));

      const read = mcpResult(await rpc(client, {
        jsonrpc: '2.0', id: 3, method: 'resources/read', params: { uri: 'ccd://identities' },
      }));
      const content = read.contents;
      expect(content).toEqual([expect.objectContaining({ mimeType: 'application/json' })]);
      expect(mcpResourcePayload(read)).toEqual({
        network: 'alpha', caip2: TEST_CANONICAL_NETWORK.caip2, result: { identities: [summary] },
      });
      expect(workflow.list).toHaveBeenCalledExactlyOnceWith({ network: TEST_CANONICAL_NETWORK.caip2 });
    } finally { await server.close(); }
  });

  it('does not expose the removed list-identities tool', async () => {
    const server = buildIdentityMcpServer(identityWorkflowFixture(), sources(), identityProviderServiceFixture());
    const client = await connectMcpTestClient(server);
    try {
      const response = await rpc(client, {
        jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_identities', arguments: {} },
      });
      expect(response).toHaveProperty('error');
    } finally { await server.close(); }
  });

});
