import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { getPublicKeyAsync } from '@noble/ed25519';
import type { Ed25519PrivateKeyHex, Ed25519PublicKeyHex } from '@ccd-agent-kit/sdk-utils';

import {
  changeEncryptedFileStoragePassword,
  getSignerDataDir,
  getSignerKeyStorageDir,
  initializeEncryptedFileStorage,
  isEncryptedFileStorageConfigured,
  isEncryptedFileStorageUnlocked,
  loadEncryptedEd25519PrivateKey,
  lockEncryptedFileStorage,
  unlockEncryptedFileStorage,
  writeEncryptedEd25519KeyFile,
} from '../../src/index.js';
import { useConfigSandbox } from '../helpers/configSandbox.js';

const PRIVATE_KEY = '11'.repeat(32) as Ed25519PrivateKeyHex;

async function publicKey(privateKey = PRIVATE_KEY): Promise<Ed25519PublicKeyHex> {
  return Buffer.from(await getPublicKeyAsync(privateKey)).toString('hex') as Ed25519PublicKeyHex;
}

describe('shared encrypted software-key storage', () => {
  useConfigSandbox();
  afterEach(() => lockEncryptedFileStorage());

  it('persists the stable scrypt/AES-GCM schema without plaintext and round-trips owned bytes', async () => {
    const key = await publicKey();
    initializeEncryptedFileStorage('password');
    const reference = writeEncryptedEd25519KeyFile(key, PRIVATE_KEY);
    const state = JSON.parse(readFileSync(join(getSignerKeyStorageDir(), 'encrypted-file.json'), 'utf8')) as Record<string, any>;
    const encrypted = JSON.parse(readFileSync(join(getSignerDataDir(), reference), 'utf8')) as Record<string, any>;

    expect(state).toMatchObject({
      version: 1,
      type: 'ccd-signer.encrypted-file-storage',
      kdf: { name: 'scrypt', n: 16384, r: 8, p: 1, keyLength: 32 },
      encryptedStorageKey: { cipher: 'aes-256-gcm' },
      verifier: { cipher: 'aes-256-gcm' },
    });
    expect(encrypted).toMatchObject({ version: 1, type: 'ccd-signer.ed25519-key', cipher: 'aes-256-gcm' });
    expect(JSON.stringify({ state, encrypted })).not.toContain(PRIVATE_KEY);
    const first = loadEncryptedEd25519PrivateKey(reference, key);
    const second = loadEncryptedEd25519PrivateKey(reference, key);
    first.fill(0);
    expect(Buffer.from(second).toString('hex')).toBe(PRIVATE_KEY);
  });

  it('has explicit initialization, lock, unlock, password-change, and stable locked behavior', async () => {
    const key = await publicKey();
    expect(isEncryptedFileStorageConfigured()).toBe(false);
    expect(() => unlockEncryptedFileStorage('password')).toThrow(/not initialized/i);
    expect(() => changeEncryptedFileStoragePassword('old', 'new')).toThrow(/not initialized/i);
    expect(() => initializeEncryptedFileStorage('')).toThrow(/empty/i);
    initializeEncryptedFileStorage('old');
    expect(isEncryptedFileStorageConfigured()).toBe(true);
    expect(isEncryptedFileStorageUnlocked()).toBe(true);
    const reference = writeEncryptedEd25519KeyFile(key, PRIVATE_KEY);
    lockEncryptedFileStorage();
    expect(isEncryptedFileStorageUnlocked()).toBe(false);
    expect(() => loadEncryptedEd25519PrivateKey(reference, key)).toThrow('ENCRYPTED_STORAGE_LOCKED');
    expect(() => unlockEncryptedFileStorage('wrong')).toThrow(/incorrect/i);
    changeEncryptedFileStoragePassword('old', 'new');
    lockEncryptedFileStorage();
    expect(() => unlockEncryptedFileStorage('old')).toThrow(/incorrect/i);
    unlockEncryptedFileStorage('new');
    expect(Buffer.from(loadEncryptedEd25519PrivateKey(reference, key)).toString('hex')).toBe(PRIVATE_KEY);
    expect(() => initializeEncryptedFileStorage('again')).toThrow(/already initialized/i);
  });

  it('binds encrypted key files to the expected public key and rejects unsafe references', async () => {
    const key = await publicKey();
    const other = await publicKey('22'.repeat(32) as Ed25519PrivateKeyHex);
    initializeEncryptedFileStorage('password');
    const mismatchedReference = writeEncryptedEd25519KeyFile(key, '33'.repeat(32) as Ed25519PrivateKeyHex);
    expect(() => loadEncryptedEd25519PrivateKey(mismatchedReference, key)).toThrow(/does not match/i);
    const reference = writeEncryptedEd25519KeyFile(key, PRIVATE_KEY);
    expect(() => loadEncryptedEd25519PrivateKey(reference, other)).toThrow(/public key|match/i);
    expect(() => loadEncryptedEd25519PrivateKey('../outside.json', key)).toThrow(/reference/i);
    expect(() => loadEncryptedEd25519PrivateKey('/absolute.json', key)).toThrow(/reference/i);
    const missingReference = join('keys', 'ed25519-encrypted', `${other}.json`);
    expect(() => loadEncryptedEd25519PrivateKey(missingReference, other)).toThrow(/not found/i);
  });

  it('rejects unsupported or malformed state and key-file envelopes', async () => {
    const key = await publicKey();
    const statePath = join(getSignerKeyStorageDir(), 'encrypted-file.json');
    initializeEncryptedFileStorage('password');
    const reference = join('keys', 'ed25519-encrypted', `${key}.json`);
    const filename = join(getSignerDataDir(), reference);
    mkdirSync(dirname(filename), { recursive: true });
    for (const value of [
      null,
      { version: 2, type: 'ccd-signer.ed25519-key', cipher: 'aes-256-gcm' },
      { version: 1, type: 'ccd-signer.ed25519-key', cipher: 'aes-256-gcm' },
    ]) {
      writeFileSync(filename, JSON.stringify(value), { mode: 0o600 });
      expect(() => loadEncryptedEd25519PrivateKey(reference, key)).toThrow();
    }
    lockEncryptedFileStorage();
    writeFileSync(statePath, JSON.stringify({ version: 1, type: 'wrong', kdf: { name: 'scrypt' } }), { mode: 0o600 });
    expect(() => unlockEncryptedFileStorage('password')).toThrow(/not supported/i);
    writeFileSync(statePath, '{bad', { mode: 0o600 });
    expect(() => unlockEncryptedFileStorage('password')).toThrow();
  });

  it('rejects malformed-length and unauthenticated key-file ciphertext before returning key bytes', async () => {
    const key = await publicKey();
    initializeEncryptedFileStorage('password');
    const reference = writeEncryptedEd25519KeyFile(key, PRIVATE_KEY);
    const filename = join(getSignerDataDir(), reference);
    const encrypted = JSON.parse(readFileSync(filename, 'utf8')) as Record<string, any>;

    writeFileSync(filename, JSON.stringify({ ...encrypted, cipherText: 'aa' }), { mode: 0o600 });
    expect(() => loadEncryptedEd25519PrivateKey(reference, key)).toThrow(/malformed/i);

    const cipherText = encrypted.cipherText as string;
    const replacement = cipherText.endsWith('00') ? 'ff' : '00';
    writeFileSync(filename, JSON.stringify({ ...encrypted, cipherText: `${cipherText.slice(0, -2)}${replacement}` }), { mode: 0o600 });
    expect(() => loadEncryptedEd25519PrivateKey(reference, key)).toThrow();
  });
});
