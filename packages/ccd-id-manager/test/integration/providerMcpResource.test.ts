import { describe, expect, it, vi } from 'vitest';

import type { IdentitySourceService } from '../../src/core/sources/types.js';
import { buildIdentityMcpServer } from '../../src/mcp/server.js';
import { identityProviderServiceFixture, TEST_CANONICAL_NETWORK } from '../helpers.js';
import { identityWorkflowFixture, mcpResult, rpc, withMcpTestClient } from '../mcpTestHelpers.js';

vi.mock('@ccd-agent-kit/config-utils', async importOriginal => ({
  ...await importOriginal<typeof import('@ccd-agent-kit/config-utils')>(),
  createNetworkResourceAdapter: vi.fn(() => ({
    list: () => [],
    resolveDefault: () => ({
      name: 'testnet', caip2: TEST_CANONICAL_NETWORK.caip2, value: TEST_CANONICAL_NETWORK,
    }),
    resolve: () => ({
      name: 'testnet', caip2: TEST_CANONICAL_NETWORK.caip2, value: TEST_CANONICAL_NETWORK,
    }),
  })),
}));

vi.mock('../../src/core/providers/serviceFactory.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/core/providers/serviceFactory.js')>(),
  resolveProviderNetwork: vi.fn(() => TEST_CANONICAL_NETWORK),
}));

function sources(): IdentitySourceService {
  return {
    resolve: vi.fn(), list: vi.fn(async () => []), records: vi.fn(async () => []),
    inspect: vi.fn(), createAgreement: vi.fn(), refresh: vi.fn(async () => undefined),
  };
}

describe('identity-provider MCP resource protocol', () => {
  it('advertises and reads network-scoped provider inventory through MCP dispatch', async () => {
    const providers = identityProviderServiceFixture();
    const server = buildIdentityMcpServer(identityWorkflowFixture(), sources(), providers);
    await withMcpTestClient(server, async client => {
      const listed = mcpResult(await rpc(client, {
        jsonrpc: '2.0', id: 2, method: 'resources/templates/list', params: {},
      }));
      expect(listed.resourceTemplates).toEqual(expect.arrayContaining([
        expect.objectContaining({ uriTemplate: 'ccd://{network}/identity-providers' }),
      ]));

      const read = mcpResult(await rpc(client, {
        jsonrpc: '2.0', id: 3, method: 'resources/read',
        params: { uri: 'ccd://testnet/identity-providers' },
      }));
      expect(JSON.stringify(read.contents)).toContain('Provider Four');
      expect(providers.inventory).toHaveBeenCalledExactlyOnceWith({ network: TEST_CANONICAL_NETWORK });
    });
  });
});
