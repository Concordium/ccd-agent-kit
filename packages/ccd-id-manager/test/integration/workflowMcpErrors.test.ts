import { describe, expect, it, vi } from 'vitest';

import type { IdentitySourceService } from '../../src/core/sources/types.js';
import { IdentityWorkflowError } from '../../src/core/workflowErrors.js';
import { buildIdentityMcpServer } from '../../src/mcp/server.js';
import { identityProviderServiceFixture, TEST_CANONICAL_NETWORK } from '../helpers.js';
import { identityWorkflowFixture, mcpResult, rpc, withMcpTestClient } from '../mcpTestHelpers.js';

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

describe('identity workflow MCP error protocol', () => {
  it('returns a protocol-level tool error for a classified workflow failure', async () => {
    const workflow = identityWorkflowFixture({
      request: vi.fn(async () => { throw new IdentityWorkflowError('AUTHORIZATION_REQUIRED'); }),
    });
    const server = buildIdentityMcpServer(workflow, sources(), identityProviderServiceFixture());
    await withMcpTestClient(server, async client => {
      const response = mcpResult(await rpc(client, {
        jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: 'request_identity', arguments: { identityProvider: 4 } },
      }));
      expect(response.isError).toBe(true);
      expect(JSON.stringify(response)).toContain('authorization');
    });
  });
});
