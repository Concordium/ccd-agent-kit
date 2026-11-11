import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { IdentitySummary } from '../../src/core/workflowTypes.js';

type MonitorOptions = { onChange?: (summary: IdentitySummary) => void | Promise<void> };

const runtime = vi.hoisted(() => ({
  server: undefined as unknown,
  monitorOptions: undefined as unknown as MonitorOptions,
  monitor: { start: vi.fn(), wake: vi.fn(), stop: vi.fn(async () => undefined) },
  serveStdio: vi.fn(async (factory: () => Promise<unknown>) => {
    runtime.server = await factory();
  }),
  createDefaultIdentityWorkflow: vi.fn(),
  createDefaultIdentityProofService: vi.fn(),
  createEncryptedIdentityStore: vi.fn(),
  createDefaultIdentitySourceService: vi.fn(),
  createDefaultIdentityProviderService: vi.fn(),
  createIdentityMonitor: vi.fn((options: MonitorOptions) => {
    runtime.monitorOptions = options;
    return runtime.monitor;
  }),
  control: { close: vi.fn(async () => undefined) },
  startIdentityManagerInstanceControlServer: vi.fn(),
  sourceRegistry: { setSoftLabel: vi.fn() },
  networkAdapter: {
    list: vi.fn(),
    resolveDefault: vi.fn(),
    resolve: vi.fn(),
  },
}));

vi.mock('@modelcontextprotocol/server/stdio', () => ({ serveStdio: runtime.serveStdio }));
vi.mock('@ccd-agent-kit/config-utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ccd-agent-kit/config-utils')>()),
  createIdentitySourceRegistry: vi.fn(() => runtime.sourceRegistry),
  createNetworkResourceAdapter: vi.fn(() => runtime.networkAdapter),
}));
vi.mock('../../src/core/workflowInfrastructure.js', () => ({
  createDefaultIdentityWorkflow: runtime.createDefaultIdentityWorkflow,
  createDefaultIdentityProofService: runtime.createDefaultIdentityProofService,
  createEncryptedIdentityStore: runtime.createEncryptedIdentityStore,
}));
vi.mock('../../src/core/sources/runtime.js', () => ({
  createDefaultIdentitySourceService: runtime.createDefaultIdentitySourceService,
}));
vi.mock('../../src/core/identityMonitor.js', () => ({ createIdentityMonitor: runtime.createIdentityMonitor }));
vi.mock('../../src/core/instance/identityManagerInstance.js', () => ({
  startIdentityManagerInstanceControlServer: runtime.startIdentityManagerInstanceControlServer,
}));
vi.mock('../../src/core/providers/serviceFactory.js', () => ({
  createDefaultIdentityProviderService: runtime.createDefaultIdentityProviderService,
  resolveProviderNetwork: vi.fn((selector?: string) =>
    selector === 'other'
      ? { caip2: `ccd:${'34'.repeat(16)}`, genesisHash: '34'.repeat(32) }
      : { caip2: `ccd:${'12'.repeat(16)}`, genesisHash: '12'.repeat(32) },
  ),
}));

import type { IdentitySourceService } from '../../src/core/sources/types.js';
import { buildIdentityMcpServer, runIdentityMcpServer } from '../../src/mcp/server.js';
import { identityProviderServiceFixture } from '../helpers.js';
import { connectMcpTestClient, identityWorkflowFixture, rpc } from '../mcpTestHelpers.js';

const NETWORK = `ccd:${'12'.repeat(16)}`;
const OTHER_NETWORK = `ccd:${'34'.repeat(16)}`;
const ID = '35'.repeat(32);

describe('identity MCP runtime resource notifications', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runtime.server = undefined;
    runtime.monitorOptions = {};
    const primary = { name: 'primary', caip2: NETWORK, value: { caip2: NETWORK, genesisHash: '12'.repeat(32) } };
    const other = {
      name: 'other',
      caip2: OTHER_NETWORK,
      value: { caip2: OTHER_NETWORK, genesisHash: '34'.repeat(32) },
    };
    runtime.networkAdapter.list.mockReturnValue([primary, other]);
    runtime.networkAdapter.resolveDefault.mockReturnValue(primary);
    runtime.networkAdapter.resolve.mockImplementation((selector) =>
      selector === 'other' || selector === OTHER_NETWORK.slice('ccd:'.length) ? other : primary);
    runtime.createDefaultIdentityWorkflow.mockReturnValue(identityWorkflowFixture());
    runtime.createDefaultIdentityProofService.mockReturnValue({});
    runtime.createEncryptedIdentityStore.mockReturnValue({ listIdentityMonitorCandidates: vi.fn(async () => []) });
    runtime.createDefaultIdentitySourceService.mockReturnValue({
      resolve: vi.fn(),
      list: vi.fn(async () => []),
      records: vi.fn(async () => []),
      refresh: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    } as unknown as IdentitySourceService);
    runtime.startIdentityManagerInstanceControlServer.mockResolvedValue(runtime.control);
    runtime.createDefaultIdentityProviderService.mockReturnValue(
      identityProviderServiceFixture({
        getIdentityRequestTimeoutMs: vi.fn(async () => 60_000),
      }),
    );
  });

  it('routes background monitor changes to pinned canonical and wildcard subscriptions', async () => {
    await runIdentityMcpServer();
    const server = runtime.server as ReturnType<typeof buildIdentityMcpServer>;
    const notify = vi.spyOn(server.server, 'sendResourceUpdated').mockResolvedValue(undefined);
    const client = await connectMcpTestClient(server);
    try {
      await rpc(client, {
        jsonrpc: '2.0',
        id: 2,
        method: 'resources/subscribe',
        params: { uri: 'ccd://identities' },
      });
      await rpc(client, {
        jsonrpc: '2.0',
        id: 3,
        method: 'resources/subscribe',
        params: { uri: 'ccd://other/identities' },
      });
      await rpc(client, {
        jsonrpc: '2.0',
        id: 4,
        method: 'resources/subscribe',
        params: { uri: 'ccd://*/identities' },
      });
      const onChange = runtime.monitorOptions.onChange;
      expect(onChange).toBeTypeOf('function');
      if (onChange === undefined) return;

      await onChange({
        identityId: ID,
        network: NETWORK,
        identityProviderIndex: 4,
        identityIndex: 7,
        status: 'pending',
      });
      await Promise.resolve();
      expect(notify).not.toHaveBeenCalled();

      await onChange({
        identityId: ID,
        network: NETWORK,
        identityProviderIndex: 4,
        identityIndex: 7,
        status: 'issued',
      });
      await vi.waitFor(() =>
        expect(notify.mock.calls).toEqual([[{ uri: 'ccd://identities' }], [{ uri: 'ccd://*/identities' }]]),
      );

      notify.mockClear();
      await onChange({
        identityId: ID,
        network: OTHER_NETWORK,
        identityProviderIndex: 4,
        identityIndex: 7,
        status: 'failed',
      });
      await vi.waitFor(() =>
        expect(notify.mock.calls).toEqual([[{ uri: 'ccd://other/identities' }], [{ uri: 'ccd://*/identities' }]]),
      );
    } finally {
      await server.close();
    }
  });

  it('composes explicit source refresh and closes control state with the runtime', async () => {
    await runIdentityMcpServer();
    const sources = runtime.createDefaultIdentitySourceService.mock.results[0]!.value as IdentitySourceService;
    expect(runtime.startIdentityManagerInstanceControlServer).toHaveBeenCalledOnce();
    const options = runtime.startIdentityManagerInstanceControlServer.mock.calls[0]![0] as {
      refreshSources: () => Promise<void>;
    };

    await options.refreshSources();
    expect(sources.refresh).toHaveBeenCalledOnce();

    await (runtime.server as ReturnType<typeof buildIdentityMcpServer>).close();
    await vi.waitFor(() => expect(runtime.control.close).toHaveBeenCalledOnce());
    expect(sources.close).toHaveBeenCalledOnce();
  });

  it('closes already-created identity resources when control startup fails', async () => {
    runtime.startIdentityManagerInstanceControlServer.mockRejectedValueOnce(new Error('control unavailable'));

    await expect(runIdentityMcpServer()).rejects.toThrow(/control unavailable/);

    const sources = runtime.createDefaultIdentitySourceService.mock.results[0]!.value as IdentitySourceService;
    expect(sources.close).toHaveBeenCalledOnce();
    expect(runtime.monitor.stop).toHaveBeenCalledOnce();
  });
});
