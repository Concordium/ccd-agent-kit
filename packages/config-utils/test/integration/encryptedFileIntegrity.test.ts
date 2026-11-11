import { copyFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { getPublicKeyAsync } from '@noble/ed25519';
import type { Ed25519PrivateKeyHex, Ed25519PublicKeyHex } from '@ccd-agent-kit/sdk-utils';

import {
  adoptEncryptedFileKey,
  checkEncryptedFileIntegrity,
  ed25519SignerKeyRef,
  encodeCatalogLabel,
  getSignerDataDir,
  importLocalEd25519Key,
  initializeEncryptedFileStorage,
  loadSignerInventory,
  lockEncryptedFileStorage,
  upsertSignerInventoryKey,
  writeEncryptedEd25519KeyFile,
} from '../../src/index.js';
import { useConfigSandbox } from '../helpers/configSandbox.js';

const PRIVATE_A = '11'.repeat(32) as Ed25519PrivateKeyHex;
const PRIVATE_B = '22'.repeat(32) as Ed25519PrivateKeyHex;
const PRIVATE_C = '33'.repeat(32) as Ed25519PrivateKeyHex;

async function publicKey(privateKey: Ed25519PrivateKeyHex): Promise<Ed25519PublicKeyHex> {
  return Buffer.from(await getPublicKeyAsync(privateKey)).toString('hex') as Ed25519PublicKeyHex;
}

describe('encrypted storage integrity', () => {
  useConfigSandbox();
  afterEach(() => lockEncryptedFileStorage());

  it('classifies valid, missing, adoptable, and mismatched entries without mutation', async () => {
    const privateD = '44'.repeat(32) as Ed25519PrivateKeyHex;
    const [keyA, keyB, keyC, keyD] = await Promise.all([
      publicKey(PRIVATE_A), publicKey(PRIVATE_B), publicKey(PRIVATE_C), publicKey(privateD),
    ]);
    initializeEncryptedFileStorage('password');
    await importLocalEd25519Key({ privateKeyHex: PRIVATE_A, storage: 'encrypted-file' });
    const orphanReference = writeEncryptedEd25519KeyFile(keyB, PRIVATE_B);
    const mismatchedReference = join('keys', 'ed25519-encrypted', `${keyC}.json`);
    copyFileSync(join(getSignerDataDir(), orphanReference), join(getSignerDataDir(), mismatchedReference));
    copyFileSync(
      join(getSignerDataDir(), orphanReference),
      join(getSignerDataDir(), 'keys', 'ed25519-encrypted', `${keyD}.json`),
    );
    upsertSignerInventoryKey({
      publicKey: keyC, scheme: 'Ed25519', signingModule: 'software-signer',
      backend: { storageModule: 'encrypted-file', keyRef: join('keys', 'ed25519-encrypted', `${keyC}.json`) },
    });
    const missing = '44'.repeat(32) as Ed25519PublicKeyHex;
    upsertSignerInventoryKey({
      publicKey: missing, scheme: 'Ed25519', signingModule: 'software-signer',
      backend: { storageModule: 'encrypted-file', keyRef: join('keys', 'ed25519-encrypted', `${missing}.json`) },
    });
    expect(mismatchedReference).toContain(keyC);
    const before = loadSignerInventory();

    await expect(checkEncryptedFileIntegrity({ fix: false })).resolves.toEqual({
      okReferences: [{ publicKey: keyA }],
      missingReferences: [{ publicKey: missing }],
      adoptableOrphans: [{ publicKey: keyB }],
      invalidEntries: [{ publicKey: keyC }, { publicKey: keyD }].sort((a, b) => a.publicKey.localeCompare(b.publicKey)),
      prunedMissingReferences: [],
    });
    expect(loadSignerInventory()).toEqual(before);
  });

  it('leaves adoptable orphans untouched during repair, then explicitly adopts one without rewriting its file', async () => {
    const [orphan, missing] = await Promise.all([publicKey(PRIVATE_B), publicKey(PRIVATE_C)]);
    initializeEncryptedFileStorage('password');
    const orphanReference = writeEncryptedEd25519KeyFile(orphan, PRIVATE_B);
    const orphanPath = join(getSignerDataDir(), orphanReference);
    const fileBefore = readFileSync(orphanPath);
    upsertSignerInventoryKey({
      publicKey: missing, scheme: 'Ed25519', signingModule: 'yubikey-piv',
      backend: { devices: [{ kind: 'yubikey', serial: '123', slot: '9c' }] },
    });
    upsertSignerInventoryKey({
      publicKey: missing, scheme: 'Ed25519', signingModule: 'software-signer',
      backend: { storageModule: 'encrypted-file', keyRef: join('keys', 'ed25519-encrypted', `${missing}.json`) },
    });

    const report = await checkEncryptedFileIntegrity({ fix: true });
    expect(report.adoptableOrphans).toEqual([{ publicKey: orphan }]);
    expect(report.prunedMissingReferences).toEqual([{ publicKey: missing }]);
    expect(loadSignerInventory().keys[ed25519SignerKeyRef(orphan)]).toBeUndefined();
    expect(loadSignerInventory().keys[ed25519SignerKeyRef(missing)]?.backends).toMatchObject([
      { signingModule: 'yubikey-piv' },
    ]);

    adoptEncryptedFileKey({ publicKey: orphan, label: ' recovered ' });

    expect(loadSignerInventory().keys[ed25519SignerKeyRef(orphan)]).toMatchObject({
      label: encodeCatalogLabel('recovered', 'hard'),
      backends: [{
        signingModule: 'software-signer',
        backend: { storageModule: 'encrypted-file', keyRef: orphanReference },
      }],
    });
    expect(readFileSync(orphanPath)).toEqual(fileBefore);
  });

});
