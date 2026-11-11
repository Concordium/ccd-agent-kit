import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getCurrentSignerInstanceStatus,
  startSignerInstanceControlServer,
} from '../../../../src/core/instance/signerInstance.js';
import {
  getSignerInstanceRegistryDir,
  initializeEncryptedFileStorage,
  isEncryptedFileStorageUnlocked,
  lockEncryptedFileStorage,
  notifyMcpInstancesConfigChanged,
  requestSignerInstanceLock,
  requestSignerInstanceUnlock,
} from '@ccd-agent-kit/config-utils';
import { makeTestTempDir } from '../../../helpers/tempDir.js';

describe('signerInstance', () => {
  let tempDir: string;
  let originalData: string | undefined;
  let originalRuntime: string | undefined;
  let originalState: string | undefined;

  beforeEach(() => {
    originalData = process.env.XDG_DATA_HOME;
    originalRuntime = process.env.XDG_RUNTIME_DIR;
    originalState = process.env.XDG_STATE_HOME;
    tempDir = makeTestTempDir('si-');
    process.env.XDG_DATA_HOME = join(tempDir, 'data');
    process.env.XDG_RUNTIME_DIR = tempDir;
    process.env.XDG_STATE_HOME = join(tempDir, 'state');
  });

  afterEach(() => {
    lockEncryptedFileStorage();
    rmSync(tempDir, { recursive: true, force: true });
    if (originalData !== undefined) process.env.XDG_DATA_HOME = originalData;
    else delete process.env.XDG_DATA_HOME;
    if (originalRuntime !== undefined) process.env.XDG_RUNTIME_DIR = originalRuntime;
    else delete process.env.XDG_RUNTIME_DIR;
    if (originalState !== undefined) process.env.XDG_STATE_HOME = originalState;
    else delete process.env.XDG_STATE_HOME;
  });

  it('dispatches unlock through the signer module and updates process status', async () => {
    initializeEncryptedFileStorage('pw');
    lockEncryptedFileStorage();
    const control = await startSignerInstanceControlServer({ network: 'testnet', status: 'locked' });
    try {
      await expect(
        requestSignerInstanceUnlock({ instanceId: control.instance.instanceId, password: 'pw' }),
      ).resolves.toEqual({ ok: true, status: 'unlocked' });
      expect(isEncryptedFileStorageUnlocked()).toBe(true);
      expect(getCurrentSignerInstanceStatus()).toMatchObject({ status: 'unlocked' });
    } finally {
      await control.close();
    }
  });

  it('dispatches lock through the signer module and updates process status', async () => {
    initializeEncryptedFileStorage('pw');
    const control = await startSignerInstanceControlServer({ network: 'testnet', status: 'unlocked' });
    try {
      await expect(requestSignerInstanceLock({ instanceId: control.instance.instanceId })).resolves.toEqual({
        ok: true,
        status: 'locked',
      });
      expect(isEncryptedFileStorageUnlocked()).toBe(false);
      expect(getCurrentSignerInstanceStatus()).toMatchObject({ status: 'locked' });
    } finally {
      await control.close();
    }
  });

  it('rejects unlock requests missing the module secret without changing state', async () => {
    initializeEncryptedFileStorage('pw');
    lockEncryptedFileStorage();
    const control = await startSignerInstanceControlServer({ status: 'locked' });
    try {
      await expect(
        requestSignerInstanceUnlock({ instanceId: control.instance.instanceId, password: '' }),
      ).rejects.toThrow(/missing-password/i);
      expect(isEncryptedFileStorageUnlocked()).toBe(false);
      expect(getCurrentSignerInstanceStatus()).toMatchObject({ status: 'locked' });
    } finally {
      await control.close();
    }
  });

  it('runs authenticated inventory refresh callbacks without changing signer status', async () => {
    const refreshInventory = vi.fn(async () => undefined);
    const control = await startSignerInstanceControlServer({ status: 'locked', refreshInventory });
    try {
      await expect(notifyMcpInstancesConfigChanged(['signer'])).resolves.toBeUndefined();
      expect(refreshInventory).toHaveBeenCalledOnce();
      expect(getCurrentSignerInstanceStatus()).toMatchObject({ status: 'locked' });
    } finally {
      await control.close();
    }
  });

  it('authenticates refresh callbacks and contains callback failures', async () => {
    const refreshInventory = vi.fn(async () => {
      throw new Error('private failure');
    });
    const control = await startSignerInstanceControlServer({ refreshInventory });
    try {
      await expect(
        sendRawControlRequest(control.socketPath, { authToken: '00'.repeat(32), type: 'inventory-refresh' }),
      ).resolves.toEqual({ ok: false, error: 'unauthorized' });
      expect(refreshInventory).not.toHaveBeenCalled();
      await expect(notifyMcpInstancesConfigChanged(['signer'])).resolves.toBeUndefined();
      expect(refreshInventory).toHaveBeenCalledOnce();
    } finally {
      await control.close();
    }
  });

  it('returns unsupported-request for controls not owned by a signer module', async () => {
    const control = await startSignerInstanceControlServer({ status: 'locked' });
    try {
      const { authToken } = JSON.parse(
        readFileSync(join(getSignerInstanceRegistryDir(), `${control.instance.instanceId}.json`), 'utf8'),
      ) as { authToken: string };

      await expect(
        sendRawControlRequest(control.socketPath, { authToken, type: 'unknown-control' }),
      ).resolves.toEqual({ ok: false, error: 'unsupported-request' });
      await expect(
        sendRawControlRequest(control.socketPath, { authToken, type: 'inventory-refresh' }),
      ).resolves.toEqual({ ok: false, error: 'unsupported-request' });
    } finally {
      await control.close();
    }
  });

  it.each([
    {
      action: 'unlock',
      initialStatus: 'locked' as const,
      invoke: (instanceId: string) => requestSignerInstanceUnlock({ instanceId, password: 'pw' }),
      storageUnlocked: false,
    },
    {
      action: 'lock',
      initialStatus: 'unlocked' as const,
      invoke: (instanceId: string) => requestSignerInstanceLock({ instanceId }),
      storageUnlocked: true,
    },
  ])('rejects $action with an invalid registry token and preserves state', async ({
    action,
    initialStatus,
    invoke,
    storageUnlocked,
  }) => {
    initializeEncryptedFileStorage('pw');
    if (!storageUnlocked) lockEncryptedFileStorage();
    const control = await startSignerInstanceControlServer({ status: initialStatus });
    try {
      writeFileSync(
        join(getSignerInstanceRegistryDir(), `${control.instance.instanceId}.json`),
        JSON.stringify({ ...control.instance, authToken: '00'.repeat(32), socketPath: control.socketPath }),
        'utf8',
      );

      await expect(invoke(control.instance.instanceId)).rejects.toThrow(new RegExp(`${action} failed`, 'i'));
      expect(getCurrentSignerInstanceStatus()).toMatchObject({ status: initialStatus });
      expect(isEncryptedFileStorageUnlocked()).toBe(storageUnlocked);
    } finally {
      await control.close();
    }
  });
});

function sendRawControlRequest(socketPath: string, request: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let response = '';
    socket.setEncoding('utf8');
    socket.on('error', reject);
    socket.on('data', (chunk) => {
      response += chunk;
    });
    socket.on('end', () => {
      try {
        resolve(JSON.parse(response) as Record<string, unknown>);
      } catch (error) {
        reject(error);
      }
    });
    socket.end(JSON.stringify(request));
  });
}
