import { IdentitySourceError,type IdentitySourceRegistry } from '@ccd-agent-kit/config-utils';
import { describe,expect,it,vi } from 'vitest';
import type { IdentitySourceService } from '../../src/core/sources/types.js';
import { buildIdentityMcpServer } from '../../src/mcp/server.js';
import { identityProviderServiceFixture } from '../helpers.js';
import { identityWorkflowFixture,mcpResult,mcpText,rpc,withMcpTestClient } from '../mcpTestHelpers.js';

const source = 'ir:y27dru5wlwjzay6';
const privateDetail = '/protected/source-location.json';

describe('source material soft labels over MCP', () => {
  function fixture() {
    const setSoftLabel = vi.fn(async (_source: string, label?: string) => ({
      id: source, ...(label === undefined ? {} : { label: '@StoredSpelling' }),
      backends: [{ locations: [{ serial: '12345678' }] }],
    }));
    const registry = { setSoftLabel } as unknown as IdentitySourceRegistry;
    const sources = {} as IdentitySourceService;
    const server = buildIdentityMcpServer(identityWorkflowFixture(), sources, identityProviderServiceFixture(), undefined, undefined, registry);
    return { server, setSoftLabel };
  }

  it.each([
    [{ label: 'requested-spelling' }, 'requested-spelling', { id: source, label: 'StoredSpelling' }],
    [{ remove: true }, undefined, { id: source }],
  ] as const)('applies explicit action %j without projecting locations', async (action, delegated, expected) => {
    const { server, setSoftLabel } = fixture();
    await withMcpTestClient(server, async client => {
      const response = mcpResult(await rpc(client, {
        jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: 'label_identity_source', arguments: { source, ...action } },
      }));
      expect(response.isError).not.toBe(true);
      expect(setSoftLabel).toHaveBeenCalledWith(source, delegated);
      expect(mcpText(response)).toEqual(expected);
      expect(JSON.stringify(response)).not.toMatch(/locations|serial|12345678/);
    });
  });

  it('rejects a conflicting source-label action before registry access', async () => {
    const { server, setSoftLabel } = fixture();
    await withMcpTestClient(server, async client => {
      const response = await rpc(client, {
        jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: 'label_identity_source', arguments: { source, label: 'Named', remove: true } },
      });
      expect(('result' in response && (response.result as { isError?: boolean }).isError) || 'error' in response).toBe(true);
      expect(setSoftLabel).not.toHaveBeenCalled();
    });
  });

  it.each([new IdentitySourceError('LABEL_PROTECTED'), new Error(privateDetail)])('returns a safe tool error for %s', async error => {
    const { server, setSoftLabel } = fixture();
    setSoftLabel.mockRejectedValue(error);
    await withMcpTestClient(server, async client => {
      const response = mcpResult(await rpc(client, {
        jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: 'label_identity_source', arguments: { source, label: 'Named' } },
      }));
      expect(response.isError).toBe(true);
      expect(JSON.stringify(response)).not.toContain(privateDetail);
      if (error instanceof IdentitySourceError) expect(JSON.stringify(response)).toContain(error.code);
    });
  });
});
