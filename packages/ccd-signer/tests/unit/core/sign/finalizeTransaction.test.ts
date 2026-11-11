import { describe, expect, it } from 'vitest';

import { FinalizeTransactionError, finalizeTransaction } from '../../../../src/core/sign/finalizeTransaction.js';
import { transactionFixtures } from '../../../helpers/transactionFixtures.js';

describe('finalizeTransaction', () => {
  const senderRequirements = { senderNumSignatures: '1', totalSignatureCount: '1' };
  const senderSignature = signature('22');

  it('finalizes unsigned hex plus detached signatures into block item hex', () => {
    const result = finalizeTransaction({
      transactionHex: transactionFixtures.unsignedTransferWithMemoHex,
      signatureRequirements: senderRequirements,
      signatures: { sender: senderSignature, sponsor: {} },
    });

    expect(result.transactionVersion).toBe('v0');
    expect(result.isFullySigned).toBe(true);
    expect(result.blockItemHex).toMatch(/^[0-9a-f]+$/);
    expect(result.blockItemHex.endsWith(transactionFixtures.unsignedTransferWithMemoHex.slice(4))).toBe(true);
    expect(result.signatures.sender[0]?.[0]).toBe('22'.repeat(64));
  });

  it('finalizes unsigned meta-update hex plus detached signatures into signed outputs', () => {
    const signatures = { sender: { 0: { 0: '33'.repeat(64) } }, sponsor: { 0: { 0: '44'.repeat(64) } } };
    const result = finalizeTransaction({
      transactionHex: transactionFixtures.sponsoredPltTransferTransactionHex,
      signatureRequirements: { senderNumSignatures: '1', sponsorNumSignatures: '1', totalSignatureCount: '2' },
      signatures,
    });

    expect(result.transactionVersion).toBe('v1');
    expect(result.isFullySigned).toBe(true);
    expect(result.blockItemHex).toMatch(/^[0-9a-f]+$/);
    expect(result.blockItemHex.endsWith(transactionFixtures.sponsoredPltTransferTransactionHex.slice(6))).toBe(true);
    expect(result.signatures.sender[0]?.[0]).toBe('33'.repeat(64));
    expect(result.signatures.sponsor[0]?.[0]).toBe('44'.repeat(64));
    expect(result.signatures).toEqual(signatures);
    for (const role of ['sender', 'sponsor'] as const) {
      expect(result.signatures[role]).not.toBe(signatures[role]);
      expect(result.signatures[role][0]).not.toBe(signatures[role][0]);
    }
  });

  it('defaults an omitted sponsor map while preserving and isolating the caller sender map', () => {
    const signatures = JSON.parse(JSON.stringify({ sender: senderSignature }));
    const result = finalizeTransaction({
      transactionHex: transactionFixtures.unsignedTransferWithMemoHex,
      signatureRequirements: senderRequirements,
      signatures,
    });

    expect(result.isFullySigned).toBe(true);
    expect(result.signatures).toEqual({ sender: senderSignature, sponsor: {} });
    expect(signatures).toEqual({ sender: senderSignature });
    expect(result.signatures.sender).not.toBe(signatures.sender);
    expect(result.signatures.sender[0]).not.toBe(signatures.sender[0]);
  });

  it('defaults nullish legacy signature maps before reporting stable signing errors', () => {
    for (const json of ['null', '{}', '{"sender":null,"sponsor":null}']) {
      expect(() => finalizeTransaction({
        transactionHex: transactionFixtures.unsignedTransferWithMemoHex, signatures: JSON.parse(json), signatureRequirements: senderRequirements,
      })).toThrow(FinalizeTransactionError);
    }
  });

  it('preserves the original unsigned hex bytes when finalizing v0 transactions', () => {
    const headerAndPayload =
      '81feabcdfb642556262da46ba755f99d835fb1c31265e3b937042ca2f9b5fec7000000000000000900000000000002960000006c000000006a984ac51b000000006681a16d746f6b656e5472616e73666572a365746f6b656e6946726565546f6b656e66616d6f756e74c482250169726563697069656e74d99d73a201d99d71a1011903970358201c1d917351625d1087065d2cc19766352374f6396f18d65769f66238f2176992';
    const transactionHex = `0000${headerAndPayload}`;
    const signature =
      '5926ddab4e77b627e1bf53d8a058825e555328ac133c06e606f49f9d23044cf3a03e219cf164242897af37b6c794a0166662d778316eb1e6beca477ee24b0600';

    const result = finalizeTransaction({
      transactionHex,
      signatureRequirements: senderRequirements,
      signatures: { sender: { 0: { 0: signature } }, sponsor: {} },
    });

    expect(result.blockItemHex.endsWith(headerAndPayload)).toBe(true);
  });

  it('rejects sponsor signatures on version 0 transactions', () => {
    expect(() =>
      finalizeTransaction({
        transactionHex: transactionFixtures.unsignedTransferWithMemoHex,
        signatureRequirements: senderRequirements,
        signatures: {
          sender: { 0: { 0: '22'.repeat(64) } },
          sponsor: { 0: { 0: '33'.repeat(64) } },
        },
      }),
    ).toThrow('Sponsor signatures are not valid for version 0 transactions.');
  });

  it('rejects malformed transaction input and malformed signature shapes', () => {
    expect(() =>
      finalizeTransaction({
        transactionHex: 'not-a-transaction',
        signatureRequirements: senderRequirements,
        signatures: { sender: {}, sponsor: {} },
      }),
    ).toThrow('Unsupported unsigned account transaction hex.');

    expect(() =>
      finalizeTransaction({
        transactionHex: transactionFixtures.unsignedTransferWithMemoHex,
        signatureRequirements: senderRequirements,
        signatures: {
          sender: Object.fromEntries([['notanumber', { 0: '22'.repeat(64) }]]),
          sponsor: {},
        },
      }),
    ).toThrow('8 bit unsigned integer');
  });

  it.each([
    ['missing requirements', transactionFixtures.unsignedTransferWithMemoHex, undefined, { sender: senderSignature, sponsor: {} }],
    ['empty requirements', transactionFixtures.unsignedTransferWithMemoHex, {}, { sender: senderSignature, sponsor: {} }],
    ['zero sender requirement', transactionFixtures.unsignedTransferWithMemoHex, { senderNumSignatures: '0', totalSignatureCount: '0' }, { sender: senderSignature, sponsor: {} }],
    ['missing sponsor requirement', transactionFixtures.sponsoredPltTransferTransactionHex, senderRequirements, { sender: signature('33'), sponsor: {} }],
    ['sponsor requirement on unsponsored transaction', transactionFixtures.unsignedTransferWithMemoHex, { senderNumSignatures: '1', sponsorNumSignatures: '0', totalSignatureCount: '1' }, { sender: senderSignature, sponsor: {} }],
    ['inconsistent total', transactionFixtures.sponsoredPltTransferTransactionHex, { senderNumSignatures: '1', sponsorNumSignatures: '1', totalSignatureCount: '3' }, { sender: signature('33'), sponsor: signature('44') }],
    ['incomplete threshold-two sender', transactionFixtures.unsignedConfigureDelegationPoolHex, { senderNumSignatures: '2', totalSignatureCount: '2' }, { sender: senderSignature, sponsor: {} }],
  ])('rejects invalid or unmet signature requirements: %s', (_name, transactionHex, signatureRequirements, signatures) => {
    expectFinalizeError({ transactionHex, signatureRequirements, signatures });
  });
});

function signature(byte: string) {
  return { 0: { 0: byte.repeat(64) } };
}

function expectFinalizeError(options: unknown): void {
  expect(() => Reflect.apply(finalizeTransaction, undefined, [JSON.parse(JSON.stringify(options))])).toThrow(FinalizeTransactionError);
}
