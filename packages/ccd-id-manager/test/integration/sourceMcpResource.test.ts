import { describe, expect, it, vi } from 'vitest';

import type { IdentitySourceService } from '../../src/core/sources/types.js';
import { buildIdentityMcpServer } from '../../src/mcp/server.js';
import { identityProviderServiceFixture } from '../helpers.js';
import { identityWorkflowFixture, mcpResult, rpc, withMcpTestClient } from '../mcpTestHelpers.js';

const SOURCE_ID = 'ir:2abcdefghijklmn';

function sources(): IdentitySourceService {
  return {
    list: vi.fn(async () => [{ id: SOURCE_ID, label: 'Primary', availability: 'locked' as const, isDefault: true }]),
    resolve: vi.fn(), records: vi.fn(async () => []), inspect: vi.fn(), createAgreement: vi.fn(),
    refresh: vi.fn(async () => undefined),
  };
}

describe('identity-source MCP resource protocol', () => {
  it('advertises and reads the global resource through MCP dispatch', async () => {
    const sourceService = sources();
    const server = buildIdentityMcpServer(identityWorkflowFixture(), sourceService, identityProviderServiceFixture());
    await withMcpTestClient(server, async client => {
      const listed = mcpResult(await rpc(client, { jsonrpc: '2.0', id: 2, method: 'resources/list', params: {} }));
      expect(listed.resources).toEqual(expect.arrayContaining([
        expect.objectContaining({ uri: 'ccd://identity-sources', mimeType: 'application/json' }),
      ]));

      const read = mcpResult(await rpc(client, {
        jsonrpc: '2.0', id: 3, method: 'resources/read', params: { uri: 'ccd://identity-sources' },
      }));
      expect(JSON.stringify(read.contents)).toContain(SOURCE_ID);
      expect(sourceService.list).toHaveBeenCalledOnce();
    });
  });
});
