import { beforeEach, describe, expect, it, vi } from 'vitest';

const fakes = vi.hoisted(() => {
  const closeResources = vi.fn();
  const sendResourceUpdated = vi.fn(async () => undefined);
  const protocolServers: Array<{
    onclose?: () => void;
    sendResourceUpdated: typeof sendResourceUpdated;
    setRequestHandler: ReturnType<typeof vi.fn>;
  }> = [];
  const registeredTools: Array<{ name: string; handler: (input: unknown) => Promise<unknown> }> = [];
  const toolHandler = vi.fn(async (input: unknown) => ({ input }));
  const tool = {
    name: 'sentinel_tool',
    description: 'Sentinel tool',
    inputSchema: { sentinel: true },
    handler: toolHandler,
  };

  return {
    activateModules: vi.fn(),
    bindResourceSubscriptions: vi.fn((server: { server: { onclose?: () => void } }) => {
      server.server.onclose = closeResources;
    }),
    closeControl: vi.fn(async () => undefined),
    closeHardware: vi.fn(async () => undefined),
    closeModules: vi.fn(async () => undefined),
    closeResources,
    createNativeService: vi.fn(),
    createToolRegistry: vi.fn(() => ({ registry: 'sentinel' })),
    formatStartupHint: vi.fn(() => []),
    getActiveNetwork: vi.fn(() => ({ name: 'testnet' })),
    getStaticSkill: vi.fn(),
    listStaticSkills: vi.fn(),
    managerClose: vi.fn(async () => undefined),
    managerInputs: [] as unknown[],
    managerInstances: [] as Array<{ invalidate: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }>,
    mcpConstructors: vi.fn(),
    protocolServers,
    refreshModules: vi.fn(async () => undefined),
    registerAllSignerTools: vi.fn(() => ({ list: () => [tool] })),
    registeredTools,
    registerMcpResources: vi.fn(),
    resourceDefinitions: vi.fn(() => [{ resource: 'sentinel' }]),
    sendResourceUpdated,
    serveStdio: vi.fn(),
    startControl: vi.fn(),
    tool,
    toolHandler,
  };
});

vi.mock('@modelcontextprotocol/server', () => ({
  McpServer: class {
    public readonly server = {
      onclose: undefined as (() => void) | undefined,
      sendResourceUpdated: fakes.sendResourceUpdated,
      setRequestHandler: vi.fn(),
    };

    public constructor(...args: unknown[]) {
      fakes.mcpConstructors(...args);
      fakes.protocolServers.push(this.server);
    }

    public registerTool(name: string, _metadata: unknown, handler: (input: unknown) => Promise<unknown>): void {
      fakes.registeredTools.push({ name, handler });
    }
  },
  ProtocolError: class ProtocolError extends Error {},
  ProtocolErrorCode: { InvalidParams: -32602 },
}));

vi.mock('@modelcontextprotocol/server/stdio', () => ({ serveStdio: fakes.serveStdio }));
vi.mock('@ccd-agent-kit/config-utils', () => ({ getActiveNetwork: fakes.getActiveNetwork }));
vi.mock('@ccd-agent-kit/mcp-utils', () => ({
  ResourceSubscriptionManager: class {
    public readonly invalidate = vi.fn();
    public readonly close = fakes.managerClose;

    public constructor(input: unknown) {
      fakes.managerInputs.push(input);
      fakes.managerInstances.push(this);
    }
  },
  bindResourceSubscriptions: fakes.bindResourceSubscriptions,
  getStaticSkill: fakes.getStaticSkill,
  listStaticSkills: fakes.listStaticSkills,
  MCP_SKILLS_CAPABILITIES: { sentinel: 'capabilities' },
  MCP_SKILLS_GET_METHOD: 'sentinel/skills/get',
  MCP_SKILLS_LIST_METHOD: 'sentinel/skills/list',
  registerMcpResources: fakes.registerMcpResources,
}));
vi.mock('@ccd-agent-kit/piv-utils', () => ({ createNativePivYubiKeyService: fakes.createNativeService }));
vi.mock('../../../src/core/instance/signerInstance.js', () => ({
  formatSignerInstanceStartupHint: fakes.formatStartupHint,
  startSignerInstanceControlServer: fakes.startControl,
}));
vi.mock('../../../src/core/modules/activation.js', () => ({ activateSignerModules: fakes.activateModules }));
vi.mock('../../../src/mcp/resources/resourceDefinitions.js', () => ({
  signerResourceDefinitions: fakes.resourceDefinitions,
}));
vi.mock('../../../src/mcp/skills/catalog.js', () => ({ CONCORDIUM_SIGNER_MCP_SKILLS: [] }));
vi.mock('../../../src/mcp/tools/registerTools.js', () => ({ registerAllSignerTools: fakes.registerAllSignerTools }));
vi.mock('../../../src/mcp/tools/toolRegistry.js', () => ({ createSignerToolRegistry: fakes.createToolRegistry }));

beforeEach(() => {
  vi.clearAllMocks();
  fakes.managerInputs.length = 0;
  fakes.managerInstances.length = 0;
  fakes.protocolServers.length = 0;
  fakes.registeredTools.length = 0;

  fakes.createNativeService.mockReturnValue({ close: fakes.closeHardware });
  fakes.activateModules.mockResolvedValue({ close: fakes.closeModules, refresh: fakes.refreshModules });
  fakes.startControl.mockResolvedValue({ close: fakes.closeControl, instance: { id: 'sentinel' } });
});

describe('createMcpServer', () => {
  it('wires default and injected runtime services to the MCP boundary', async () => {
    const { createMcpServer } = await import('../../../src/mcp/server.js');
    const hardware = { close: fakes.closeHardware };

    const server = createMcpServer({ yubiKeyService: hardware as never });
    const defaultInput = fakes.managerInputs[0] as {
      registrations: unknown[];
      globals: Array<{ name: string; uri: string }>;
      notify: (uri: string) => Promise<void>;
    };
    expect(defaultInput).toMatchObject({
      registrations: [],
      globals: [{ name: 'keys', uri: 'ccd://keys' }],
    });
    await defaultInput.notify('ccd://keys');
    expect(fakes.sendResourceUpdated).toHaveBeenCalledWith({ uri: 'ccd://keys' });
    expect(fakes.registerAllSignerTools).toHaveBeenCalledWith({ registry: 'sentinel' }, hardware);
    expect(fakes.registerMcpResources).toHaveBeenCalledWith(server, [{ resource: 'sentinel' }]);
    expect(fakes.bindResourceSubscriptions).toHaveBeenCalledWith(server, fakes.managerInstances[0], {
      transport: 'stdio',
    });
    await fakes.registeredTools[0]!.handler({ value: 7 });
    expect(fakes.toolHandler).toHaveBeenCalledWith({ value: 7 });

    const injected = { invalidate: vi.fn(), close: vi.fn() };
    const injectedServer = createMcpServer({ subscriptions: injected as never });
    expect(fakes.managerInputs).toHaveLength(1);
    expect(fakes.bindResourceSubscriptions).toHaveBeenLastCalledWith(injectedServer, injected, {
      transport: 'stdio',
    });
  });
});

describe('runMcpServer', () => {
  it('composes runtime callbacks and closes all owned services', async () => {
    const { runMcpServer } = await import('../../../src/mcp/server.js');

    await runMcpServer();
    const [factory] = fakes.serveStdio.mock.calls[0] as [() => Promise<{ server: { onclose?: () => void } }>];
    const server = await factory();
    const subscriptions = fakes.managerInstances[0]!;
    const [moduleOptions] = fakes.activateModules.mock.calls[0] as [{
      services: { yubiKeyService: { close: typeof fakes.closeHardware } };
      notifyChanged: () => void;
    }];
    const [controlOptions] = fakes.startControl.mock.calls[0] as [{
      network: string;
      notifyChanged: () => void;
      refreshInventory: () => Promise<void>;
    }];

    expect(moduleOptions).toMatchObject({ services: { yubiKeyService: { close: fakes.closeHardware } } });
    expect(controlOptions.network).toBe('testnet');
    const runtimeInput = fakes.managerInputs[0] as { notify: (uri: string) => Promise<void> };
    await runtimeInput.notify('ccd://keys');
    expect(fakes.sendResourceUpdated).toHaveBeenCalledWith({ uri: 'ccd://keys' });
    moduleOptions.notifyChanged();
    controlOptions.notifyChanged();
    expect(subscriptions.invalidate).toHaveBeenNthCalledWith(1, { resourceName: 'keys' });
    expect(subscriptions.invalidate).toHaveBeenNthCalledWith(2, { resourceName: 'keys' });
    await controlOptions.refreshInventory();
    expect(fakes.refreshModules).toHaveBeenCalledOnce();

    server.server.onclose?.();
    expect(fakes.closeResources).toHaveBeenCalledOnce();
    await vi.waitFor(() => {
      expect(fakes.closeControl).toHaveBeenCalledOnce();
      expect(fakes.closeModules).toHaveBeenCalledOnce();
      expect(fakes.closeHardware).toHaveBeenCalledOnce();
    });
  });

  it('cleans up services assembled before a startup failure', async () => {
    fakes.startControl.mockRejectedValueOnce(new Error('control failed'));
    const { runMcpServer } = await import('../../../src/mcp/server.js');

    await runMcpServer();
    const [factory] = fakes.serveStdio.mock.calls[0] as [() => Promise<unknown>];
    await expect(factory()).rejects.toThrow('control failed');

    expect(fakes.closeControl).not.toHaveBeenCalled();
    expect(fakes.closeModules).toHaveBeenCalledOnce();
    expect(fakes.closeHardware).toHaveBeenCalledOnce();
  });
});
