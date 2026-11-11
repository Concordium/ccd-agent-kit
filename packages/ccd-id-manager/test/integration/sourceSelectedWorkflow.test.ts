import { describe,expect,it,vi } from 'vitest';
import type { IdentitySourceService } from '../../src/core/sources/types.js';
import type { IdentityWorkflow } from '../../src/core/workflowTypes.js';
import { buildIdentityMcpServer } from '../../src/mcp/server.js';
import { identityProviderServiceFixture,TEST_CANONICAL_NETWORK } from '../helpers.js';
import { identityWorkflowFixture,mcpResult as result,rpc,withMcpTestClient } from '../mcpTestHelpers.js';

vi.mock('../../src/core/providers/serviceFactory.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/core/providers/serviceFactory.js')>(),
  resolveProviderNetwork: vi.fn(() => TEST_CANONICAL_NETWORK),
}));

const SOURCE_ID = 'ir:2abcdefghijklmn';
const ID = '35'.repeat(32);
const PRIVATE_DETAIL = 'secret /Users/alice/.local/share/ccd-agent-kit/sources.json';

function workflow(): IdentityWorkflow {
  return identityWorkflowFixture({
    request: vi.fn(async () => ({ ok: true }) as never), recover: vi.fn(async () => ({ ok: true }) as never),
  });
}

function sources(overrides: Record<string, unknown> = {}): IdentitySourceService {
  return {
    resolve: vi.fn(), records: vi.fn(async () => []),
    list: vi.fn(async () => [{
      id: SOURCE_ID, label: 'PrimaryKey', backend: 'future-backend', locator: { path: PRIVATE_DETAIL },
      rootPublicKey: PRIVATE_DETAIL, rootPublicKeyFingerprint: PRIVATE_DETAIL, recipeVersion: 1,
      isDefault: true, availability: 'locked',
    }]),
    ...overrides,
  } as unknown as IdentitySourceService;
}

async function withServer(value: IdentityWorkflow, sourceService: IdentitySourceService, run: Parameters<typeof withMcpTestClient>[1]) {
  const server = buildIdentityMcpServer(value, sourceService, identityProviderServiceFixture());
  await withMcpTestClient(server, run);
}
describe('backend-neutral source-selected MCP workflows', () => {
  it.each([
    [undefined, {}],
    [SOURCE_ID, { source: SOURCE_ID }],
    ['PrimaryKey', { source: 'PrimaryKey' }],
  ])('passes source selector %s directly to the workflow without resolving it in MCP', async (source, selected) => {
    const value = workflow();
    const sourceService = sources();
    const args = { identityProvider: 4, identityIndex: 7, ...selected };
    await withServer(value, sourceService, async transport => {
      const response = result(await rpc(transport, {
        jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'recover_identity', arguments: args },
      }));
      expect(response.isError).not.toBe(true);
    });
    expect(sourceService.resolve).not.toHaveBeenCalled();
    expect(value.recover).toHaveBeenCalledExactlyOnceWith({
      network: TEST_CANONICAL_NETWORK.caip2, identityProviderIndex: 4, identityIndex: 7, ...selected,
    });
  });

  it('does not inspect backend-specific metadata while routing source selection', async () => {
    const value = workflow();
    const sourceService = sources({
      resolve: vi.fn(async () => { throw new Error(PRIVATE_DETAIL); }),
    });
    await withServer(value, sourceService, async transport => {
      const response = result(await rpc(transport, {
        jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: 'request_identity', arguments: { source: 'PrimaryKey', identityProvider: 4 } },
      }));
      expect(response.isError).not.toBe(true);
    });
    expect(sourceService.resolve).not.toHaveBeenCalled();
    expect(value.request).toHaveBeenCalledWith(expect.objectContaining({ source: 'PrimaryKey' }));
  });

  it('strictly rejects source arguments for remaining identity-bound operations', async () => {
    const value = workflow();
    await withServer(value, sources(), async transport => {
      const response = await rpc(transport, {
        jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: 'reconcile_account_opening', arguments: { identityId: ID, source: 'PrimaryKey' } },
      });
      expect(('result' in response && (response.result as { isError?: boolean }).isError) || 'error' in response).toBe(true);
    });
    expect(value.reconcileAccountOpening).not.toHaveBeenCalled();
  });

  it.each([
    '2abcdefghijklmn',
    'ir:1abcdefghijklmn',
    'ir:2ABCDEFGHIJKLMN',
    'ir:2abcdefghijklm',
    'name with spaces',
  ])(
    'rejects invalid source selector %s before provider or workflow access', async (source) => {
      const value = workflow();
      const providers = identityProviderServiceFixture();
      const server = buildIdentityMcpServer(value, sources(), providers);
      await withMcpTestClient(server, async client => {
        const response = await rpc(client, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: {
          name: 'request_identity', arguments: { source, identityProvider: 4 },
        } });
        expect(('result' in response && (response.result as { isError?: boolean }).isError) || 'error' in response).toBe(true);
      });
      expect(providers.resolve).not.toHaveBeenCalled();
      expect(value.request).not.toHaveBeenCalled();
    },
  );

  it('sanitizes source errors reported by the workflow core', async () => {
    const value = workflow();
    vi.mocked(value.request).mockRejectedValue(Object.assign(new Error(PRIVATE_DETAIL), { code: 'NO_DEFAULT_SOURCE' }));
    await withServer(value, sources(), async transport => {
      const response = result(await rpc(transport, {
        jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'request_identity', arguments: { identityProvider: 4 } },
      }));
      expect(response.isError).toBe(true);
      expect(JSON.stringify(response)).not.toMatch(/secret|Users\/alice/);
    });
  });
});
