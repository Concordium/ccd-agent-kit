import {
  AccountTransactionV0,
  AccountTransactionV1,
  CcdAmount,
  ContractAddress,
  Parameter,
  Payload,
  ReceiveName,
} from '@concordium/web-sdk';
import { parseUnsignedAccountTransactionHex } from '@ccd-agent-kit/sdk-utils';
import { describe, expect, it, vi } from 'vitest';

import {
  ParseTransactionError,
  parseTransaction,
} from '../../../../src/core/parser/parseTransaction.js';
import { signTransaction } from '../../../../src/core/sign/signTransaction.js';
import { finalizeTransaction } from '../../../../src/core/sign/finalizeTransaction.js';
import { transactionFixtures } from '../../../helpers/transactionFixtures.js';
import { unsignedHexForPayload } from '../../../helpers/unsignedAccountTransaction.js';

const v0 = transactionFixtures.unsignedTransferWithMemoHex;
const v1 = `0300000000${v0.slice(4)}`;

describe('canonical unsigned account transaction boundary', () => {
  it('signs V1 without a sponsor using the SDK V1 digest and retains the bitmap on finalization', async () => {
    const original = parseUnsignedAccountTransactionHex(v0).transaction;
    const transaction: AccountTransactionV1.Unsigned = { ...original, version: 1 };
    const expectedDigest = Uint8Array.from(AccountTransactionV1.signDigest(transaction));
    expect(expectedDigest).not.toEqual(Uint8Array.from(AccountTransactionV0.signDigest({ ...original, version: 0 })));
    const signature = '22'.repeat(64);
    const createSignature = vi.fn(async () => ({ 0: { 0: signature } }));
    const signed = await signTransaction(v1, { backend: { createSignature }, role: 'sender' });
    expect(createSignature).toHaveBeenCalledWith(expect.objectContaining({ digest: expectedDigest }));
    expect(signed.transaction).toBe(v1);
    const finalized = finalizeTransaction({
      transactionHex: v1,
      signatureRequirements: { senderNumSignatures: '1', totalSignatureCount: '1' },
      signatures: signed.signatures,
    });
    expect(finalized.transactionVersion).toBe('v1');
    const expectedBlockItem = AccountTransactionV1.serializeBlockItem({
      ...transaction,
      signatures: { sender: { 0: { 0: signature } } },
    });
    expect(finalized.blockItemHex).toBe(Buffer.from(expectedBlockItem).toString('hex'));
    expect(parseTransaction(finalized.blockItemHex)).toMatchObject({ kind: 'accountTransaction', version: 1 });
  });

  it('does not call the signing backend for malformed unsigned input', async () => {
    const hex = v0 + '00';
    const createSignature = vi.fn();
    await expect(signTransaction(hex, { backend: { createSignature }, role: 'sender' })).rejects.toThrow(
      ParseTransactionError,
    );
    expect(createSignature).not.toHaveBeenCalled();
  });

  it('preserves contract-update inspection after V1 finalization', () => {
    const payload = Payload.updateContract({
      address: ContractAddress.create(42n, 7n),
      amount: CcdAmount.fromMicroCcd(123n),
      message: Parameter.fromHexString('aabb'),
      receiveName: ReceiveName.fromString('counter.increment'),
    });
    const unsignedHex = unsignedHexForPayload(payload, 1);
    const signatures = { sender: { 0: { 0: '22'.repeat(64) } }, sponsor: {} };
    const signedHex = finalizeTransaction({
      transactionHex: unsignedHex,
      signatureRequirements: { senderNumSignatures: '1', totalSignatureCount: '1' },
      signatures,
    }).blockItemHex;
    const expected = {
      kind: 'accountTransaction',
      version: 1,
      header: {
        sender: '3BRQgT1WY48tQUcgRNNqqSifo2VEENkY4gCX3Qx9UQ9S7kYVLP',
        nonce: 1n, energy: 508n, expiry: 1787586091000,
      },
      payloadSummary: {
        kind: 'updateContract',
        address: { index: 42, subindex: 7 },
        amount: '123',
        message: 'aabb',
        receiveName: 'counter.increment',
      },
    };
    expect(parseTransaction(signedHex)).toMatchObject({ ...expected, signatureState: { senderSignatureCount: 1 } });
  });

});
