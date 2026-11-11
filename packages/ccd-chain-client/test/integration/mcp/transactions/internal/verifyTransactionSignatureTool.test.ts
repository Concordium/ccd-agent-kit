import { AccountTransactionV0, buildBasicAccountSigner } from '@concordium/web-sdk';
import { getAccountCredentialObservation, setAccountCredentialObservation } from '@ccd-agent-kit/config-utils';
import { rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildTransfer } from '../../../../../src/mcp/transactions/internal/builders.js';
import { verifyTransactionSignature } from '../../../../../src/mcp/transactions/internal/verifyTransactionSignatureTool.js';
import { FakeConcordiumClient, makeContext } from '../../../../helpers/fakes.js';
import { makeTestTempDir } from '../../../../helpers/tempDir.js';
import { MAINNET_REF, SENDER, SPONSOR, accountObservation, keyPair, parseV0Unsigned } from '../../../../mcp/transactions/internal/helpers.js';

describe('verifyTransactionSignature integration', () => {
  let stateHome: string;
  let previousStateHome: string | undefined;

  beforeEach(() => {
    previousStateHome = process.env.XDG_STATE_HOME;
    stateHome = makeTestTempDir('verify-transaction-');
    process.env.XDG_STATE_HOME = stateHome;
  });

  afterEach(() => {
    if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previousStateHome;
    rmSync(stateHome, { recursive: true, force: true });
  });

  it('refreshes stale protected credential state and verifies a real SDK signature', async () => {
    const staleKeys = await keyPair('7');
    const freshKeys = await keyPair('8');
    setAccountCredentialObservation(SENDER, accountObservation(staleKeys.verifyKey), MAINNET_REF);
    const built = await buildTransfer(makeContext(new FakeConcordiumClient({
      sequenceNumbers: { [SENDER]: { sequenceNumber: '5', allFinal: true } },
      signingRequirements: { [SENDER]: { accountThreshold: 1, credentialSignThresholds: [1] } },
    })), { sender: SENDER, toAddress: SPONSOR, amountMicroCcd: '1000000' });
    const signature = await AccountTransactionV0.createSignature(
      parseV0Unsigned(built.transactionHex),
      buildBasicAccountSigner(freshKeys.signKey),
    );
    const client = new FakeConcordiumClient({
      accountCredentialObservations: {
        [SENDER]: { canonicalAddress: SENDER, observation: accountObservation(freshKeys.verifyKey) },
      },
    });

    await expect(verifyTransactionSignature(makeContext(client), {
      transactionHex: built.transactionHex,
      signatures: { sender: signature, sponsor: {} },
    })).resolves.toMatchObject({ valid: true, transactionVersion: 'v0' });
    expect(client.calls.getFinalizedAccountCredentials).toBe(1);
    expect(getAccountCredentialObservation(SENDER, MAINNET_REF)?.credentials['0']?.keys['0']?.publicKey).toBe(
      freshKeys.verifyKey,
    );
  });
});
