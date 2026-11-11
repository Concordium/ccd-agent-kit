import { beforeEach, describe, expect, it, vi } from 'vitest';

const controls = vi.hoisted(() => ({
  handleRequest: undefined as ((request: Record<string, unknown>) => Promise<Record<string, unknown>>) | undefined,
  createOptions: undefined as Record<string, unknown> | undefined,
}));

vi.mock('@ccd-agent-kit/config-utils', () => ({ getStateDir: () => '.test-tmp/state' }));
vi.mock('@ccd-agent-kit/mcp-utils', () => ({
  MCP_INSTANCE_NAMESPACES: { idManager: 'id-manager' },
  createMcpInstanceId: () => 'instance-1',
  createMcpInstanceControl: vi.fn((options: Record<string, unknown>) => {
    controls.createOptions = options;
    return {
      start: vi.fn(async ({ handleRequest }: { handleRequest: typeof controls.handleRequest }) => {
        controls.handleRequest = handleRequest;
        return { close: async () => undefined, instance: { instanceId: 'instance-1' }, socketPath: 'private.sock' };
      }),
    };
  }),
}));

describe('identity-manager instance local decisions', () => {
  beforeEach(() => {
    controls.handleRequest = undefined;
    controls.createOptions = undefined;
    vi.resetModules();
  });

  it('uses minimal namespaced public status and strictly parses registrations', async () => {
    const instance = await import('../../src/core/instance/identityManagerInstance.js');
    const control = await instance.startIdentityManagerInstanceControlServer({ refreshSources: async () => undefined });
    const options = controls.createOptions as {
      namespace: string;
      getStatus: () => unknown;
      parseStatus: (raw: unknown) => unknown;
    };

    expect(options.namespace).toBe('id-manager');
    expect(options.getStatus()).toEqual({ instanceId: 'instance-1' });
    expect(options.parseStatus({ instanceId: 'other', socketPath: 'private.sock' })).toEqual({ instanceId: 'other' });
    expect(options.parseStatus({ instanceId: 1 })).toBeUndefined();
    expect(options.parseStatus(null)).toBeUndefined();
    expect(control.instance).toEqual({ instanceId: 'instance-1' });
  });

  it('accepts only source refresh and contains producer failures', async () => {
    const instance = await import('../../src/core/instance/identityManagerInstance.js');
    const refreshSources = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('private'));
    await instance.startIdentityManagerInstanceControlServer({ refreshSources });

    await expect(controls.handleRequest?.({ type: 'unknown' }))
      .resolves.toEqual({ ok: false, error: 'unsupported-request' });
    await expect(controls.handleRequest?.({ type: 'sources-refresh' })).resolves.toEqual({ ok: true });
    await expect(controls.handleRequest?.({ type: 'sources-refresh' }))
      .resolves.toEqual({ ok: false, error: 'refresh-failed' });
    expect(refreshSources).toHaveBeenCalledTimes(2);
  });
});
