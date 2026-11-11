import { AccountTransactionV0, buildBasicAccountSigner } from '@concordium/web-sdk';
import * as ed from '@concordium/web-sdk/shims/ed25519';
import { finalizeAccountTransactionHex } from '@ccd-agent-kit/sdk-utils';
import { createHash } from 'node:crypto';
import { rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { completeTransaction } from '../../../../../src/mcp/transactions/internal/completeTransactionTool.js';
import { completeAccountOpening } from '../../../../../src/mcp/submissions/completeAccountOpeningTool.js';
import { buildTransfer } from '../../../../../src/mcp/transactions/internal/builders.js';
import { FakeConcordiumClient, makeContext } from '../../../../helpers/fakes.js';
import { makeTestTempDir } from '../../../../helpers/tempDir.js';
import { CREDENTIAL_HANDOFF_HEX, SENDER, SPONSOR, accountObservation, keyPair, parseV0Unsigned } from '../../../../mcp/transactions/internal/helpers.js';

describe('completeTransaction integration', () => {
  let stateHome: string;
  let previousStateHome: string | undefined;

  beforeEach(() => {
    previousStateHome = process.env.XDG_STATE_HOME;
    stateHome = makeTestTempDir('complete-transaction-');
    process.env.XDG_STATE_HOME = stateHome;
  });

  afterEach(() => {
    if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previousStateHome;
    rmSync(stateHome, { recursive: true, force: true });
  });

  it('composes real verification, finalization, and submission protocol stages', async () => {
    const keys = await keyPair('9');
    const built = await buildTransfer(makeContext(new FakeConcordiumClient({
      sequenceNumbers: { [SENDER]: { sequenceNumber: '5', allFinal: true } },
      signingRequirements: { [SENDER]: { accountThreshold: 1, credentialSignThresholds: [1] } },
    })), { sender: SENDER, toAddress: SPONSOR, amountMicroCcd: '1000000' });
    const signature = await AccountTransactionV0.createSignature(
      parseV0Unsigned(built.transactionHex),
      buildBasicAccountSigner(keys.signKey),
    );
    const finalized = finalizeAccountTransactionHex(built.transactionHex, { sender: signature, sponsor: {} });
    const transactionHash = '9f'.repeat(32);
    const client = new FakeConcordiumClient({
      accountCredentialObservations: {
        [SENDER]: { canonicalAddress: SENDER, observation: accountObservation(keys.verifyKey) },
      },
      submittedBlockItems: { [finalized.blockItemHex]: transactionHash },
    });

    await expect(completeTransaction(makeContext(client), {
      transactionHex: built.transactionHex,
      signatures: { sender: signature, sponsor: {} },
      submit: true,
    })).resolves.toMatchObject({
      isFullySigned: true,
      blockItemHex: finalized.blockItemHex,
      submitted: true,
      transactionHash,
      network: 'mainnet',
    });
  });

  it('composes verified account-opening finalization without submission by default', async () => {
    const bytes = Buffer.from(CREDENTIAL_HANDOFF_HEX, 'hex');
    const digest = createHash('sha256').update(bytes.subarray(9)).update(bytes.subarray(0, 9)).digest();
    const signature = Buffer.from(
      await ed.signAsync(digest, Uint8Array.from(Buffer.from('aa'.repeat(32), 'hex'))),
    ).toString('hex');
    const result = await completeAccountOpening(makeContext(new FakeConcordiumClient()), {
      credDeploymentHex: CREDENTIAL_HANDOFF_HEX,
      signatures: { 0: signature },
    });

    expect(result).toMatchObject({
      blockItemKind: 'credentialDeployment',
      signatures: { '0': signature },
      submitted: false,
    });
    expect(result.blockItemHex).toMatch(/^[0-9a-f]+$/);
  });

  it('rejects structurally valid but cryptographically invalid account-opening signatures', async () => {
    await expect(completeAccountOpening(makeContext(new FakeConcordiumClient()), {
      credDeploymentHex: CREDENTIAL_HANDOFF_HEX,
      signatures: { 0: '11'.repeat(64) },
    })).rejects.toMatchObject({ kind: 'invalid-argument' });
  });

  it('completes a sparse multi-key account opening when the credential threshold is met', async () => {
    const first = await keyPair('1');
    const second = await keyPair('2');
    const valuesAndProofsAfterSingleKeyMap = CREDENTIAL_HANDOFF_HEX.slice(18 + (1 + 1 + 1 + 32 + 1) * 2);
    const handoff = `00${CREDENTIAL_HANDOFF_HEX.slice(2, 18)}${[
      '02',
      '00', '00', first.verifyKey,
      '07', '00', second.verifyKey,
      '02',
      valuesAndProofsAfterSingleKeyMap,
    ].join('')}`;
    const bytes = Buffer.from(handoff, 'hex');
    const digest = createHash('sha256').update(bytes.subarray(9)).update(bytes.subarray(0, 9)).digest();
    const signatures = {
      0: Buffer.from(await ed.signAsync(digest, Buffer.from(first.signKey, 'hex'))).toString('hex'),
      7: Buffer.from(await ed.signAsync(digest, Buffer.from(second.signKey, 'hex'))).toString('hex'),
    };

    await expect(completeAccountOpening(makeContext(new FakeConcordiumClient()), {
      credDeploymentHex: handoff,
      signatures: { 0: signatures[0] },
    })).rejects.toMatchObject({ kind: 'invalid-argument' });
    await expect(completeAccountOpening(makeContext(new FakeConcordiumClient()), {
      credDeploymentHex: handoff,
      signatures,
    })).resolves.toMatchObject({
      blockItemKind: 'credentialDeployment',
      signatures,
      submitted: false,
    });
  });

  it('rejects an existing-account credential handoff even with a valid target-bound signature', async () => {
    const existingHandoff = `01${'1f0dd0acc617a2b459155982b8548c89ccdbb06579437251b25cf3b19c35eabf'}${CREDENTIAL_HANDOFF_HEX.slice(18)}`;
    const bytes = Buffer.from(existingHandoff, 'hex');
    const digest = createHash('sha256').update(bytes.subarray(33)).update(bytes.subarray(0, 33)).digest();
    const signature = Buffer.from(
      await ed.signAsync(digest, Uint8Array.from(Buffer.from('aa'.repeat(32), 'hex'))),
    ).toString('hex');

    await expect(completeAccountOpening(makeContext(new FakeConcordiumClient()), {
      credDeploymentHex: existingHandoff,
      signatures: { 0: signature },
    })).rejects.toMatchObject({ kind: 'invalid-argument' });
  });
});
