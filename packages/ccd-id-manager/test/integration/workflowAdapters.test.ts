import type { InMemoryTransport } from '@modelcontextprotocol/server';
import { describe,expect,it,vi } from 'vitest';
import type { IdentityMonitor } from '../../src/core/identityMonitor.js';
import type { IdentitySourceService } from '../../src/core/sources/types.js';
import type { CredentialDiscoveryResult,IdentityDiscoveryResult,IdentityRequestResult,IdentitySummary,IdentityWorkflow } from '../../src/core/workflowTypes.js';
import { buildIdentityMcpServer } from '../../src/mcp/server.js';
import { identityProviderServiceFixture,TEST_CANONICAL_NETWORK } from '../helpers.js';
import {
identityWorkflowFixture,mcpResult as result,
rpc,
mcpText as text,
withMcpTestClient,
} from '../mcpTestHelpers.js';

const adapterMocks = vi.hoisted(() => ({
  createDefaultIdentityWorkflow: vi.fn(), createDefaultIdentityProviderService: vi.fn(),
}));
vi.mock('../../src/core/workflowInfrastructure.js', () => ({
  createDefaultIdentityWorkflow: adapterMocks.createDefaultIdentityWorkflow,
}));
vi.mock('../../src/core/providers/serviceFactory.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/core/providers/serviceFactory.js')>(),
  resolveProviderNetwork: vi.fn(() => TEST_CANONICAL_NETWORK),
  createDefaultIdentityProviderService: adapterMocks.createDefaultIdentityProviderService,
}));

const PRIVATE_DETAIL = 'ROOT_SECRET at /Users/alice/.local/share/ccd-agent-kit';
const ID = '35'.repeat(32);
const SOURCE_ID = 'ir:2abcdefghijklmn';
const PUBLIC_KEY = '22'.repeat(32);
const summary: IdentitySummary = {
  identityId: ID, network: 'testnet', identityProviderIndex: 4,
  identityIndex: 7, status: 'pending',
};
const labeledSummary: IdentitySummary = { ...summary, label: 'ted' };
const requestSummary: IdentityRequestResult = { ...summary, status: 'pending', outcome: 'requested' };
const identityDiscovery: IdentityDiscoveryResult = {
  network: TEST_CANONICAL_NETWORK.caip2, sourceId: SOURCE_ID, gapLimit: 3,
  streams: [{ identityProviderIndex: 4, used: [0], reserved: [2], unused: [1],
    scannedRange: { start: 0, end: 3 }, nextIndex: 4, partial: false, stopReason: 'gap' }],
};
const credentialDiscovery: CredentialDiscoveryResult = {
  network: TEST_CANONICAL_NETWORK.caip2, identityId: ID, gapLimit: 3,
  sourceBlock: { hash: 'aa'.repeat(32), height: '7', time: '2026-10-16T00:00:00.000Z' },
  stream: { used: [0], reserved: [], unused: [1, 2, 3], scannedRange: { start: 0, end: 3 },
    nextIndex: 4, partial: false, stopReason: 'gap' },
};

type AdapterWorkflow = IdentityWorkflow & {
  discoverIdentities: ReturnType<typeof vi.fn>;
  associateIdentitySource: ReturnType<typeof vi.fn>;
  discoverAccountCredentials: ReturnType<typeof vi.fn>;
};

function workflowFixture(): AdapterWorkflow {
  return identityWorkflowFixture({
    request: vi.fn(async () => requestSummary), recover: vi.fn(async () => ({ ...summary, status: 'issued' as const })),
    status: vi.fn(async () => summary), list: vi.fn(async () => [summary]),
    prepareAccount: vi.fn(async () => ({ network: 'testnet', credDeploymentHex: 'aabb', accountAddress: 'account', credentialNumber: 3, expirySeconds: 900 })),
    reconcileAccountOpening: vi.fn(async () => ({ network: 'testnet', identityId: ID, status: 'pending' as const, credentialNumber: 3 })),
    discoverIdentities: vi.fn(async () => identityDiscovery),
    associateIdentitySource: vi.fn(async () => ({ ...summary, status: 'issued' as const })),
    discoverAccountCredentials: vi.fn(async () => credentialDiscovery),
    setOperatorIdentityLabel: vi.fn(async () => labeledSummary), setAgentIdentityLabel: vi.fn(async () => labeledSummary),
    monitorIdentity: vi.fn(async () => summary),
  }) as AdapterWorkflow;
}

function sourceFixture(): IdentitySourceService {
  return {
    resolve: vi.fn(), records: vi.fn(async () => []),
    list: vi.fn(async () => [{ id: SOURCE_ID, label: 'PrimaryKey', backend: 'future-backend', isDefault: true, availability: 'locked' }]),
  } as unknown as IdentitySourceService;
}

async function withServer(
  workflow: AdapterWorkflow,
  run: (transport: InMemoryTransport) => Promise<void>,
  monitor?: IdentityMonitor,
) {
  const server = buildIdentityMcpServer(workflow, sourceFixture(), identityProviderServiceFixture(), monitor);
  await withMcpTestClient(server, run);
}


describe('identity MCP adapter', () => {
  it('registers the current workflow and safe labeling tools', async () => {
    await withServer(workflowFixture(), async transport => {
      const listed = result(await rpc(transport, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }));
      expect((listed.tools as Array<{ name: string }>).map(({ name }) => name)).toEqual([
        'request_identity', 'recover_identity',
        'prepare_account_opening', 'reconcile_account_opening',
        'discover_identities', 'discover_account_credentials', 'label_identity', 'label_identity_source',
        'validate_proof_request', 'find_proof_candidates', 'create_identity_proof',
      ]);
    });
  });

  it('publishes strict request/recovery schemas with different identity-index requirements', async () => {
    await withServer(workflowFixture(), async transport => {
      const listed = result(await rpc(transport, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }));
      const tools = listed.tools as Array<{ name: string; description?: string; inputSchema: { additionalProperties?: boolean; properties: Record<string, unknown>; required?: string[] } }>;
      const requestTool = tools.find(tool => tool.name === 'request_identity')!;
      const request = requestTool.inputSchema;
      const recover = tools.find(tool => tool.name === 'recover_identity')!.inputSchema;
      expect(request.additionalProperties).toBe(false);
      expect(request.required).toEqual(['identityProvider']);
      expect(recover.required?.sort()).toEqual(['identityIndex', 'identityProvider']);
      for (const schema of [request, recover]) {
        expect(schema.properties).toHaveProperty('source');
        expect(schema.properties).not.toHaveProperty('device');
        expect(schema.properties).not.toHaveProperty('rootPublicKey');
      }
      const discovery = tools.find(tool => tool.name === 'discover_identities')!;
      const credentials = tools.find(tool => tool.name === 'discover_account_credentials')!;
      const prepare = tools.find(tool => tool.name === 'prepare_account_opening')!;
      expect(discovery.description).toMatch(/recover.*save/i);
      expect(discovery.inputSchema.properties).toHaveProperty('startIndex');
      expect(credentials.inputSchema.properties).toHaveProperty('startCredentialNumber');
      expect(prepare.inputSchema.properties).toHaveProperty('revealAttributes');
      expect(prepare.inputSchema.properties).not.toHaveProperty('approvalToken');
      expect(prepare.inputSchema.properties).not.toHaveProperty('approved');
      expect(prepare.description).toMatch(/public on-chain/i);
      expect(requestTool.description).toMatch(/requested.*identity_already_exists/i);
    });
  });

  it.each([
    ['request_identity', { network: 'testnet', source: 'PrimaryKey', identityProvider: 'Primary' }, 'request', { network: TEST_CANONICAL_NETWORK.caip2, source: 'PrimaryKey', identityProviderIndex: 4 }],
    ['recover_identity', { source: SOURCE_ID, identityProvider: 4, identityIndex: 7 }, 'recover', { source: SOURCE_ID, identityProviderIndex: 4, identityIndex: 7, network: TEST_CANONICAL_NETWORK.caip2 }],
    ['discover_identities', { network: 'testnet', source: 'PrimaryKey', gapLimit: 5, startIndex: 0, endIndex: 4 }, 'discoverIdentities', { network: TEST_CANONICAL_NETWORK.caip2, source: 'PrimaryKey', gapLimit: 5, startIndex: 0, endIndex: 4 }],
    ['discover_account_credentials', { identityId: ID, gapLimit: 2, startCredentialNumber: 0, endCredentialNumber: 3, full: false }, 'discoverAccountCredentials', { identityId: ID, gapLimit: 2, startCredentialNumber: 0, endCredentialNumber: 3 }],
  ] as const)('routes %s through thin, canonical adapter input', async (tool, args, method, expected) => {
    const workflow = workflowFixture();
    await withServer(workflow, async transport => {
      const response = result(await rpc(transport, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: tool, arguments: args } }));
      expect(response.isError).not.toBe(true);
      expect(text(response)).toBeTruthy();
    });
    expect(workflow[method]).toHaveBeenCalledExactlyOnceWith(expected);
  });

  it.each([
    ['prepare_account_opening', {
      network: 'testnet', identityId: ID,
      publicKeys: { '0': PUBLIC_KEY, '7': '22'.repeat(32) }, credentialThreshold: 2, expirySeconds: 900,
    }, 'prepareAccount', {
      network: 'testnet', identityId: ID,
      publicKeys: { '0': PUBLIC_KEY, '7': '22'.repeat(32) }, credentialThreshold: 2, expirySeconds: 900,
    }],
    ['reconcile_account_opening', { network: 'testnet', identityId: ID }, 'reconcileAccountOpening', {
      network: 'testnet', identityId: ID,
    }],
    ['discover_account_credentials', {
      network: 'testnet', identityId: ID, full: true,
    }, 'discoverAccountCredentials', {
      network: 'testnet', identityId: ID, full: true,
    }],
  ] as const)('forwards documented optional fields through %s', async (tool, args, method, expected) => {
    const workflow = workflowFixture();
    await withServer(workflow, async transport => {
      const response = result(await rpc(transport, {
        jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: tool, arguments: args },
      }));
      expect(response.isError).not.toBe(true);
    });
    expect(workflow[method]).toHaveBeenCalledExactlyOnceWith(expected);
  });

  it('forwards explicit MCP disclosure selection without adding approval state', async () => {
    const workflow = workflowFixture();
    await withServer(workflow, async transport => {
      const response = result(await rpc(transport, {
        jsonrpc: '2.0', id: 2, method: 'tools/call', params: {
          name: 'prepare_account_opening',
          arguments: {
            identityId: ID, publicKeys: { '0': PUBLIC_KEY }, credentialThreshold: 1, expirySeconds: 900,
            revealAttributes: ['lastName', 'firstName'],
          },
        },
      }));
      expect(response.isError).not.toBe(true);
    });
    expect(workflow.prepareAccount).toHaveBeenCalledWith(expect.objectContaining({
      revealAttributes: ['lastName', 'firstName'],
    }));
  });

  it('forwards explicit request index zero without inventing a source', async () => {
    const workflow = workflowFixture();
    await withServer(workflow, async transport => {
      const response = result(await rpc(transport, {
        jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: 'request_identity', arguments: { identityProvider: 0, identityIndex: 0 } },
      }));
      expect(response.isError).not.toBe(true);
    });
    expect(workflow.request).toHaveBeenCalledExactlyOnceWith({
      network: TEST_CANONICAL_NETWORK.caip2, identityProviderIndex: 4, identityIndex: 0,
    });
  });

  it.each([
    ['discover_account_credentials', { identityId: ' TeD ' }, 'discoverAccountCredentials'],
    ['prepare_account_opening', { identityId: ' TeD ', publicKeys: { '0': PUBLIC_KEY }, credentialThreshold: 1, expirySeconds: 900 }, 'prepareAccount'],
    ['reconcile_account_opening', { identityId: ' TeD ' }, 'reconcileAccountOpening'],
  ] as const)('resolves bare MCP identity selector for %s in a pinned canonical network', async (tool, args, method) => {
    const workflow = workflowFixture();
    vi.mocked(workflow.list).mockResolvedValue([labeledSummary]);
    await withServer(workflow, async transport => {
      const response = result(await rpc(transport, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: {
        name: tool, arguments: { network: 'testnet', ...args },
      } }));
      expect(response.isError).not.toBe(true);
    });
    expect(workflow.list).toHaveBeenCalledWith({ network: TEST_CANONICAL_NETWORK.caip2 });
    expect(workflow[method]).toHaveBeenCalledWith(expect.objectContaining({
      network: TEST_CANONICAL_NETWORK.caip2, identityId: ID,
    }));
  });

  it('labels through agent authority after resolving a bare selector', async () => {
    const workflow = workflowFixture();
    vi.mocked(workflow.list).mockResolvedValue([labeledSummary]);
    await withServer(workflow, async transport => {
      const response = result(await rpc(transport, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: {
        name: 'label_identity', arguments: { identityId: 'ted', label: 'next' },
      } }));
      expect(text(response)).toMatchObject({ identityId: ID, label: 'ted' });
    });
    expect(workflow.setAgentIdentityLabel).toHaveBeenCalledExactlyOnceWith({
      network: TEST_CANONICAL_NETWORK.caip2, identityId: ID, operation: 'set', label: 'next',
    });
  });

  it('maps explicit MCP removal to soft-only removal by native identity ID', async () => {
    const workflow = workflowFixture();
    vi.mocked(workflow.setAgentIdentityLabel).mockResolvedValueOnce(summary);
    await withServer(workflow, async transport => {
      const response = result(await rpc(transport, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: {
        name: 'label_identity', arguments: { identityId: ID, remove: true },
      } }));
      expect(response.isError).not.toBe(true);
      expect(text(response)).not.toHaveProperty('label');
    });
    expect(workflow.setAgentIdentityLabel).toHaveBeenCalledExactlyOnceWith({
      network: TEST_CANONICAL_NETWORK.caip2, identityId: ID, operation: 'remove',
    });
  });

  it('reports an unknown bare selector without performing an identity operation', async () => {
    const workflow = workflowFixture();
    vi.mocked(workflow.list).mockResolvedValue([]);
    await withServer(workflow, async transport => {
      const response = result(await rpc(transport, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: {
        name: 'label_identity', arguments: { identityId: 'missing', label: 'next' },
      } }));
      expect(response.isError).toBe(true);
    });
    expect(workflow.setAgentIdentityLabel).not.toHaveBeenCalled();
  });

  it('passes an identity-already-exists MCP outcome through without an error', async () => {
    const workflow = workflowFixture();
    vi.mocked(workflow.request).mockResolvedValueOnce({
      ...summary, status: 'issued', outcome: 'identity_already_exists',
    } as never);
    await withServer(workflow, async transport => {
      const response = result(await rpc(transport, {
        jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: 'request_identity', arguments: { identityProvider: 4 } },
      }));
      expect(response.isError).not.toBe(true);
      expect(text(response)).toMatchObject({ outcome: 'identity_already_exists', status: 'issued' });
    });
  });

  it.each(['success', 'failure'] as const)('wakes the in-process monitor after request %s', async (outcome) => {
    const workflow = workflowFixture();
    if (outcome === 'failure') vi.mocked(workflow.request).mockRejectedValueOnce(new Error('provider unavailable'));
    const monitor: IdentityMonitor = {
      start: vi.fn(), wake: vi.fn(), stop: vi.fn(async () => undefined),
    };
    await withServer(workflow, async transport => {
      await rpc(transport, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: {
        name: 'request_identity', arguments: { identityProvider: 4 },
      } });
    }, monitor);
    expect(monitor.wake).toHaveBeenCalledOnce();
    expect(monitor.start).not.toHaveBeenCalled();
  });

  it('resolves only an explicit identity-discovery provider and requires it enabled', async () => {
    const workflow = workflowFixture();
    const providers = identityProviderServiceFixture();
    const server = buildIdentityMcpServer(workflow, sourceFixture(), providers);
    await withMcpTestClient(server, async client => {
      await rpc(client, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'discover_identities', arguments: {} } });
      expect(providers.resolve).not.toHaveBeenCalled();
      await rpc(client, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'discover_identities', arguments: { identityProvider: 'Primary' } } });
      expect(providers.resolve).toHaveBeenCalledExactlyOnceWith({ network: TEST_CANONICAL_NETWORK, selector: 'Primary', requireEnabled: true });
      expect(workflow.discoverIdentities).toHaveBeenLastCalledWith({ network: TEST_CANONICAL_NETWORK.caip2, identityProviderIndex: 4 });
    });
  });

  it.each([
    ['request_identity', { identityProvider: 4, device: '123' }, 'request'],
    ['request_identity', { identityProvider: 4, rootPublicKey: '04' }, 'request'],
    ['request_identity', { identityProvider: 4, identityProviderIndex: 4 }, 'request'],
    ['request_identity', { identityProvider: 4, walletProxyUrl: 'https://attacker.example' }, 'request'],
    ['discover_identities', { gapLimit: 0 }, 'discoverIdentities'],
    ['discover_identities', { endIndex: 0x80000000 }, 'discoverIdentities'],
    ['discover_identities', { startIndex: 2, endIndex: 1 }, 'discoverIdentities'],
    ['discover_identities', { full: true }, 'discoverIdentities'],
    ['discover_account_credentials', { identityId: ID, endCredentialNumber: 256 }, 'discoverAccountCredentials'],
    ['discover_account_credentials', { identityId: ID, startCredentialNumber: 2, endCredentialNumber: 1 }, 'discoverAccountCredentials'],
    ['discover_account_credentials', { identityId: ID, full: true, startCredentialNumber: 0 }, 'discoverAccountCredentials'],
    ['discover_account_credentials', { identityId: ID, full: true, endCredentialNumber: 1 }, 'discoverAccountCredentials'],
    ['label_identity', { identityId: ID, label: 'ted', remove: true }, 'setAgentIdentityLabel'],
    ['reconcile_account_opening', { identityId: ID, identityProvider: 4 }, 'reconcileAccountOpening'],
    ['prepare_account_opening', { identityId: ID, publicKey: PUBLIC_KEY, expirySeconds: 900 }, 'prepareAccount'],
    ['prepare_account_opening', { identityId: ID, publicKeys: { '00': PUBLIC_KEY }, credentialThreshold: 1, expirySeconds: 900 }, 'prepareAccount'],
    ['prepare_account_opening', { identityId: ID, publicKeys: { '0': PUBLIC_KEY }, credentialThreshold: 2, expirySeconds: 900 }, 'prepareAccount'],
    ['prepare_account_opening', { identityId: ID, publicKeys: { '0': PUBLIC_KEY }, credentialThreshold: 1, expirySeconds: 900, revealAttributes: ['dob'] }, 'prepareAccount'],
    ['prepare_account_opening', { identityId: ID, publicKeys: { '0': PUBLIC_KEY }, credentialThreshold: 1, expirySeconds: 900, revealAttributes: ['firstName', 7] }, 'prepareAccount'],
  ] as const)('strictly rejects invalid or legacy input to %s: %j', async (tool, args, method) => {
    const workflow = workflowFixture();
    await withServer(workflow, async transport => {
      const response = await rpc(transport, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: tool, arguments: args } });
      expect(('result' in response && (response.result as { isError?: boolean }).isError) || 'error' in response).toBe(true);
    });
    expect(workflow[method]).not.toHaveBeenCalled();
  });

  it('returns sanitized errors from discovery handlers without leaking paths', async () => {
    const workflow = workflowFixture();
    vi.mocked(workflow.discoverIdentities).mockRejectedValue(new Error(PRIVATE_DETAIL));
    await withServer(workflow, async transport => {
      const response = result(await rpc(transport, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'discover_identities', arguments: {} } }));
      expect(response.isError).toBe(true);
      expect(JSON.stringify(response)).not.toMatch(/ROOT_SECRET|Users\/alice/);
    });
  });
});
