import { afterEach,describe,expect,it,vi } from 'vitest';

const {
  serveStdio, createDefaultIdentityWorkflow, createDefaultIdentityProofService, createEncryptedIdentityStore,
  createDefaultIdentitySourceService, createDefaultIdentityProviderService, createIdentityMonitor,
  resolveProviderNetwork,
  resolveNetworkResource,
  startIdentityManagerInstanceControlServer,
  closeControl,
} = vi.hoisted(() => ({
  serveStdio: vi.fn(),
  createDefaultIdentityWorkflow: vi.fn(),
  createDefaultIdentityProofService: vi.fn(),
  createEncryptedIdentityStore: vi.fn(),
  createDefaultIdentitySourceService: vi.fn(),
  createDefaultIdentityProviderService: vi.fn(),
  createIdentityMonitor: vi.fn(),
  resolveProviderNetwork: vi.fn((network: string) => ({ caip2: network, genesisHash: '12'.repeat(32) })),
  resolveNetworkResource: vi.fn(() => ({
    name: 'testnet', caip2: `ccd:${'12'.repeat(16)}`, value: { genesisHash: '12'.repeat(32) },
  })),
  closeControl: vi.fn(async () => undefined),
  startIdentityManagerInstanceControlServer: vi.fn(),
}));

vi.mock('@modelcontextprotocol/server/stdio', () => ({ serveStdio }));
vi.mock('../../src/core/workflowInfrastructure.js', () => ({
  createDefaultIdentityWorkflow, createDefaultIdentityProofService, createEncryptedIdentityStore,
}));
vi.mock('../../src/core/identityMonitor.js', () => ({ createIdentityMonitor }));
vi.mock('../../src/core/instance/identityManagerInstance.js', () => ({ startIdentityManagerInstanceControlServer }));
vi.mock('../../src/core/sources/runtime.js', () => ({ createDefaultIdentitySourceService }));
vi.mock('../../src/core/providers/serviceFactory.js', () => ({ createDefaultIdentityProviderService, resolveProviderNetwork }));
vi.mock('@ccd-agent-kit/config-utils', async importOriginal => ({
  ...await importOriginal<typeof import('@ccd-agent-kit/config-utils')>(),
  createNetworkResourceAdapter: vi.fn(() => ({
    list: () => [], resolveDefault: resolveNetworkResource, resolve: resolveNetworkResource,
  })),
}));

import type { IdentitySourceService } from '../../src/core/sources/types.js';
import { runIdentityMcpServer } from '../../src/mcp/server.js';
import { identityWorkflowFixture } from '../mcpTestHelpers.js';

describe('identity MCP stdio startup', () => {
  afterEach(() => vi.restoreAllMocks());

  it('passes a lazy default-workflow server factory to stdio', async () => {
    const value = identityWorkflowFixture();
    const sourceService = {
      refresh: vi.fn(async () => undefined), resolve: vi.fn(), list: vi.fn(), records: vi.fn(),
      close: vi.fn(async () => undefined),
    } as unknown as IdentitySourceService;
    const providerService = {
      resolve: vi.fn(), inventory: vi.fn(), getIdentityRequestTimeoutMs: vi.fn(async () => 60_000),
    };
    const store = { listIdentityMonitorCandidates: vi.fn() };
    const monitor = { start: vi.fn(), wake: vi.fn(), stop: vi.fn(async () => undefined) };
    createDefaultIdentityWorkflow.mockReturnValue(value);
    createDefaultIdentityProofService.mockReturnValue({});
    createEncryptedIdentityStore.mockReturnValue(store);
    createIdentityMonitor.mockReturnValue(monitor);
    createDefaultIdentitySourceService.mockReturnValue(sourceService);
    createDefaultIdentityProviderService.mockReturnValue(providerService);
    startIdentityManagerInstanceControlServer.mockResolvedValue({ close: closeControl });
    await runIdentityMcpServer();
    expect(serveStdio).toHaveBeenCalledOnce();
    expect(createDefaultIdentityWorkflow).not.toHaveBeenCalled();
    expect(createDefaultIdentitySourceService).not.toHaveBeenCalled();
    expect(createDefaultIdentityProviderService).not.toHaveBeenCalled();
    expect(createIdentityMonitor).not.toHaveBeenCalled();
    const [factory] = serveStdio.mock.calls[0]!;
    const server = await factory();
    expect(createDefaultIdentityWorkflow).toHaveBeenCalledOnce();
    expect(createDefaultIdentitySourceService).toHaveBeenCalledExactlyOnceWith({ persistent: true });
    expect(createDefaultIdentityProviderService).toHaveBeenCalledOnce();
    expect(createDefaultIdentityWorkflow).toHaveBeenCalledWith({
      providerPolicy: 'mcp', providers: providerService, sources: sourceService, store,
    });
    expect(createDefaultIdentityProofService).toHaveBeenCalledWith({ sources: sourceService, store });
    expect(startIdentityManagerInstanceControlServer).toHaveBeenCalledWith({ refreshSources: expect.any(Function) });
    expect(createIdentityMonitor).toHaveBeenCalledWith({
      workflow: value, store, getIdentityRequestTimeoutMs: expect.any(Function), onChange: expect.any(Function),
    });
    const timeout = createIdentityMonitor.mock.calls[0]![0].getIdentityRequestTimeoutMs;
    await expect(timeout(`ccd:${'12'.repeat(16)}`)).resolves.toBe(60_000);
    expect(providerService.getIdentityRequestTimeoutMs).toHaveBeenCalledWith({
      network: expect.objectContaining({ caip2: `ccd:${'12'.repeat(16)}` }),
    });
    const onChange = createIdentityMonitor.mock.calls[0]![0].onChange;
    const summary = {
      identityId: '35'.repeat(32), network: `ccd:${'12'.repeat(16)}`,
      identityProviderIndex: 4, identityIndex: 7,
    };
    await onChange({ ...summary, status: 'pending' });
    expect(resolveNetworkResource).not.toHaveBeenCalled();
    await onChange({ ...summary, status: 'issued' });
    expect(resolveNetworkResource).toHaveBeenCalledExactlyOnceWith('12121212121212121212121212121212');
    expect(monitor.start).toHaveBeenCalledOnce();
    server.server.onclose?.();
    await server.close();
    expect(closeControl).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(monitor.stop).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(sourceService.close).toHaveBeenCalledOnce());
    expect(server).toBeTruthy();
  });

  it('writes only a fixed transport failure from the stdio error callback', async () => {
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await runIdentityMcpServer();
    const [, options] = serveStdio.mock.calls[0]!;
    options.onerror(new Error('secret /Users/alice/private-state'));
    expect(stderr).toHaveBeenCalledWith('ccd-id-manager-mcp: stdio transport failed.');
    expect(JSON.stringify(stderr.mock.calls)).not.toContain('/Users/alice');
  });

});
