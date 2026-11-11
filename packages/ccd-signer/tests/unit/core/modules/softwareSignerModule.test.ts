import { beforeEach, describe, expect, it, vi } from 'vitest';

const controls = vi.hoisted(() => ({
  isEncryptedFileStorageUnlocked: vi.fn(),
  loadEncryptedEd25519PrivateKey: vi.fn(),
  lockEncryptedFileStorage: vi.fn(),
  signAsync: vi.fn(),
  unlockEncryptedFileStorage: vi.fn(),
}));

vi.mock('@noble/ed25519', () => ({ signAsync: controls.signAsync }));

vi.mock('@ccd-agent-kit/config-utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ccd-agent-kit/config-utils')>()),
  isEncryptedFileStorageUnlocked: controls.isEncryptedFileStorageUnlocked,
  lockEncryptedFileStorage: controls.lockEncryptedFileStorage,
  loadEncryptedEd25519PrivateKey: controls.loadEncryptedEd25519PrivateKey,
  unlockEncryptedFileStorage: controls.unlockEncryptedFileStorage,
}));

import { softwareSignerModule } from '../../../../src/core/modules/softwareSignerModule.js';
import { testEd25519PublicKeyHex } from '../../../helpers/ed25519.js';

const PUBLIC_KEY = testEd25519PublicKeyHex('d04ab232742bb4ab3a1368bd4615e4e6d0224ab71a016baf8520a332c9778737');
const ENCRYPTED_BACKEND = {
  backend: { keyRef: 'keys/encrypted.json', storageModule: 'encrypted-file' },
  createdAt: '2026-01-01T00:00:00.000Z',
  signingModule: 'software-signer',
  updatedAt: '2026-01-01T00:00:00.000Z',
} as const;

describe('software signer controls', () => {
  beforeEach(() => vi.clearAllMocks());

  it('locks encrypted key storage', async () => {
    await expect(softwareSignerModule.handleControlRequest?.({ request: { type: 'lock' } })).resolves.toEqual({
      ok: true,
      status: 'locked',
    });
    expect(controls.lockEncryptedFileStorage).toHaveBeenCalledOnce();
  });

  it('unlocks encrypted key storage with a non-empty password', async () => {
    await expect(
      softwareSignerModule.handleControlRequest?.({ request: { password: 'secret', type: 'unlock' } }),
    ).resolves.toEqual({ ok: true, status: 'unlocked' });
    expect(controls.unlockEncryptedFileStorage).toHaveBeenCalledWith('secret');
  });

  it('rejects unlock without a password and ignores foreign controls', async () => {
    await expect(
      softwareSignerModule.handleControlRequest?.({ request: { password: '', type: 'unlock' } }),
    ).resolves.toEqual({ error: 'missing-password', ok: false });
    await expect(softwareSignerModule.handleControlRequest?.({ request: { type: 'other' } })).resolves.toBeUndefined();
    expect(controls.unlockEncryptedFileStorage).not.toHaveBeenCalled();
  });

  it('reports encrypted storage readiness from the current lock state', () => {
    controls.isEncryptedFileStorageUnlocked.mockReturnValueOnce(false).mockReturnValueOnce(true);

    expect(softwareSignerModule.getBackendStatus?.(ENCRYPTED_BACKEND, 'Ed25519')).toBe('locked');
    expect(softwareSignerModule.getBackendStatus?.(ENCRYPTED_BACKEND, 'Ed25519')).toBe('unlocked');
  });

  it('loads and signs with the selected encrypted key material', async () => {
    const digest = new Uint8Array([1, 2, 3]);
    const privateKey = new Uint8Array([4, 5, 6]);
    controls.loadEncryptedEd25519PrivateKey.mockReturnValue(privateKey);
    controls.signAsync.mockResolvedValue(new Uint8Array([0xab, 0xcd]));

    await expect(softwareSignerModule.signEd25519Digest({
      backendEntry: ENCRYPTED_BACKEND,
      digest,
      publicKey: PUBLIC_KEY,
    })).resolves.toBe('abcd');
    expect(controls.loadEncryptedEd25519PrivateKey).toHaveBeenCalledWith('keys/encrypted.json', PUBLIC_KEY);
    expect(controls.signAsync).toHaveBeenCalledWith(digest, privateKey);
  });

  it('rejects unsupported storage metadata before attempting any private-key load', async () => {
    const backendEntry = {
      ...ENCRYPTED_BACKEND,
      backend: { keyRef: 'keys/removed.json', storageModule: 'removed-storage' },
    } as const;

    expect(softwareSignerModule.getBackendStatus?.(backendEntry, 'Ed25519')).toBe('unavailable');
    await expect(softwareSignerModule.signEd25519Digest({
      backendEntry,
      digest: new Uint8Array([1, 2, 3]),
      publicKey: PUBLIC_KEY,
    })).rejects.toThrow(/unsupported storage module/i);

    expect(controls.loadEncryptedEd25519PrivateKey).not.toHaveBeenCalled();
  });
});
