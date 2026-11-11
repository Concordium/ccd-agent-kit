import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getPublicKeyAsync } from '@noble/ed25519';
import type { Ed25519PrivateKeyHex, Ed25519PublicKeyHex } from '@ccd-agent-kit/sdk-utils';

import {
  generateLocalEd25519Key,
  importLocalEd25519Key,
  importLocalEd25519KeyFile,
  importSoftwareKeyFile,
  importWalletExportKeys,
} from '../../src/signer/localKeyFiles.js';
import { useConfigSandbox } from '../helpers/configSandbox.js';

const collaborators = vi.hoisted(() => ({
  encryptedConfigured: true,
  encryptedWrite: vi.fn((publicKey: string, _privateKey: string) => `keys/encrypted/${publicKey}.json`),
  generatedSeeds: [] as Buffer[],
  seedCounter: 0,
  storageEnabled: true,
  unlock: vi.fn(),
  upsert: vi.fn(),
}));

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return {
    ...actual,
    randomBytes: (size: number) => {
      const seed = Buffer.alloc(size, ++collaborators.seedCounter);
      collaborators.generatedSeeds.push(seed);
      return seed;
    },
  };
});

vi.mock('../../src/signer/encryptedKeyFiles.js', () => ({
  isEncryptedFileStorageConfigured: () => collaborators.encryptedConfigured,
  unlockEncryptedFileStorage: collaborators.unlock,
  writeEncryptedEd25519KeyFile: collaborators.encryptedWrite,
}));

vi.mock('../../src/signer/inventory.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/signer/inventory.js')>();
  return {
    ...actual,
    createSignerInventoryUpdater: () => ({ upsert: collaborators.upsert }),
  };
});

vi.mock('../../src/signer/moduleConfig.js', () => ({
  isSoftwareStorageModuleEnabled: () => collaborators.storageEnabled,
}));

const PRIVATE_KEY = 'a1'.repeat(32) as Ed25519PrivateKeyHex;
const SECOND_PRIVATE_KEY = 'b2'.repeat(32) as Ed25519PrivateKeyHex;
const ADDRESS = '3DPgLSmDKt7tvAybE95obMXANrUChv5aBpzGPU3qjaG7ERG6JC';

async function publicKey(privateKey = PRIVATE_KEY): Promise<Ed25519PublicKeyHex> {
  return Buffer.from(await getPublicKeyAsync(privateKey)).toString('hex') as Ed25519PublicKeyHex;
}

describe('local software key files', () => {
  useConfigSandbox();

  beforeEach(() => {
    collaborators.encryptedConfigured = true;
    collaborators.generatedSeeds.length = 0;
    collaborators.seedCounter = 0;
    collaborators.storageEnabled = true;
    vi.clearAllMocks();
    collaborators.encryptedWrite.mockReset();
    collaborators.encryptedWrite.mockImplementation((publicKey: string) => `keys/encrypted/${publicKey}.json`);
    collaborators.unlock.mockReset();
    collaborators.upsert.mockReset();
  });

  it('validates and canonicalizes a raw private key before encrypted storage and inventory updates', async () => {
    const key = await publicKey();

    await expect(importLocalEd25519Key({
      privateKeyHex: PRIVATE_KEY.toUpperCase(), label: ' key ', storagePassword: 'password',
    })).resolves.toEqual({ publicKey: key, keyRef: `keys/encrypted/${key}.json` });

    expect(collaborators.unlock).toHaveBeenCalledWith('password');
    expect(collaborators.encryptedWrite).toHaveBeenCalledWith(key, PRIVATE_KEY);
    expect(collaborators.upsert).toHaveBeenCalledWith(expect.objectContaining({
      publicKey: key,
      label: 'key',
      backend: { keyRef: `keys/encrypted/${key}.json`, storageModule: 'encrypted-file' },
    }));

    collaborators.encryptedWrite.mockClear();
    collaborators.upsert.mockClear();
    await expect(importLocalEd25519Key({ privateKeyHex: 'not-a-key' })).rejects.toThrow();
    expect(collaborators.encryptedWrite).not.toHaveBeenCalled();
    expect(collaborators.upsert).not.toHaveBeenCalled();
  });

  it('rejects an untyped unsupported storage selector before reading import material', async () => {
    await expect(importSoftwareKeyFile({
      filePath: join(process.env.XDG_DATA_HOME!, 'missing-secret.json'),
      storage: 'removed-storage' as 'encrypted-file',
    })).rejects.toThrow(/storage module.*not supported/i);

    expect(collaborators.unlock).not.toHaveBeenCalled();
    expect(collaborators.encryptedWrite).not.toHaveBeenCalled();
    expect(collaborators.upsert).not.toHaveBeenCalled();
  });

  it('generates unique Ed25519 material directly into encrypted storage', async () => {
    const first = await generateLocalEd25519Key({ label: ' generated ', storagePassword: 'password' });
    const second = await generateLocalEd25519Key({ storagePassword: 'password' });

    expect(first).toEqual({ publicKey: expect.stringMatching(/^[0-9a-f]{64}$/), keyRef: `keys/encrypted/${first.publicKey}.json` });
    expect(second).toEqual({ publicKey: expect.stringMatching(/^[0-9a-f]{64}$/), keyRef: `keys/encrypted/${second.publicKey}.json` });
    expect(first.publicKey).not.toBe(second.publicKey);
    expect(first).not.toHaveProperty('privateKey');
    expect(first).not.toHaveProperty('privateKeyHex');
    expect(collaborators.unlock).toHaveBeenNthCalledWith(1, 'password');
    expect(collaborators.unlock).toHaveBeenNthCalledWith(2, 'password');
    expect(collaborators.encryptedWrite).toHaveBeenCalledTimes(2);
    expect(collaborators.upsert).toHaveBeenNthCalledWith(1, expect.objectContaining({
      publicKey: first.publicKey,
      label: 'generated',
      backend: { keyRef: first.keyRef, storageModule: 'encrypted-file' },
    }));
    const [firstStoredPublic, firstStoredPrivate] = collaborators.encryptedWrite.mock.calls[0]!;
    expect(firstStoredPublic).toBe(first.publicKey);
    expect(await publicKey(firstStoredPrivate as Ed25519PrivateKeyHex)).toBe(first.publicKey);
    expect(collaborators.generatedSeeds).toHaveLength(2);
    expect(collaborators.generatedSeeds.every(seed => seed.length === 32)).toBe(true);
    expect(collaborators.generatedSeeds.every(seed => seed.every(byte => byte === 0))).toBe(true);
  });

  it('rejects generation when storage is disabled, uninitialized, or cannot be unlocked without writing', async () => {
    collaborators.storageEnabled = false;
    await expect(generateLocalEd25519Key()).rejects.toThrow(/disabled/i);

    collaborators.storageEnabled = true;
    collaborators.encryptedConfigured = false;
    await expect(generateLocalEd25519Key({ storagePassword: 'password' })).rejects.toThrow(/not initialized/i);

    collaborators.encryptedConfigured = true;
    collaborators.unlock.mockImplementationOnce(() => { throw new Error('unlock failed'); });
    await expect(generateLocalEd25519Key({ storagePassword: 'wrong' })).rejects.toThrow(/unlock/i);

    expect(collaborators.encryptedWrite).not.toHaveBeenCalled();
    expect(collaborators.upsert).not.toHaveBeenCalled();
  });

  it('wipes generated private bytes when protected storage persistence fails', async () => {
    collaborators.encryptedWrite.mockImplementationOnce(() => { throw new Error('storage failed'); });

    await expect(generateLocalEd25519Key({ storagePassword: 'password' })).rejects.toThrow(/storage failed/i);

    expect(collaborators.upsert).not.toHaveBeenCalled();
    expect(collaborators.generatedSeeds).toHaveLength(1);
    expect(collaborators.generatedSeeds[0]?.every(byte => byte === 0)).toBe(true);
  });

  it('imports a native key file and rejects malformed variants before writing', async () => {
    const key = await publicKey();
    const source = sourceFile('native-key.json');

    writeFileSync(source, JSON.stringify({ scheme: 'Ed25519', signKey: PRIVATE_KEY, verifyKey: key }));
    await expect(importLocalEd25519KeyFile({ filePath: source })).resolves.toEqual({
      publicKey: key, keyRef: `keys/encrypted/${key}.json`,
    });
    collaborators.encryptedWrite.mockClear();
    collaborators.upsert.mockClear();

    for (const document of [
      [],
      { schema: 'Ed25519', signKey: PRIVATE_KEY, verifyKey: key },
      { scheme: 'Ed25519', signKey: PRIVATE_KEY, verifyKey: '22'.repeat(32) },
    ]) {
      writeFileSync(source, JSON.stringify(document));
      await expect(importLocalEd25519KeyFile({ filePath: source })).rejects.toThrow();
    }

    expect(collaborators.encryptedWrite).not.toHaveBeenCalled();
    expect(collaborators.upsert).not.toHaveBeenCalled();
  });

  it('detects malformed JSON and native key candidates without falling through to wallet parsing', async () => {
    const source = sourceFile('detected-key.json');
    for (const document of [
      '{bad',
      JSON.stringify({ scheme: 'Ed25519', signKey: PRIVATE_KEY, verifyKey: '22'.repeat(32) }),
    ]) {
      writeFileSync(source, document);
      await expect(importSoftwareKeyFile({ filePath: source })).rejects.toThrow();
    }
    expect(collaborators.encryptedWrite).not.toHaveBeenCalled();
    expect(collaborators.upsert).not.toHaveBeenCalled();
  });

  it('imports wallet keys in numeric order with validated generated labels', async () => {
    const [keyA, keyB] = await Promise.all([publicKey(), publicKey(SECOND_PRIVATE_KEY)]);
    const source = sourceFile('wallet.export');
    writeFileSync(source, walletJson([
      ['10', SECOND_PRIVATE_KEY, keyB],
      ['2', PRIVATE_KEY, keyA],
    ]));

    await expect(importSoftwareKeyFile({ filePath: source, label: ' wallet ' })).resolves.toEqual({
      kind: 'wallet-export', address: ADDRESS, publicKeys: [keyA, keyB],
    });
    expect(collaborators.encryptedWrite.mock.calls.map(([key]) => key)).toEqual([keyA, keyB]);
    expect(collaborators.upsert.mock.calls.map(([entry]) => entry.label)).toEqual(['wallet-0', 'wallet-1']);
  });

  it('validates every wallet key and generated label before any durable write', async () => {
    const keyA = await publicKey();
    const source = sourceFile('invalid-wallet.export');
    writeFileSync(source, walletJson([
      ['0', PRIVATE_KEY, keyA],
      ['1', SECOND_PRIVATE_KEY, '33'.repeat(32) as Ed25519PublicKeyHex],
    ]));
    await expect(importWalletExportKeys({ filePath: source })).rejects.toThrow(/does not match/i);

    const keyB = await publicKey(SECOND_PRIVATE_KEY);
    writeFileSync(source, walletJson([
      ['0', PRIVATE_KEY, keyA],
      ['1', SECOND_PRIVATE_KEY, keyB],
    ]));
    await expect(importWalletExportKeys({ filePath: source, label: `A${'b'.repeat(48)}` })).rejects.toThrow();

    expect(collaborators.encryptedWrite).not.toHaveBeenCalled();
    expect(collaborators.upsert).not.toHaveBeenCalled();
  });

  it('rejects unsupported wallet content and disabled or uninitialized storage without writes', async () => {
    const source = sourceFile('empty-wallet.export');
    writeFileSync(source, JSON.stringify({ value: { address: ADDRESS, accountKeys: { keys: {} } } }));
    await expect(importSoftwareKeyFile({ filePath: source })).rejects.toThrow(/does not contain any/i);

    writeFileSync(source, JSON.stringify({ value: { accountKeys: { keys: {} } } }));
    await expect(importWalletExportKeys({ filePath: source })).rejects.toThrow(/address/i);

    collaborators.storageEnabled = false;
    await expect(importLocalEd25519Key({ privateKeyHex: PRIVATE_KEY })).rejects.toThrow(/disabled/i);
    collaborators.storageEnabled = true;
    collaborators.encryptedConfigured = false;
    await expect(importLocalEd25519Key({ privateKeyHex: PRIVATE_KEY })).rejects.toThrow(/not initialized/i);

    expect(collaborators.encryptedWrite).not.toHaveBeenCalled();
    expect(collaborators.upsert).not.toHaveBeenCalled();
  });

});

function sourceFile(name: string): string {
  mkdirSync(process.env.XDG_DATA_HOME!, { recursive: true });
  return join(process.env.XDG_DATA_HOME!, name);
}

function walletJson(keys: Array<[string, string, Ed25519PublicKeyHex]>): string {
  return JSON.stringify({
    type: 'concordium-browser-wallet-account', v: 0, environment: 'mainnet',
    value: {
      address: ADDRESS,
      credentials: { '0': 'aa'.repeat(32) },
      accountKeys: {
        keys: { '0': {
          keys: Object.fromEntries(keys.map(([index, signKey, verifyKey]) => [index, { signKey, verifyKey }])),
          threshold: 1,
        } },
        threshold: 1,
      },
    },
  });
}
