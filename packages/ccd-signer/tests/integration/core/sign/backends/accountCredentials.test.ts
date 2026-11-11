import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountCredentialObservation } from '@ccd-agent-kit/config-utils';

vi.mock('@noble/ed25519', () => ({
  signAsync: vi.fn(async () => new Uint8Array(64).fill(0x5a)),
}));

import { signAsync } from '@noble/ed25519';

import {
  setSigningModulePolicy,
  upsertSignerInventoryKey,
} from '@ccd-agent-kit/config-utils';
import { initializeEncryptedFileStorage, isEncryptedFileStorageConfigured, lockEncryptedFileStorage, unlockEncryptedFileStorage, writeEncryptedEd25519KeyFile } from '@ccd-agent-kit/config-utils';
import {
  AccountCredentialsSigningBackend,
  hasAvailableObservedCredentialKey,
} from '../../../../../src/core/sign/backends/accountCredentials.js';
import { makeTestTempDir } from '../../../../helpers/tempDir.js';
import { testEd25519PrivateKey, testEd25519PublicKeyHex } from '../../../../helpers/ed25519.js';
import type { Ed25519PublicKeyHex } from '@ccd-agent-kit/sdk-utils';

const LOCAL_PUBLIC_KEY = testEd25519PublicKeyHex('e734ea6c2b6257de72355e472aa05a4c487e6b463c029ed306df2f01b5636b58');
const SECOND_PUBLIC_KEY = testEd25519PublicKeyHex('7d59c5623dd40a74aa4d5a32ac645d3b3f95daeae4c22be25476dd6a486f7382');
const DIGEST = new Uint8Array([1, 2, 3]);

describe('AccountCredentialsSigningBackend', () => {
  let tempDir: string;
  let originalData: string | undefined;
  let originalState: string | undefined;
  let originalConfig: string | undefined;

  beforeEach(() => {
    originalData = process.env.XDG_DATA_HOME;
    originalState = process.env.XDG_STATE_HOME;
    originalConfig = process.env.XDG_CONFIG_HOME;
    tempDir = makeTestTempDir('account-credentials-backend-');
    process.env.XDG_DATA_HOME = join(tempDir, 'data');
    process.env.XDG_STATE_HOME = join(tempDir, 'state');
    process.env.XDG_CONFIG_HOME = join(tempDir, 'config');
    mkdirSync(join(process.env.XDG_CONFIG_HOME, 'ccd-agent-kit', 'signer'), { recursive: true, mode: 0o700 });
  });

  afterEach(() => {
    setSigningModulePolicy('software-signer', 'enabled');
    lockEncryptedFileStorage();
    rmSync(tempDir, { recursive: true, force: true });
    if (originalData !== undefined) process.env.XDG_DATA_HOME = originalData;
    else delete process.env.XDG_DATA_HOME;
    if (originalState !== undefined) process.env.XDG_STATE_HOME = originalState;
    else delete process.env.XDG_STATE_HOME;
    if (originalConfig !== undefined) process.env.XDG_CONFIG_HOME = originalConfig;
    else delete process.env.XDG_CONFIG_HOME;
  });

  it('discovers an observed encrypted inventory key and signs through the software module', async () => {
    writeLocalKey(LOCAL_PUBLIC_KEY);
    const observation = observationWithKey(LOCAL_PUBLIC_KEY);
    const backend = new AccountCredentialsSigningBackend(observation);

    expect(hasAvailableObservedCredentialKey(observation)).toBe(true);
    await expect(backend.createSignature(request())).resolves.toEqual({ '0': { '0': '5a'.repeat(64) } });
  });

  it('requires encrypted-file storage to be unlocked before signing encrypted local keys', async () => {
    initializeEncryptedFileStorage('pw');
    const keyRef = writeEncryptedEd25519KeyFile(LOCAL_PUBLIC_KEY, testEd25519PrivateKey('aa'));
    upsertSignerInventoryKey({ backend: { keyRef, storageModule: 'encrypted-file' }, publicKey: LOCAL_PUBLIC_KEY, scheme: 'Ed25519', signingModule: 'software-signer' });
    lockEncryptedFileStorage();
    const backend = new AccountCredentialsSigningBackend(observationWithKey(LOCAL_PUBLIC_KEY));

    await expect(backend.createSignature(request())).rejects.toThrow('ENCRYPTED_STORAGE_LOCKED');

    unlockEncryptedFileStorage('pw');
    await expect(backend.createSignature(request())).resolves.toEqual({ '0': { '0': '5a'.repeat(64) } });
  });

  it('rechecks module policy before each awaited signature instead of using a stale key snapshot', async () => {
    writeLocalKey(LOCAL_PUBLIC_KEY);
    writeLocalKey(SECOND_PUBLIC_KEY);
    vi.mocked(signAsync).mockImplementationOnce(async () => {
      setSigningModulePolicy('software-signer', 'disabled');
      return new Uint8Array(64).fill(0x5a);
    });
    const backend = new AccountCredentialsSigningBackend(observationWithKey(LOCAL_PUBLIC_KEY, SECOND_PUBLIC_KEY));

    await expect(backend.createSignature(request({ maxSignatures: 2, missingSignatures: 2 }))).rejects.toThrow();
  });
});

function request(input: Partial<Parameters<AccountCredentialsSigningBackend['createSignature']>[0]> = {}) {
  return {
    digest: DIGEST,
    existingSignatures: {},
    missingSignatures: 1,
    role: 'sender' as const,
    ...input,
  };
}

function observationWithKey(...publicKeys: Ed25519PublicKeyHex[]): AccountCredentialObservation {
  return {
    accountThreshold: '1',
    credentials: {
      '0': {
        keys: Object.fromEntries(publicKeys.map((publicKey, index) => [String(index), { publicKey, scheme: 'Ed25519' }])),
        threshold: '1',
      },
    },
    sourceBlock: { hash: '22'.repeat(32), height: '1', time: '2026-09-25T00:00:00.000Z' },
  };
}

function writeLocalKey(publicKey: Ed25519PublicKeyHex): void {
  if (!isEncryptedFileStorageConfigured()) initializeEncryptedFileStorage('pw');
  const privateKey = publicKey === LOCAL_PUBLIC_KEY ? 'aa'.repeat(32) : 'bb'.repeat(32);
  const keyRef = writeEncryptedEd25519KeyFile(publicKey, testEd25519PrivateKey(privateKey.slice(0, 2)));
  upsertSignerInventoryKey({ backend: { keyRef, storageModule: 'encrypted-file' }, publicKey, scheme: 'Ed25519', signingModule: 'software-signer' });
}
