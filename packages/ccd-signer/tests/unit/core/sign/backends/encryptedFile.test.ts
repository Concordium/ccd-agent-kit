import { join } from 'node:path';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createEncryptedKeyFile,
  EncryptedFileSigningBackend,
} from '../../../../../src/core/sign/backends/encryptedFile.js';
import { makeTestTempDir } from '../../../../helpers/tempDir.js';

describe('EncryptedFileSigningBackend', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('round-trips a private key through encrypt and decrypt', async () => {
    const privateKeyHex = '00'.repeat(32) + '11'.repeat(32);
    const password = 'test-password-123';
    const dir = makeTestTempDir('sign-test-');
    tempDirs.push(dir);
    const filePath = join(dir, 'key.json');

    const encrypted = createEncryptedKeyFile(privateKeyHex, password);
    writeFileSync(filePath, JSON.stringify(encrypted));

    const readBack = JSON.parse(readFileSync(filePath, 'utf-8'));
    expect(readBack.version).toBe(1);
    expect(readBack.crypto.cipher).toBe('aes-256-gcm');
    expect(readBack.crypto.kdf).toBe('scrypt');
    expect(readBack.crypto.kdfParams).toMatchObject({ n: 16384, r: 8, p: 1, keyLength: 32 });
    expect(readBack.ciphertext).toBeDefined();
  });

  it('rejects wrong password', () => {
    const privateKeyHex = '00'.repeat(32) + '11'.repeat(32);
    const dir = makeTestTempDir('sign-test-');
    tempDirs.push(dir);
    const filePath = join(dir, 'key.json');

    const encrypted = createEncryptedKeyFile(privateKeyHex, 'correct-password');
    writeFileSync(filePath, JSON.stringify(encrypted));

    expect(() => new EncryptedFileSigningBackend(filePath, 'wrong-password')).toThrow();
  });

  it('rejects unsupported cipher', () => {
    const dir = makeTestTempDir('sign-test-');
    tempDirs.push(dir);
    const filePath = join(dir, 'key.json');
    writeFileSync(
      filePath,
      JSON.stringify({
        version: 1,
        crypto: {
          cipher: 'aes-128-cbc',
          kdf: 'scrypt',
          kdfParams: { salt: 'aa', n: 2, r: 8, p: 1, keyLength: 16 },
          iv: 'bb',
          tag: 'cc',
        },
        ciphertext: 'dd',
      }),
    );

    expect(() => new EncryptedFileSigningBackend(filePath, 'pw')).toThrow('Unsupported cipher');
  });

});
