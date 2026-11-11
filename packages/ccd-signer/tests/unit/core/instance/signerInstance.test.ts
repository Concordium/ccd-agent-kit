import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { SignerModule } from '../../../../src/core/modules/types.js';

const controls = vi.hoisted(() => ({
  configured: false,
  handleRequest: undefined as ((request: Record<string, unknown>) => Promise<Record<string, unknown>>) | undefined,
  modules: [] as SignerModule[],
  updateRegistration: vi.fn(),
}));

vi.mock('@ccd-agent-kit/config-utils', () => ({
  isEncryptedFileStorageConfigured: () => controls.configured,
  parseSignerInstanceStatus: (value: unknown) => value,
  getStateDir: () => '.test-tmp/state',
}));
vi.mock('@ccd-agent-kit/mcp-utils', () => ({
  MCP_INSTANCE_NAMESPACES: { signer: 'signer' },
  createMcpInstanceId: () => 'instance-1',
  createMcpInstanceControl: () => ({
    start: vi.fn(async ({ handleRequest }: { handleRequest: typeof controls.handleRequest }) => {
      controls.handleRequest = handleRequest;
      return { close: async () => undefined, instance: { instanceId: 'instance-1' }, socketPath: 'private.sock' };
    }),
    updateRegistration: controls.updateRegistration,
  }),
}));
vi.mock('../../../../src/core/modules/registry.js', () => ({ listSignerModules: () => controls.modules }));

describe('signer instance local decisions', () => {
  beforeEach(() => {
    controls.configured = false;
    controls.handleRequest = undefined;
    controls.modules = [];
    controls.updateRegistration.mockClear();
    vi.resetModules();
  });

  it.each([
    { configured: false, status: 'unlocked' },
    { configured: true, status: 'locked' },
  ] as const)('derives the initial authorization status when encrypted storage configured is $configured', async ({ configured, status }) => {
    controls.configured = configured;
    const instance = await signerInstance();

    expect(instance.getCurrentSignerInstanceStatus()).toEqual({
      instanceId: 'instance-1',
      status,
      unlockCommand: 'ccd-config-manager service signer unlock --instance instance-1',
    });
    expect(instance.formatSignerInstanceStartupHint(instance.getCurrentSignerInstanceStatus()).join('\n')).not.toContain('private.sock');
  });

  it('contains refresh errors and leaves authorization unchanged', async () => {
    const instance = await signerInstance();
    await instance.startSignerInstanceControlServer({ status: 'locked' });
    await expect(controls.handleRequest?.({ type: 'inventory-refresh' }))
      .resolves.toEqual({ ok: false, error: 'unsupported-request' });
    const refreshInventory = vi.fn(async () => undefined);
    await instance.startSignerInstanceControlServer({ status: 'locked', refreshInventory });
    await expect(controls.handleRequest?.({ type: 'inventory-refresh' })).resolves.toEqual({ ok: true });
    expect(refreshInventory).toHaveBeenCalledOnce();
    await instance.startSignerInstanceControlServer({ status: 'locked', refreshInventory: async () => { throw new Error('producer failed'); } });

    await expect(controls.handleRequest?.({ type: 'inventory-refresh' })).resolves.toEqual({ ok: false, error: 'refresh-failed' });
    expect(instance.getCurrentSignerInstanceStatus().status).toBe('locked');
  });

  it('routes module controls and updates registration only for successful authorization changes', async () => {
    const notifyChanged = vi.fn();
    controls.modules = [module(async ({ request }) => request.type === 'unlock'
      ? { ok: true, status: 'unlocked' }
      : undefined)];
    const instance = await signerInstance();
    await instance.startSignerInstanceControlServer({ status: 'locked', notifyChanged });

    await expect(controls.handleRequest?.({ type: 'unknown' })).resolves.toEqual({ ok: false, error: 'unsupported-request' });
    await expect(controls.handleRequest?.({ type: 'unlock' })).resolves.toEqual({ ok: true, status: 'unlocked' });
    await controls.handleRequest?.({ type: 'unlock' });
    expect(instance.getCurrentSignerInstanceStatus().status).toBe('unlocked');
    expect(controls.updateRegistration).toHaveBeenCalledOnce();
    expect(notifyChanged).toHaveBeenCalledOnce();
  });
});

async function signerInstance() {
  return import('../../../../src/core/instance/signerInstance.js');
}

function module(handleControlRequest: NonNullable<SignerModule['handleControlRequest']>): SignerModule {
  return {
    defaultEnabled: true,
    handleControlRequest,
    id: 'control-test',
    isBackendVisible: () => true,
    signEd25519Digest: async () => '',
  };
}
