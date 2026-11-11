import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Ed25519PublicKeyHex } from '@ccd-agent-kit/sdk-utils';

import { adoptEncryptedFileKey, checkEncryptedFileIntegrity } from '../../src/signer/encryptedFileIntegrity.js';
import { getSignerDataDir, getSignerInventoryPath } from '../../src/paths.js';
import type { SignerInventory } from '../../src/signer/inventory.js';
import { useConfigSandbox } from '../helpers/configSandbox.js';

const inventory = vi.hoisted(() => ({
  load: vi.fn<() => SignerInventory>(),
  save: vi.fn(),
  upsert: vi.fn(),
}));
const encryptedKeyFiles = vi.hoisted(() => ({ load: vi.fn() }));
const moduleConfig = vi.hoisted(() => ({ enabled: vi.fn() }));

vi.mock('../../src/signer/inventory.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/signer/inventory.js')>();
  return {
    ...actual,
    loadSignerInventory: inventory.load,
    saveSignerInventory: inventory.save,
    createSignerInventoryUpdater: () => ({ getEntry: vi.fn(), upsert: inventory.upsert }),
  };
});

vi.mock('../../src/signer/encryptedKeyFiles.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/signer/encryptedKeyFiles.js')>();
  return { ...actual, loadEncryptedEd25519PrivateKey: encryptedKeyFiles.load };
});

vi.mock('../../src/signer/moduleConfig.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/signer/moduleConfig.js')>();
  return { ...actual, isSoftwareStorageModuleEnabled: moduleConfig.enabled };
});

const PUBLIC_KEY = '11'.repeat(32) as Ed25519PublicKeyHex;
const ENCRYPTED_KEY_DIRECTORY = join('keys', 'ed25519-encrypted');

function signerInventory(keys: SignerInventory['keys'] = {}): SignerInventory {
  return { version: 1, updatedAt: '2026-01-01T00:00:00.000Z', keys };
}

describe('encrypted storage integrity local decisions', () => {
  useConfigSandbox();

  beforeEach(() => {
    vi.clearAllMocks();
    inventory.load.mockReturnValue(signerInventory());
    moduleConfig.enabled.mockReturnValue(true);
  });

  it('clears a verified key before adopting its canonical reference and optional label', () => {
    const privateKey = Uint8Array.from({ length: 32 }, () => 7);
    encryptedKeyFiles.load.mockReturnValue(privateKey);
    inventory.upsert.mockImplementation(() => expect(privateKey).toEqual(new Uint8Array(32)));

    adoptEncryptedFileKey({ publicKey: PUBLIC_KEY, label: ' recovered ' });

    const keyRef = join(ENCRYPTED_KEY_DIRECTORY, `${PUBLIC_KEY}.json`);
    expect(encryptedKeyFiles.load).toHaveBeenCalledWith(keyRef, PUBLIC_KEY);
    expect(inventory.upsert).toHaveBeenCalledWith({
      publicKey: PUBLIC_KEY,
      scheme: 'Ed25519',
      signingModule: 'software-signer',
      backend: { keyRef, storageModule: 'encrypted-file' },
      label: ' recovered ',
    });
  });

  it('preserves a loader error and does not update the inventory', () => {
    const error = new Error('verified loader failure');
    encryptedKeyFiles.load.mockImplementation(() => { throw error; });

    try {
      adoptEncryptedFileKey({ publicKey: PUBLIC_KEY });
      expect.unreachable('adoption should propagate the loader error');
    } catch (caught) {
      expect(caught).toBe(error);
    }
    expect(inventory.upsert).not.toHaveBeenCalled();
  });

  it.each([
    [false, PUBLIC_KEY, /disabled/i],
    [true, '../outside' as Ed25519PublicKeyHex, /public key/i],
  ])('rejects disabled storage or invalid key selectors before file access', (enabled, publicKey, error) => {
    moduleConfig.enabled.mockReturnValue(enabled);

    expect(() => adoptEncryptedFileKey({ publicKey })).toThrow(error);
    expect(encryptedKeyFiles.load).not.toHaveBeenCalled();
    expect(inventory.upsert).not.toHaveBeenCalled();
  });

  it('treats references as missing when the encrypted key directory is absent', async () => {
    const keyReference: keyof SignerInventory['keys'] = `ed25519:${PUBLIC_KEY}`;
    const keys: SignerInventory['keys'] = {
      [keyReference]: {
        scheme: 'Ed25519',
        backends: [{
          signingModule: 'software-signer',
          backend: { storageModule: 'encrypted-file', keyRef: join(ENCRYPTED_KEY_DIRECTORY, `${PUBLIC_KEY}.json`) },
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        }],
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    };
    inventory.load.mockReturnValue(signerInventory(keys));

    expect(existsSync(join(getSignerDataDir(), ENCRYPTED_KEY_DIRECTORY))).toBe(false);

    await expect(checkEncryptedFileIntegrity({ fix: false })).resolves.toMatchObject({
      okReferences: [],
      missingReferences: [{ publicKey: PUBLIC_KEY }],
      adoptableOrphans: [],
      invalidEntries: [],
    });
    expect(inventory.upsert).not.toHaveBeenCalled();
    expect(inventory.save).not.toHaveBeenCalled();
  });

  it('leaves absent storage and catalog state untouched for a no-op repair', async () => {
    await expect(checkEncryptedFileIntegrity({ fix: true })).resolves.toEqual({
      okReferences: [],
      missingReferences: [],
      adoptableOrphans: [],
      invalidEntries: [],
      prunedMissingReferences: [],
    });
    expect(existsSync(join(getSignerDataDir(), 'keys', 'ed25519-encrypted'))).toBe(false);
    expect(existsSync(getSignerInventoryPath())).toBe(false);
    expect(inventory.upsert).not.toHaveBeenCalled();
    expect(inventory.save).not.toHaveBeenCalled();
  });
});
