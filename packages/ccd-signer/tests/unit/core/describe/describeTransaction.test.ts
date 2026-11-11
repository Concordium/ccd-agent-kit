import {
  CborAccountAddress,
  Payload,
  TokenId,
  TokenOperationType,
  createTokenUpdatePayload,
  type Operation,
  type TokenOperation,
} from '@concordium/web-sdk';
import { ed25519PublicKey } from '@ccd-agent-kit/sdk-utils';
import { describe, expect, it } from 'vitest';

import { describeTransaction } from '../../../../src/core/describe/describeTransaction.js';
import { parseTransaction } from '../../../../src/core/parser/parseTransaction.js';
import type { ParsedAccountTransaction, ParsedPayloadSummary } from '../../../../src/core/model/parsedTransaction.js';
import { transactionFixtures } from '../../../helpers/transactionFixtures.js';
import { unsignedHexForPayload } from '../../../helpers/unsignedAccountTransaction.js';

describe('describeTransaction', () => {
  const baseHeader = {
    sender: transactionFixtures.sender,
    nonce: 22n,
    expiry: 1735689600000,
    energy: 300n,
  };

  const signatureState = {
    senderSignatureCount: 0,
    sponsorSignatureCount: 0,
  };
  const accountTransaction = (
    payloadType: string,
    payloadSummary: ParsedPayloadSummary,
    nonce = 22n,
    energy = baseHeader.energy,
    version: 0 | 1 = 0,
  ): ParsedAccountTransaction => ({
    kind: 'accountTransaction',
    version,
    payloadType,
    payloadSummary,
    header: { ...baseHeader, nonce, energy },
    signatureState,
  });
  const knownOperation = (operation: TokenOperation | Operation) => ({
    kind: 'knownOperation' as const,
    operation,
    participantLabels: new Map<CborAccountAddress.Type, string>(),
  });

  it.each([
    { version: 0 as const, energy: 0n, expectedEnergy: '0' },
    { version: 1 as const, energy: 9_007_199_254_740_993n, expectedEnergy: '9007199254740993' },
  ])('renders the exact v$version account energy budget', ({ version, energy, expectedEnergy }) => {
    expect(
      describeTransaction(
        accountTransaction('unknownPayload', { kind: 'generic', type: 'unknownPayload' }, 13n, energy, version),
      ),
    ).toBe(
      `Type: unknownPayload\nVersion: v${version}\nSender: ${transactionFixtures.sender}\nNonce: 13\nMax energy: ${expectedEnergy}`,
    );
  });

  it('renders empty configure-delegation fields when optional values are absent', () => {
    expect(describeTransaction(accountTransaction('configureDelegation', { kind: 'configureDelegation' }, 18n))).toBe(
      `Type: configureDelegation\nVersion: v0\nSender: ${transactionFixtures.sender}\nNonce: 18\nMax energy: 300\nStake: \nRestake: \nTarget: `,
    );
  });

  it('renders empty configure-validator fields when optional values are absent', () => {
    expect(describeTransaction(accountTransaction('configureBaker', { kind: 'configureValidator' }, 19n))).toBe(
      `Type: configureBaker\nVersion: v0\nSender: ${transactionFixtures.sender}\nNonce: 19\nMax energy: 300\nStake: \nRestake: \nOpen: \nMetadata: \nCommission: //`,
    );
  });

  it('renders module deployment and contract init/update summaries', () => {
    expect(
      describeTransaction({
        kind: 'accountTransaction',
        version: 0,
        payloadType: 'deployModule',
        payloadSummary: { kind: 'deployModule', source: 'module-bytes' },
        header: baseHeader,
        signatureState,
      }),
    ).toBe(
      `Type: deployModule\nVersion: v0\nSender: ${transactionFixtures.sender}\nNonce: 22\nMax energy: 300\nSource: module-bytes`,
    );

    expect(
      describeTransaction({
        kind: 'accountTransaction',
        version: 0,
        payloadType: 'initContract',
        payloadSummary: {
          kind: 'initContract',
          amount: '7',
          initName: 'init_demo',
          moduleRef: 'module-ref',
          param: '00',
        },
        header: baseHeader,
        signatureState,
      }),
    ).toBe(
      `Type: initContract\nVersion: v0\nSender: ${transactionFixtures.sender}\nNonce: 22\nMax energy: 300\nAmount: 7\nInit: init_demo\nModule: module-ref\nParam: 00`,
    );

    expect(
      describeTransaction({
        kind: 'accountTransaction',
        version: 0,
        payloadType: 'updateContract',
        payloadSummary: {
          kind: 'updateContract',
          amount: '9',
          address: { index: 1, subindex: 0 },
          receiveName: 'demo.receive',
          message: 'ff',
        },
        header: baseHeader,
        signatureState,
      }),
    ).toBe(
      `Type: updateContract\nVersion: v0\nSender: ${transactionFixtures.sender}\nNonce: 22\nMax energy: 300\nAmount: 9\nContract: 1/0\nReceive: demo.receive\nMessage: ff`,
    );
  });

  it('renders credential and unscoped token-update summaries', () => {
    expect(
      describeTransaction({
        kind: 'accountTransaction',
        version: 0,
        payloadType: 'updateCredentials',
        payloadSummary: {
          kind: 'updateCredentials',
          threshold: 2,
          newCredentialCount: 3,
          removeCredentialIds: ['old'],
        },
        header: baseHeader,
        signatureState,
      }),
    ).toBe(
      `Type: updateCredentials\nVersion: v0\nSender: ${transactionFixtures.sender}\nNonce: 22\nMax energy: 300\nThreshold: 2\nNew: 3\nRemove: 1`,
    );

    expect(
      describeTransaction({
        kind: 'accountTransaction',
        version: 0,
        payloadType: 'moduleReference',
        payloadSummary: {
          kind: 'tokenUpdate',
          variant: 'unscoped',
          operations: [knownOperation({ tokenPause: { token: TokenId.fromString('TOK') } })],
        },
        header: baseHeader,
        signatureState,
      }),
    ).toContain('Operations:\n[\n  {\n    "tokenPause": {\n      "token": "TOK"\n    }\n  }\n]');
  });

  it('preserves supported metadata fields in human operation JSON', () => {
    const metadata = {
      url: 'https://example.com/token.json',
      checksumSha256: Uint8Array.from({ length: 32 }, () => 0xaa),
    };
    const parsed = parseTransaction(
      unsignedHexForPayload(
        Payload.tokenUpdate(
          createTokenUpdatePayload({
            tokenId: TokenId.fromString('TOK'),
            operations: { [TokenOperationType.UpdateMetadata]: metadata },
          }),
        ),
        0,
      ),
    );

    expect(describeTransaction(parsed)).toContain(`"checksumSha256": "${'aa'.repeat(32)}"`);
  });

  it('renders credential deployment summaries', () => {
    expect(
      describeTransaction({
        kind: 'credentialDeployment',
        expiry: 1736002096000,
      }),
    ).toBe('Type: credentialDeployment\nExpiry: 1736002096000');
  });

  it('falls back to numeric expiry and omits absent proof signature counts', () => {
    expect(
      describeTransaction({
        kind: 'credentialDeployment',
        expiry: 1736002096000,
        credential: {
          deploymentType: 'normal',
          credentialId: 'ab'.repeat(48),
          credentialPublicKeys: { threshold: 1, keys: { '0': ed25519PublicKey.require('aa'.repeat(32)) } },
          identityProvider: 7,
          anonymityRevokerCount: 2,
          revocationThreshold: 1,
          validTo: '202709',
          validToDate: '2027-09',
          createdAt: '202609',
          createdAtDate: '2026-09',
          revealedAttributeCount: 3,
          revealedAttributes: { firstName: 'Ada', lastName: 'Lovelace', nationality: 'GB' },
        },
        proofs: { byteLength: 12 },
      }),
    ).toBe(
      [
        'Type: credentialDeployment',
        'Expiry: 1736002096000',
        'Credential type: normal',
        'Credential keys: 1',
        'Threshold: 1',
        'Identity provider: 7',
        'Anonymity revokers: 2',
        'Valid to: 2027-09',
        'Created at: 2026-09',
        'Revealed attributes: {"firstName":"Ada","lastName":"Lovelace","nationality":"GB"}',
        'Ownership proof bytes: 12',
      ].join('\n'),
    );
  });

  it('renders structured signing-handoff details and JSON-escapes disclosed values', () => {
    const disclosedValue = 'A\n"B\u007f\u0085\u202e\u2028';
    const transaction = {
      kind: 'credentialDeploymentSigning',
      target: { type: 'new_account', messageExpiry: '1', messageExpiryDate: '1970-01-01T00:00:01.000Z' },
      credentialPublicKeys: {
        keys: { '0': ed25519PublicKey.require(transactionFixtures.credentialDeploymentSigningPublicKey) },
        threshold: 1,
      },
      credential: {
        anonymityRevokerCount: 0,
        createdAt: '202601',
        createdAtDate: '2026-01',
        credentialId: 'bb'.repeat(48),
        credentialPublicKeys: { keys: { '0': ed25519PublicKey.require('aa'.repeat(32)) }, threshold: 1 },
        deploymentType: 'normal',
        identityProvider: 7,
        revealedAttributeCount: 1,
        revealedAttributes: { firstName: disclosedValue },
        revocationThreshold: 1,
        validTo: '202701',
        validToDate: '2027-01',
      },
      proofs: { byteLength: 12 },
      targetContextHex: '000000000000000001',
      unsignedCredentialDeploymentHex: 'aa',
    } as const;

    expect(describeTransaction(transaction)).toBe(
      'Type: credentialDeploymentSigning\nTarget: new account\nMessage expiry: 1970-01-01T00:00:01.000Z\nCredential keys: 1\nThreshold: 1\nRevealed attributes: {"firstName":"A\\n\\"B\\u007f\\u0085\\u202e\\u2028"}\nRevealed attribute firstName: "A\\n\\"B\\u007f\\u0085\\u202e\\u2028"\nOwnership proof bytes: 12',
    );
    expect(transaction.credential.revealedAttributes.firstName).toBe(disclosedValue);
  });

  it('falls back to raw hex when no decoded binary view is available', () => {
    expect(
      describeTransaction(accountTransaction('registerData', { kind: 'registerData', data: { hex: 'beef' } }, 17n)),
    ).toBe(
      `Type: registerData\nVersion: v0\nSender: ${transactionFixtures.sender}\nNonce: 17\nMax energy: 300\nData: beef`,
    );
  });

  it('renders decoded CBOR string values without JSON quoting', () => {
    expect(
      describeTransaction(
        accountTransaction('registerData', { kind: 'registerData', data: { hex: '6568656c6c6f', cbor: 'hello' } }, 20n),
      ),
    ).toBe(
      `Type: registerData\nVersion: v0\nSender: ${transactionFixtures.sender}\nNonce: 20\nMax energy: 300\nData: hello`,
    );
  });

  it('renders decoded CBOR objects as compact JSON', () => {
    expect(
      describeTransaction(
        accountTransaction(
          'registerData',
          { kind: 'registerData', data: { hex: 'a1646e6f74656464656d6f', cbor: { note: 'demo' } } },
          21n,
        ),
      ),
    ).toBe(
      `Type: registerData\nVersion: v0\nSender: ${transactionFixtures.sender}\nNonce: 21\nMax energy: 300\nData: {"note":"demo"}`,
    );
  });

  it('omits extra details for generic payload summaries', () => {
    expect(
      describeTransaction(accountTransaction('unknownPayload', { kind: 'generic', type: 'unknownPayload' }, 13n)),
    ).toBe(`Type: unknownPayload\nVersion: v0\nSender: ${transactionFixtures.sender}\nNonce: 13\nMax energy: 300`);
  });
});
