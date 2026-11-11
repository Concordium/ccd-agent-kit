import { join } from 'node:path';
import { rmSync, writeFileSync } from 'node:fs';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createEncryptedKeyFile,
  EncryptedFileSigningBackend,
} from '../../../../../src/core/sign/backends/encryptedFile.js';
import { signTransaction } from '../../../../../src/core/sign/signTransaction.js';
import { makeTestTempDir } from '../../../../helpers/tempDir.js';
import { transactionFixtures } from '../../../../helpers/transactionFixtures.js';

describe('EncryptedFileSigningBackend', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('signs a real transaction through the full pipeline', async () => {
    const dir = makeTestTempDir('sign-test-');
    tempDirs.push(dir);
    const filePath = join(dir, 'key.json');
    const password = 'pipeline-test';

    const encrypted = createEncryptedKeyFile('ab'.repeat(32), password, transactionFixtures.sender);
    writeFileSync(filePath, JSON.stringify(encrypted));

    const backend = new EncryptedFileSigningBackend(filePath, password);
    const result = await signTransaction(transactionFixtures.unsignedTransferWithMemoHex, {
      backend,
      role: 'sender',
      signatureRequirements: {
        senderNumSignatures: '1',
        totalSignatureCount: '1',
      },
    });

    expect(result.roleSigned).toBe('sender');
    expect(result.signatures.sender['0']?.['0']).toMatch(/^[0-9a-f]+$/);
    expect(result.isFullySigned).toBe(true);
  });
});
