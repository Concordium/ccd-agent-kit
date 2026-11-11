import { AccountTransactionV0, buildBasicAccountSigner } from '@concordium/web-sdk';
import { rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildTransfer } from '../../../../../src/mcp/transactions/internal/builders.js';
import { combineTransactionSignatures } from '../../../../../src/mcp/transactions/internal/combineTransactionSignaturesTool.js';
import { FakeConcordiumClient, makeContext } from '../../../../helpers/fakes.js';
import { makeTestTempDir } from '../../../../helpers/tempDir.js';
import { SENDER, SPONSOR, accountObservation, keyPair, parseV0Unsigned } from '../../../../mcp/transactions/internal/helpers.js';

describe('combineTransactionSignatures integration', () => {
  let stateHome: string;
  let previousStateHome: string | undefined;

  beforeEach(() => {
    previousStateHome = process.env.XDG_STATE_HOME;
    stateHome = makeTestTempDir('combine-signatures-');
    process.env.XDG_STATE_HOME = stateHome;
  });

  afterEach(() => {
    if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previousStateHome;
    rmSync(stateHome, { recursive: true, force: true });
  });

  it('combines a real SDK signature while rejecting an invalid replacement', async () => {
    const keys = await keyPair('9');
    const built = await buildTransfer(makeContext(new FakeConcordiumClient({
      sequenceNumbers: { [SENDER]: { sequenceNumber: '5', allFinal: true } },
      signingRequirements: { [SENDER]: { accountThreshold: 1, credentialSignThresholds: [1] } },
    })), { sender: SENDER, toAddress: SPONSOR, amountMicroCcd: '1000000' });
    const signature = await AccountTransactionV0.createSignature(
      parseV0Unsigned(built.transactionHex),
      buildBasicAccountSigner(keys.signKey),
    );
    const client = new FakeConcordiumClient({
      accountCredentialObservations: {
        [SENDER]: { canonicalAddress: SENDER, observation: accountObservation(keys.verifyKey) },
      },
    });

    await expect(combineTransactionSignatures(makeContext(client), {
      transactionHex: built.transactionHex,
      signatureSets: [
        { sender: { 0: { 0: '00'.repeat(64) } }, sponsor: {} },
        { sender: signature, sponsor: {} },
      ],
    })).resolves.toMatchObject({
      isFullySigned: true,
      acceptedSignatureCount: 1,
      rejectedSignatureCount: 1,
      signatures: { sender: signature, sponsor: {} },
    });
  });
});
