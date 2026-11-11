import { describe, expect, it } from 'vitest';
import {
  AccountAddress,
  AccountTransactionV0,
  AccountTransactionV1,
  AccountTransactionType,
  CcdAmount,
  SequenceNumber,
  Transaction,
  TransactionExpiry,
  serializeAccountTransactionPayload,
} from '@concordium/web-sdk';
import { buildTransfer } from '../../../../../src/mcp/transactions/internal/builders.js';
import { installAccountLabelsFixture } from '../../../../helpers/accountLabels.js';
import { FakeConcordiumClient, makeContext } from '../../../../helpers/fakes.js';
import { SENDER, TO, ctx } from '../../../../mcp/transactions/internal/builders.fixtures.js';

function expectedTransferHex(version: 0 | 1, sponsorSignatures: bigint | undefined, expiry: number): string {
  const payload = { toAddress: AccountAddress.fromBase58(TO), amount: CcdAmount.fromMicroCcd(5_000_000n) };
  const builder = Transaction.transfer(payload)
    .addMetadata({
      sender: AccountAddress.fromBase58(SENDER),
      nonce: SequenceNumber.create(42n),
      expiry: TransactionExpiry.fromEpochSeconds(expiry),
    })
    .addMultiSig(1n);
  const transaction = Transaction.preFinalized(
    version === 0 ? builder.build() : builder.addSponsor(AccountAddress.fromBase58(TO), sponsorSignatures!).build(),
  );
  const header =
    transaction.version === 0
      ? AccountTransactionV0.serializeHeader(transaction.header)
      : AccountTransactionV1.serializeHeader(transaction.header);
  const transactionBytes = Buffer.concat([
    header,
    serializeAccountTransactionPayload({ type: AccountTransactionType.Transfer, payload }),
  ]);
  return Buffer.concat([Buffer.from(version === 0 ? [0, 0] : [3, 0, 0]), transactionBytes]).toString('hex');
}

describe('transfer builder integration', () => {
  it('builds real SDK signable bytes for unsponsored and sponsored transactions', async () => {
    const args = {
      sender: SENDER,
      toAddress: TO,
      amountMicroCcd: '5000000',
      sequenceNumber: '42',
      expiryMs: 60_000,
    };
    const unsponsored = await buildTransfer(ctx, args);
    const sponsored = await buildTransfer(ctx, {
      ...args,
      sponsor: TO,
      senderNumSignatures: '1',
      sponsorNumSignatures: '2',
    });

    expect(unsponsored.transactionHex).toBe(expectedTransferHex(0, undefined, Number(unsponsored.metadata.expiry)));
    expect(sponsored.transactionHex).toBe(expectedTransferHex(1, 2n, Number(sponsored.metadata.expiry)));
  });

  it('resolves sender and recipient labels on the active default network', async () => {
    const restore = installAccountLabelsFixture('4221332d34e1694168c2a0c0b3fd0f27', {
      senderLabel: SENDER,
      recipientLabel: TO,
    });
    try {
      const testnetCtx = makeContext(
        new FakeConcordiumClient({
          sequenceNumbers: { [SENDER]: { sequenceNumber: '5', allFinal: true } },
          signingRequirements: { [SENDER]: { accountThreshold: 1, credentialSignThresholds: [1] } },
        }),
        { network: 'testnet', defaultNetworkSource: 'session' },
      );

      const result = await buildTransfer(testnetCtx, {
        sender: 'senderLabel',
        toAddress: 'recipientLabel',
        amountMicroCcd: '1000000',
      });

      expect(result.payload).toEqual({
        toAddress: TO,
        amount: { value: '1000000', decimals: 6, display: '1.000000' },
      });
      expect(result.metadata.sender).toBe(SENDER);
    } finally {
      restore();
    }
  });
});
