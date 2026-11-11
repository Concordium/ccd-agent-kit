import { describe, expect, it } from 'vitest';

import { describeTransaction } from '../../../../src/core/describe/describeTransaction.js';
import { parseTransaction } from '../../../../src/core/parser/parseTransaction.js';
import { transactionFixtures } from '../../../helpers/transactionFixtures.js';

describe('describeTransaction', () => {
  it('renders a compact account transaction summary', () => {
    const parsed = parseTransaction(transactionFixtures.v1SponsoredHexString);

    expect(describeTransaction(parsed)).toBe(
      `Type: transfer\nVersion: v1\nSender: ${transactionFixtures.sender}\nNonce: 2\nMax energy: 785\nAmount: 2\nTo: ${transactionFixtures.receiver}\nSponsor: ${transactionFixtures.sponsor}`,
    );
  });

  it('renders transfer memo details when present in unsigned hex', () => {
    const parsed = parseTransaction(transactionFixtures.unsignedTransferWithMemoHex);

    expect(describeTransaction(parsed)).toBe(
      'Type: transferWithMemo\nVersion: v0\nSender: 3BRQgT1WY48tQUcgRNNqqSifo2VEENkY4gCX3Qx9UQ9S7kYVLP\nNonce: 1\nMax energy: 508\nAmount: 1000\nTo: 3xAJhMaYdBqVb2pyo34nFuNGqsEbtvVaHBELaPoRm9gPvqDqus\nMemo: hello',
    );
  });

  it('renders configure-delegation details from unsigned hex', () => {
    const parsed = parseTransaction(transactionFixtures.unsignedConfigureDelegationPoolHex);

    expect(describeTransaction(parsed)).toBe(
      'Type: configureDelegation\nVersion: v0\nSender: 3BRQgT1WY48tQUcgRNNqqSifo2VEENkY4gCX3Qx9UQ9S7kYVLP\nNonce: 1\nMax energy: 481\nStake: 1000\nRestake: true\nTarget: Baker',
    );
  });

  it('pretty-prints decoded token-update operations', () => {
    const parsed = parseTransaction(
      '000081feabcdfb642556262da46ba755f99d835fb1c31265e3b937042ca2f9b5fec7000000000000000c000000000000029000000060000000006a9953841b0946726565546f6b656e0000005181a1687472616e73666572a266616d6f756e74c482250169726563697069656e74d99d73a201d99d71a1011903970358201c1d917351625d1087065d2cc19766352374f6396f18d65769f66238f2176992',
    );

    expect(describeTransaction(parsed)).toContain('Type: tokenUpdate\nVersion: v0');
    expect(describeTransaction(parsed)).toContain('Token: FreeToken');
    expect(describeTransaction(parsed)).toContain('"transfer"');
  });

  it('renders credential deployment review details when available', () => {
    const parsed = parseTransaction(transactionFixtures.finalizedCredentialDeploymentHex);

    expect(describeTransaction(parsed)).toBe(
      [
        'Type: credentialDeployment',
        'Expiry: 2026-09-25T16:28:07.000Z',
        'Credential type: normal',
        'Credential keys: 1',
        'Threshold: 1',
        'Identity provider: 0',
        'Anonymity revokers: 0',
        'Valid to: 2027-09',
        'Created at: 2026-09',
        'Revealed attributes: {}',
        'Ownership proof bytes: 966',
      ].join('\n'),
    );
  });

  it('renders credential deployment signing handoff summaries', () => {
    const parsed = parseTransaction(transactionFixtures.credentialDeploymentSigningReviewNewAccountHex);

    expect(describeTransaction(parsed)).toBe(
      `Type: credentialDeploymentSigning\nTarget: new account\nMessage expiry: 2026-09-25T16:28:07.000Z\nCredential keys: 1\nThreshold: 1\nRevealed attributes: {}\nOwnership proof bytes: 966`,
    );
  });

  // Existing-account selection, expiry fallback, and disclosed-value escaping are unit-owned renderer decisions.
});
