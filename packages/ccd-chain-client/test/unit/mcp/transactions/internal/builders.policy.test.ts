import { describe, expect, it } from 'vitest';
import {
  AccountTransactionType,
  CcdAmount,
  DataBlob,
  AccountAddress,
  serializeAccountTransactionPayload,
} from '@concordium/web-sdk';
import {
  buildConfigureBaker,
  buildConfigureDelegation,
  buildRegisterData,
  buildTransfer,
} from '../../../../../src/mcp/transactions/internal/builders.js';
import { FakeConcordiumClient, makeContext } from '../../../../helpers/fakes.js';
import { SENDER, TO, ctx } from '../../../../mcp/transactions/internal/builders.fixtures.js';

describe('transaction builder metadata policy', () => {
  it('uses an explicit sequence number without querying the account sequence number', async () => {
    const client = new FakeConcordiumClient({
      signingRequirements: { [SENDER]: { accountThreshold: 1, credentialSignThresholds: [1] } },
    });

    const result = await buildTransfer(makeContext(client), {
      sender: SENDER,
      toAddress: TO,
      amountMicroCcd: '5000000',
      sequenceNumber: '42',
    });

    expect(result.metadata.sequenceNumber).toBe('42');
    expect(client.calls.getNextAccountSequenceNumber ?? 0).toBe(0);
  });

  it('queries the account sequence number once when omitted', async () => {
    const client = new FakeConcordiumClient({
      sequenceNumbers: { [SENDER]: { sequenceNumber: '5', allFinal: true } },
      signingRequirements: { [SENDER]: { accountThreshold: 1, credentialSignThresholds: [1] } },
    });

    await buildTransfer(makeContext(client), { sender: SENDER, toAddress: TO, amountMicroCcd: '5000000' });

    expect(client.calls.getNextAccountSequenceNumber).toBe(1);
  });

  it('derives default sender and sponsor signature counts from account requirements', async () => {
    const client = new FakeConcordiumClient({
      sequenceNumbers: { [SENDER]: { sequenceNumber: '5', allFinal: true } },
      signingRequirements: {
        [SENDER]: { accountThreshold: 2, credentialSignThresholds: [3, 1, 2] },
        [TO]: { accountThreshold: 1, credentialSignThresholds: [2] },
      },
    });

    const result = await buildTransfer(makeContext(client), {
      sender: SENDER,
      sponsor: TO,
      toAddress: TO,
      amountMicroCcd: '1',
    });

    expect(result.metadata).toMatchObject({
      senderNumSignatures: '3',
      sponsorNumSignatures: '2',
      totalSignatureCount: '5',
      sponsor: TO,
    });
  });

  it('propagates explicit signature counts into sponsored transaction metadata', async () => {
    const client = new FakeConcordiumClient({
      sequenceNumbers: { [SENDER]: { sequenceNumber: '5', allFinal: true } },
    });

    const result = await buildTransfer(makeContext(client), {
      sender: SENDER,
      sponsor: TO,
      senderNumSignatures: '4',
      sponsorNumSignatures: '3',
      toAddress: TO,
      amountMicroCcd: '1',
    });

    expect(result.metadata).toMatchObject({
      senderNumSignatures: '4',
      sponsorNumSignatures: '3',
      totalSignatureCount: '7',
    });
  });
});

describe('transfer payload policy', () => {
  it.each([
    { memo: { memoText: 'hello 🌍' }, encoded: 'hello 🌍' },
    { memo: { memoJson: { count: 0, empty: [] } }, encoded: '{"count":0,"empty":[]}' },
  ])('preserves memo bytes for $encoded', async ({ memo, encoded }) => {
    const result = await buildTransfer(ctx, {
      sender: SENDER,
      toAddress: TO,
      amountMicroCcd: '5000000',
      ...memo,
    });
    const bytes = new TextEncoder().encode(encoded);
    const expectedPayload = serializeAccountTransactionPayload({
      type: AccountTransactionType.TransferWithMemo,
      payload: {
        toAddress: AccountAddress.fromBase58(TO),
        amount: CcdAmount.fromMicroCcd(5_000_000n),
        memo: new DataBlob(bytes.buffer),
      },
    });

    expect(result.transactionType).toBe('transferWithMemo');
    expect(result.payload).toMatchObject(memo);
    expect(result.transactionHex.endsWith(Buffer.from(expectedPayload).toString('hex'))).toBe(true);
  });
});

describe('non-transfer builder summaries', () => {
  it('preserves register data in the payload summary', async () => {
    const result = await buildRegisterData(ctx, { sender: SENDER, dataHex: 'ABCD' });

    expect(result).toMatchObject({ transactionType: 'registerData', payload: { data: 'ABCD' } });
  });

  it('summarizes pool delegation inputs', async () => {
    const result = await buildConfigureDelegation(ctx, {
      sender: SENDER,
      delegationTarget: 'pool',
      poolId: '42',
      amountMicroCcd: '1000000',
      restakeEarnings: false,
    });

    expect(result).toMatchObject({
      transactionType: 'configureDelegation',
      payload: {
        delegationTarget: 'pool',
        poolId: '42',
        amount: { value: '1000000', decimals: 6, display: '1.000000' },
        restakeEarnings: false,
      },
    });
  });

  it('summarizes configure baker optional fields', async () => {
    const result = await buildConfigureBaker(ctx, {
      sender: SENDER,
      amountMicroCcd: '1000000',
      restakeEarnings: true,
      openStatus: 'closed_for_new',
    });

    expect(result).toMatchObject({
      transactionType: 'configureBaker',
      payload: {
        amount: { value: '1000000', decimals: 6, display: '1.000000' },
        restakeEarnings: true,
        openStatus: 'closed_for_new',
      },
    });
  });
});
