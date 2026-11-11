import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { getPublicKeyAsync } from '@noble/ed25519';
import type { Ed25519PublicKeyHex } from '@ccd-agent-kit/sdk-utils';

import {
  getSignerDataDir,
  importLocalEd25519Key,
  initializeEncryptedFileStorage,
  lockEncryptedFileStorage,
} from '../../src/index.js';
import { useConfigSandbox } from '../helpers/configSandbox.js';

const PRIVATE_KEY = 'a1'.repeat(32);

async function publicKey(): Promise<Ed25519PublicKeyHex> {
  return Buffer.from(await getPublicKeyAsync(PRIVATE_KEY)).toString('hex') as Ed25519PublicKeyHex;
}

describe('shared software key import', () => {
  useConfigSandbox();
  afterEach(() => lockEncryptedFileStorage());

  it('requires initialized encrypted storage and writes no plaintext when explicitly unlocked', async () => {
    const key = await publicKey();
    await expect(importLocalEd25519Key({ privateKeyHex: PRIVATE_KEY, storage: 'encrypted-file' })).rejects.toThrow(/not initialized/i);
    initializeEncryptedFileStorage('password');
    lockEncryptedFileStorage();
    const result = await importLocalEd25519Key({ privateKeyHex: PRIVATE_KEY, storage: 'encrypted-file', storagePassword: 'password' });
    expect(result.publicKey).toBe(key);
    expect(readFileSync(join(getSignerDataDir(), result.keyRef), 'utf8')).not.toContain(PRIVATE_KEY);
  });

});
