import { DataBlob } from '@concordium/web-sdk';
import { ed25519PublicKey, summarizeCredentialDeploymentSigningHandoff } from '@ccd-agent-kit/sdk-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@ccd-agent-kit/sdk-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ccd-agent-kit/sdk-utils')>();
  return {
    ...actual,
    summarizeCredentialDeploymentSigningHandoff: vi.fn(actual.summarizeCredentialDeploymentSigningHandoff),
  };
});

import type { ParsedAccountTransaction } from '../../../../src/core/model/parsedTransaction.js';
import { projectParsedTransaction } from '../../../../src/core/model/projectParsedTransaction.js';
import {
  type ParseTransactionOptions,
  ParseTransactionError,
  normalizeOperations,
  parseTransaction,
} from '../../../../src/core/parser/parseTransaction.js';
import { projectParsedOperation } from '../../../../src/core/parser/parsedOperations.js';
import { transactionFixtures } from '../../../helpers/transactionFixtures.js';

function parse(input: string, options?: ParseTransactionOptions) {
  return parseTransaction(input, options);
}

function withPayloadSize(transactionHex: string, offset: number, payloadSize: number): string {
  const bytes = Buffer.from(transactionHex, 'hex');
  bytes.writeUInt32BE(payloadSize, offset);
  return bytes.toString('hex');
}

function expectAccountTransaction(parsed: ReturnType<typeof parse>): ParsedAccountTransaction {
  expect(parsed.kind).toBe('accountTransaction');

  if (parsed.kind !== 'accountTransaction') {
    throw new Error('Expected an account transaction.');
  }

  return parsed;
}

describe('parseTransaction', () => {
  afterEach(() => {
    vi.mocked(summarizeCredentialDeploymentSigningHandoff).mockClear();
  });

  it('parses V0 block item hex into a normalized account transaction', () => {
    const parsed = expectAccountTransaction(parse(transactionFixtures.v0HexString));

    expect(parsed.version).toBe(0);
    expect(parsed.payloadType).toBe('transfer');
    expect(parsed.header.sender).toBe(transactionFixtures.sender);
    expect(parsed.header.nonce).toBe(1n);
    expect(parsed.signatureState.senderSignatureCount).toBe(1);
    expect(parsed.signatureState.sponsorSignatureCount).toBe(0);
  });

  it('parses uppercase 0X-prefixed hex input and normalizes expiry to milliseconds', () => {
    const parsed = expectAccountTransaction(parse(`  0X${transactionFixtures.v0HexString}  `));

    expect(parsed.header.expiry).toBe(1735689600000);
  });

  it('parses sponsored V1 block item hex into a normalized account transaction', () => {
    const parsed = expectAccountTransaction(parse(transactionFixtures.v1SponsoredHexString));

    expect(parsed.version).toBe(1);
    expect(parsed.payloadType).toBe('transfer');
    expect(parsed.header.sender).toBe(transactionFixtures.sender);
    expect(parsed.header.sponsor).toBe(transactionFixtures.sponsor);
    expect(parsed.header.nonce).toBe(2n);
    expect(parsed.signatureState.senderSignatureCount).toBe(1);
    expect(parsed.signatureState.sponsorSignatureCount).toBe(1);
  });

  it('parses sponsored unsigned builder transaction hex into a normalized account transaction', () => {
    const parsed = expectAccountTransaction(parse(transactionFixtures.sponsoredPltTransferTransactionHex));

    expect(parsed.version).toBe(1);
    expect(parsed.payloadType).toBe('tokenUpdate');
    expect(parsed.header.sender).toBe('3BRQgT1WY48tQUcgRNNqqSifo2VEENkY4gCX3Qx9UQ9S7kYVLP');
    expect(parsed.header.sponsor).toBe('3xAJhMaYdBqVb2pyo34nFuNGqsEbtvVaHBELaPoRm9gPvqDqus');
    expect(parsed.header.nonce).toBe(1n);
    expect(parsed.signatureState.senderSignatureCount).toBe(0);
    expect(parsed.signatureState.sponsorSignatureCount).toBe(0);
    expect(projectParsedTransaction(parsed)).toMatchObject({
      payloadSummary: {
        kind: 'tokenUpdate',
        variant: 'unscoped',
        operations: [
          {
            tokenTransfer: {
              amount: {
                decimals: 6,
                value: '1',
              },
              recipient: {
                address: '3F9b51LWFRZvTcmMdbo9bsBwYMW9Laq6zBtmURy9VZP9Y54hBZ',
                coinInfo: 919,
              },
              token: 'IMT',
            },
          },
        ],
      },
    });
  });

  it.each([
    ['signed v0', transactionFixtures.v0HexString, 119, 41],
    ['signed v1', transactionFixtures.v1SponsoredHexString, 191, 41],
    ['empty-map v0', transactionFixtures.unsignedTransferWithMemoHex, 50, 48],
    ['empty-map v1', transactionFixtures.sponsoredPltTransferTransactionHex, 53, 102],
  ] as const)('rejects %s payload-size mismatches', (_label, transactionHex, offset, actualSize) => {
    for (const declaredSize of [0, actualSize - 1, actualSize + 1]) {
      expect.soft(() => parse(withPayloadSize(transactionHex, offset, declaredSize))).toThrow(ParseTransactionError);
    }
  });

  it('normalizes decoded lock operation identifiers to lockId strings', () => {
    const summary = normalizeOperations('81a16a6c6f636b43616e63656ca1646c6f636bd99fd8830a0800');

    expect(summary.operations).toHaveLength(1);
    const projected = projectParsedOperation(summary.operations[0]!);
    expect(projected).toEqual({
      lockCancel: {
        lockId: 'WV4qByvHN4',
      },
    });
    expect(JSON.stringify(projected)).not.toContain('accountIndex');
    expect(JSON.stringify(projected)).not.toContain('"lock"');
  });

  it('does not duplicate text for CBOR string memos in token-update operations', () => {
    const parsed = expectAccountTransaction(
      parse(
        '030000000181feabcdfb642556262da46ba755f99d835fb1c31265e3b937042ca2f9b5fec7000000000000001600000000000003f8000000de000000006aaacbe81c1d917351625d1087065d2cc19766352374f6396f18d65769f66238f21769921b0946726565546f6b656e000000cf82a1687472616e73666572a3646d656d6fd81849686669727374206f7066616d6f756e74c482250169726563697069656e74d99d73a201d99d71a1011903970358201c1d917351625d1087065d2cc19766352374f6396f18d65769f66238f2176992a1687472616e73666572a3646d656d6fd81855a267707572706f73656464656d6f65696e6465780266616d6f756e74c482250269726563697069656e74d99d73a201d99d71a1011903970358201c1d917351625d1087065d2cc19766352374f6396f18d65769f66238f2176992',
      ),
    );

    expect(projectParsedTransaction(parsed)).toMatchObject({
      payloadSummary: {
        kind: 'tokenUpdate',
        operations: [
          {
            transfer: {
              memo: {
                cbor: 'first op',
                hex: '686669727374206f70',
              },
            },
          },
          {
            transfer: {
              memo: {
                cbor: {
                  index: 2,
                  purpose: 'demo',
                },
                hex: 'a267707572706f73656464656d6f65696e64657802',
              },
            },
          },
        ],
      },
    });
    expect(JSON.stringify(projectParsedTransaction(parsed).payloadSummary)).not.toContain('"text":"first op"');
  });

  it('parses unsponsored unsigned builder transfer-with-memo hex into a normalized account transaction', () => {
    const parsed = expectAccountTransaction(parse(transactionFixtures.unsignedTransferWithMemoHex));

    expect(parsed.version).toBe(0);
    expect(parsed.payloadType).toBe('transferWithMemo');
    expect(parsed.header.sender).toBe('3BRQgT1WY48tQUcgRNNqqSifo2VEENkY4gCX3Qx9UQ9S7kYVLP');
    expect(parsed.header.nonce).toBe(1n);
    expect(parsed.signatureState.senderSignatureCount).toBe(0);
    expect(parsed.signatureState.sponsorSignatureCount).toBe(0);
    expect(parsed.payloadSummary).toEqual({
      kind: 'transferWithMemo',
      amount: '1000',
      memo: {
        hex: '000568656c6c6f',
        text: 'hello',
      },
      toAddress: '3xAJhMaYdBqVb2pyo34nFuNGqsEbtvVaHBELaPoRm9gPvqDqus',
    });
  });

  it('parses unsponsored unsigned builder configure-delegation hex into a normalized account transaction', () => {
    const parsed = expectAccountTransaction(parse(transactionFixtures.unsignedConfigureDelegationPoolHex));

    expect(parsed.version).toBe(0);
    expect(parsed.payloadType).toBe('configureDelegation');
    expect(parsed.header.sender).toBe('3BRQgT1WY48tQUcgRNNqqSifo2VEENkY4gCX3Qx9UQ9S7kYVLP');
    expect(parsed.header.nonce).toBe(1n);
    expect(parsed.signatureState.senderSignatureCount).toBe(0);
    expect(parsed.signatureState.sponsorSignatureCount).toBe(0);
    expect(parsed.payloadSummary).toEqual({
      delegationTarget: {
        bakerId: 42,
        delegateType: 'Baker',
      },
      kind: 'configureDelegation',
      restakeEarnings: true,
      stake: '1000',
    });
  });

  it('parses account-opening credential deployment signing handoff hex', () => {
    const parsed = parse(transactionFixtures.credentialDeploymentSigningReviewNewAccountHex);

    expect(parsed).toMatchObject({
      kind: 'credentialDeploymentSigning',
      target: {
        type: 'new_account',
        messageExpiry: '1790353687',
        messageExpiryDate: '2026-09-25T16:28:07.000Z',
      },
      credentialPublicKeys: {
        threshold: 1,
        keys: {
          '0': transactionFixtures.credentialDeploymentSigningPublicKey,
        },
      },
      credential: expect.objectContaining({
        credentialPublicKeys: {
          threshold: 1,
          keys: { '0': transactionFixtures.credentialDeploymentSigningPublicKey },
        },
      }),
      proofs: { byteLength: 966 },
      unsignedCredentialDeploymentHex: transactionFixtures.credentialDeploymentSigningReviewUnsignedHex,
      targetContextHex: '00000000006ab6a117',
    });
  });

  it('parses existing-account credential deployment signing handoff hex', () => {
    const parsed = parse(transactionFixtures.credentialDeploymentSigningReviewExistingAccountHex);

    expect(parsed).toMatchObject({
      kind: 'credentialDeploymentSigning',
      target: {
        type: 'existing_account',
        accountAddress: transactionFixtures.existingAccountCredentialTargetAddress,
      },
      credentialPublicKeys: {
        threshold: 1,
        keys: {
          '0': transactionFixtures.credentialDeploymentSigningPublicKey,
        },
      },
      unsignedCredentialDeploymentHex: transactionFixtures.credentialDeploymentSigningReviewUnsignedHex,
      targetContextHex: transactionFixtures.credentialDeploymentSigningReviewExistingAccountHex.slice(0, 66),
    });
  });

  it('parses finalized credential deployment block items with a review summary', () => {
    const parsed = parse(transactionFixtures.finalizedCredentialDeploymentHex);

    expect(parsed).toEqual({
      credential: {
        anonymityRevokerCount: 0,
        createdAt: '202609',
        createdAtDate: '2026-09',
        credentialId: 'aa'.repeat(48),
        credentialPublicKeys: {
          keys: { '0': transactionFixtures.credentialDeploymentSigningPublicKey },
          threshold: 1,
        },
        deploymentType: 'normal',
        identityProvider: 0,
        revealedAttributeCount: 0,
        revealedAttributes: {},
        revocationThreshold: 1,
        validTo: '202709',
        validToDate: '2027-09',
      },
      expiry: 1790353687000,
      expiryDate: '2026-09-25T16:28:07.000Z',
      kind: 'credentialDeployment',
      proofs: {
        byteLength: 966,
      },
    });
  });

  it('normalizes a structured signing-handoff decoder result without revalidating its credential bytes', () => {
    vi.mocked(summarizeCredentialDeploymentSigningHandoff).mockReturnValueOnce({
      kind: 'credentialDeploymentSigning',
      target: { type: 'new_account', messageExpiry: '1' },
      credential: {
        anonymityRevokerCount: 0,
        createdAt: '202601',
        createdAtDate: '2026-01',
        credentialId: 'aa'.repeat(48),
        credentialPublicKeys: { keys: { '7': ed25519PublicKey.require('bb'.repeat(32)) }, threshold: 1 },
        deploymentType: 'normal',
        identityProvider: 4,
        revealedAttributeCount: 1,
        revealedAttributes: { firstName: 'A\n"B' },
        revocationThreshold: 1,
        validTo: '202701',
        validToDate: '2027-01',
      },
      proofs: { byteLength: 3 },
    });

    expect(parse('000000000000000001aa')).toMatchObject({
      kind: 'credentialDeploymentSigning',
      credentialPublicKeys: { keys: { '7': ed25519PublicKey.require('bb'.repeat(32)) }, threshold: 1 },
      credential: { revealedAttributes: { firstName: 'A\n"B' } },
      proofs: { byteLength: 3 },
      targetContextHex: '000000000000000001',
      unsignedCredentialDeploymentHex: 'aa',
    });
  });

  it('maps a signing-handoff decoder error to the stable parser error', () => {
    vi.mocked(summarizeCredentialDeploymentSigningHandoff).mockImplementationOnce(() => {
      throw new Error('malformed handoff');
    });

    expect(() => parse('02')).toThrowError(ParseTransactionError);
  });

  it('preserves SDK-parsed initial credentials without inventing a normal-credential summary', () => {
    // A valid compressed BLS12-381 G1 point keeps this on the SDK's authoritative decode path.
    const registrationId =
      '97f1d3a73197d7942695638c4fa9ac0fc3688c4f9774b905a14e3a3f171bac586c55e83ff97a1aeffb3af00adb22c6bb';
    const initialValues = `010000${transactionFixtures.credentialDeploymentSigningPublicKey}01${registrationId}0000000007eb0907ea090000`;
    expect(parse(`01000000006ab6a11700${initialValues}${'11'.repeat(64)}`)).toEqual({
      kind: 'credentialDeployment',
      expiry: 1790353687000,
      expiryDate: '2026-09-25T16:28:07.000Z',
    });
  });

  it('fails with an unsupported format error when input cannot be classified', () => {
    expect(() => parse('not-a-transaction')).toThrowError(ParseTransactionError);

    try {
      parse('not-a-transaction');
    } catch (error) {
      expect(error).toBeInstanceOf(ParseTransactionError);
      expect((error as ParseTransactionError).code).toBe('unsupported_format');
      expect((error as ParseTransactionError).message).toBe('Transaction input is not supported transaction hex.');
    }
  });

  it('fails with an SDK parse error when hex input is malformed', () => {
    expect(() => parse('00ff', { format: 'hex' })).toThrowError(ParseTransactionError);

    try {
      parse('00ff', { format: 'hex' });
    } catch (error) {
      expect(error).toBeInstanceOf(ParseTransactionError);
      expect((error as ParseTransactionError).code).toBe('sdk_parse_failed');
    }
  });

  it('falls back to raw hex when a transfer memo blob cannot be decoded', () => {
    const fromJsonSpy = vi.spyOn(DataBlob, 'fromJSON').mockImplementation(() => {
      throw new Error('bad blob');
    });

    const parsed = expectAccountTransaction(parse(transactionFixtures.unsignedTransferWithMemoHex));

    expect(parsed.payloadSummary).toEqual({
      kind: 'transferWithMemo',
      amount: '1000',
      memo: {
        hex: '000568656c6c6f',
      },
      toAddress: '3xAJhMaYdBqVb2pyo34nFuNGqsEbtvVaHBELaPoRm9gPvqDqus',
    });

    fromJsonSpy.mockRestore();
  });
});
