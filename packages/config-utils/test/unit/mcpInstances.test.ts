import { beforeEach, describe, expect, it, vi } from 'vitest';

const createdOptions = vi.hoisted(() => [] as Array<{
  namespace: string;
  parseStatus: (raw: unknown) => { instanceId: string } | undefined;
}>);

const clients = vi.hoisted(() => ({
  signer: {
  getRegistryDir: vi.fn(() => '.test-tmp/state/ccd-agent-kit/signer/instances'),
  list: vi.fn(),
  notifyAll: vi.fn(),
  request: vi.fn(),
  },
  idManager: { list: vi.fn(), notifyAll: vi.fn(), request: vi.fn() },
}));

vi.mock('@ccd-agent-kit/mcp-utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ccd-agent-kit/mcp-utils')>()),
  createMcpInstanceClient: vi.fn((options) => {
    createdOptions.push(options);
    return options.namespace === 'signer' ? clients.signer : clients.idManager;
  }),
}));

import {
  getSignerInstanceRegistryDir,
  listSignerInstances,
  parseSignerInstanceStatus,
  requestSignerInstanceLock,
  requestSignerInstanceUnlock,
} from '../../src/signerInstances.js';
import { listIdentityManagerInstances, notifyMcpInstancesConfigChanged } from '../../src/mcpInstances.js';

describe('MCP instance clients', () => {
  beforeEach(() => vi.clearAllMocks());

  it('projects only safe status and supplies config-owned command guidance', () => {
    expect(parseSignerInstanceStatus({
      authToken: 'private-token',
      instanceId: 'instance-a',
      socketPath: '/private/control.sock',
      status: 'unlocked',
      unlockCommand: 'unsafe replacement',
    })).toEqual({
      instanceId: 'instance-a',
      status: 'unlocked',
      unlockCommand: 'ccd-config-manager service signer unlock --instance instance-a',
    });
    expect(parseSignerInstanceStatus({ instanceId: 'instance-b', status: 'future-version' })).toEqual({
      instanceId: 'instance-b',
      status: 'locked',
      unlockCommand: 'ccd-config-manager service signer unlock --instance instance-b',
    });
  });

  it.each([null, undefined, 'status', 1, [], {}, { instanceId: 1 }])(
    'rejects malformed status input %#',
    (raw) => expect(parseSignerInstanceStatus(raw)).toBeUndefined(),
  );

  it('forwards domain requests and normalizes returned status without exposing the password', async () => {
    clients.signer.request
      .mockResolvedValueOnce({ ok: true, status: 'locked', extra: 'ignored' })
      .mockResolvedValueOnce({ ok: true, status: 'unlocked', extra: 'ignored' })
      .mockResolvedValueOnce({ ok: true, status: 'unlocked' })
      .mockResolvedValueOnce({ ok: true, status: 'locked' });

    await expect(requestSignerInstanceUnlock({ instanceId: 'instance-a', password: 'secret' }))
      .resolves.toEqual({ ok: true, status: 'locked' });
    await expect(requestSignerInstanceLock({ instanceId: 'instance-a' }))
      .resolves.toEqual({ ok: true, status: 'unlocked' });
    await expect(requestSignerInstanceUnlock({ instanceId: 'instance-a', password: 'secret' }))
      .resolves.toEqual({ ok: true, status: 'unlocked' });
    await expect(requestSignerInstanceLock({ instanceId: 'instance-a' }))
      .resolves.toEqual({ ok: true, status: 'locked' });
    expect(clients.signer.request.mock.calls).toEqual([
      ['instance-a', { password: 'secret', type: 'unlock' }],
      ['instance-a', { type: 'lock' }],
      ['instance-a', { password: 'secret', type: 'unlock' }],
      ['instance-a', { type: 'lock' }],
    ]);
  });

  it.each([
    ['unlock', () => requestSignerInstanceUnlock({ instanceId: 'instance-a', password: 'secret' })],
    ['lock', () => requestSignerInstanceLock({ instanceId: 'instance-a' })],
  ])('rejects failed %s responses', async (_operation, request) => {
    clients.signer.request.mockResolvedValue({ ok: false });
    await expect(request()).rejects.toBeInstanceOf(Error);
  });

  it('delegates signer discovery and controls to shared instance control', () => {
    const statuses = [{ instanceId: 'instance-a', status: 'locked' }];
    clients.signer.list.mockReturnValue(statuses);

    expect(listSignerInstances()).toBe(statuses);
    expect(getSignerInstanceRegistryDir()).toBe('.test-tmp/state/ccd-agent-kit/signer/instances');
  });

  it('best-effort notifies only the requested namespaced runtimes with domain refresh requests', async () => {
    clients.signer.notifyAll.mockResolvedValue(undefined);
    clients.idManager.notifyAll.mockRejectedValue(new Error('unavailable'));

    await expect(notifyMcpInstancesConfigChanged(['signer', 'idManager', 'signer']))
      .resolves.toBeUndefined();

    expect(clients.signer.notifyAll).toHaveBeenCalledExactlyOnceWith({ type: 'inventory-refresh' });
    expect(clients.idManager.notifyAll).toHaveBeenCalledExactlyOnceWith({ type: 'sources-refresh' });
  });

  it('lists identity-manager instances through the isolated read-only client', () => {
    const instances = [{
      instanceId: 'id-a',
      lastSeenAt: '2026-10-28T12:00:00.000Z',
      network: 'testnet',
      pid: 42,
    }];
    clients.idManager.list.mockReturnValue(instances);

    expect(listIdentityManagerInstances()).toBe(instances);
    expect(clients.idManager.list).toHaveBeenCalledOnce();
    expect(clients.idManager.notifyAll).not.toHaveBeenCalled();
    expect(clients.idManager.request).not.toHaveBeenCalled();
  });

  it('uses isolated namespaces and projects refresh status to only an instance ID', () => {
    expect(new Set(createdOptions.map(options => options.namespace))).toEqual(new Set(['signer', 'id-manager']));
    const idManagerOptions = createdOptions.find(options => options.namespace === 'id-manager');
    expect(idManagerOptions?.parseStatus({
      instanceId: 'id-a', authToken: 'private', socketPath: '/private/control.sock', status: 'ignored',
    })).toEqual({ instanceId: 'id-a' });
    expect(idManagerOptions?.parseStatus({ instanceId: 1 })).toBeUndefined();
  });
});
