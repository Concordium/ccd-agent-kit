import { join } from 'node:path';
import { chmodSync, mkdirSync } from 'node:fs';
import {
  initializeEncryptedFileStorage,
  isEncryptedFileStorageConfigured,
  setAccountCredentialObservation,
  upsertSignerInventoryKey,
  writeEncryptedEd25519KeyFile,
  type SignerInventoryKeyEntry,
} from '@ccd-agent-kit/config-utils';
import { registerSignerModule } from '../../src/core/modules/registry.js';
import type { SignerBackendStatus, SignerModule } from '../../src/core/modules/types.js';
import { testEd25519PublicKeyHex } from './ed25519.js';
import { ed25519PrivateKey } from '@ccd-agent-kit/sdk-utils';

export function softwareEntry(keyRef = join('keys', 'ed25519-encrypted', 'key.json')): SignerInventoryKeyEntry {
  return {
    backends: [
      {
        backend: { keyRef, storageModule: 'encrypted-file' },
        createdAt: '2026-09-25T00:00:00.000Z',
        signingModule: 'software-signer',
        updatedAt: '2026-09-25T00:00:00.000Z',
      },
    ],
    createdAt: '2026-09-25T00:00:00.000Z',
    scheme: 'Ed25519',
    updatedAt: '2026-09-25T00:00:00.000Z',
  };
}

export function encryptedSoftwareEntry(keyRef = join('keys', 'ed25519-encrypted', 'key.json')): SignerInventoryKeyEntry {
  return {
    backends: [
      {
        backend: { keyRef, storageModule: 'encrypted-file' },
        createdAt: '2026-09-25T00:00:00.000Z',
        signingModule: 'software-signer',
        updatedAt: '2026-09-25T00:00:00.000Z',
      },
    ],
    createdAt: '2026-09-25T00:00:00.000Z',
    scheme: 'Ed25519',
    updatedAt: '2026-09-25T00:00:00.000Z',
  };
}

export function yubiKeyEntry(): SignerInventoryKeyEntry {
  return {
    backends: [
      {
        backend: { devices: [{ kind: 'yubikey', serial: '39713352', slot: '82' }] },
        createdAt: '2026-09-25T00:00:00.000Z',
        signingModule: 'yubikey-piv',
        updatedAt: '2026-09-25T00:00:00.000Z',
      },
    ],
    createdAt: '2026-09-25T00:00:00.000Z',
    scheme: 'Ed25519',
    updatedAt: '2026-09-25T00:00:00.000Z',
  };
}

export function writeEncryptedKey(publicKey: string, privateKey = 'ab'.repeat(32)): string {
  const appRoot = join(process.env.XDG_DATA_HOME!, 'ccd-agent-kit');
  const signerRoot = join(appRoot, 'signer');
  mkdirSync(signerRoot, { recursive: true, mode: 0o700 });
  chmodSync(appRoot, 0o700);
  chmodSync(signerRoot, 0o700);
  if (!isEncryptedFileStorageConfigured()) initializeEncryptedFileStorage('test-password');
  const keyRef = writeEncryptedEd25519KeyFile(testEd25519PublicKeyHex(publicKey), ed25519PrivateKey.require(privateKey));
  upsertSignerInventoryKey({ backend: { keyRef, storageModule: 'encrypted-file' }, publicKey: testEd25519PublicKeyHex(publicKey), scheme: 'Ed25519', signingModule: 'software-signer' });
  return keyRef;
}

export function setObservedEd25519Key(address: string, caip2Ref: string, publicKey: string): void {
  setAccountCredentialObservation(
    address,
    {
      accountThreshold: '1',
      credentials: { '0': { keys: { '0': { publicKey: testEd25519PublicKeyHex(publicKey), scheme: 'Ed25519' } }, threshold: '1' } },
      sourceBlock: { hash: '11'.repeat(32), height: '123', time: '2026-09-24T00:00:00.000Z' },
    },
    caip2Ref,
  );
}

export function registerStatusModule(id: string, status: SignerBackendStatus): () => void {
  const module: SignerModule = {
    defaultEnabled: true,
    getBackendStatus: () => status,
    id,
    isBackendVisible: () => true,
    async signEd25519Digest() {
      throw new Error('not used');
    },
  };
  return registerSignerModule(module);
}
