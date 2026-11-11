import { describe, expect, it } from 'vitest';
import {
  accountOpeningInputSchema,
  credentialDiscoveryInputSchema,
  identityDiscoveryInputSchema,
  identityRequestInputSchema,
  identitySourceAssociationInputSchema,
  parseIdentityObject,
  parseSelection,
  parseStoredIdentity,
  safeHttpUrl,
} from '../../src/core/workflowValidation.js';
import { softwareDevice } from '../helpers.js';
import { SOURCE_ID,awaitingRecord } from '../workflowFixtures.js';

const selection = () => ({
  network: 'localnet',
  rootPublicKey: softwareDevice().publicKey.toString('hex'),
  identityProviderIndex: 0,
  identityIndex: 0,
});
const identity = () => ({
  v: 0,
  value: {
    preIdentityObject: {
      idCredPub: 'ab'.repeat(48),
      choiceArData: { arIdentities: [1, 2], threshold: 2 },
      ipArData: {
        '1': { encPrfKeyShare: 'ab', proofComEncEq: 'ab' },
        '2': { encPrfKeyShare: 'ab', proofComEncEq: 'ab' },
      },
      idCredSecCommitment: 'ab',
      prfKeyCommitmentWithIP: 'ab',
      prfKeySharingCoeffCommitments: ['ab', 'cd'],
      proofsOfKnowledge: 'ab',
    },
    attributeList: {
      createdAt: '202610',
      validTo: '202710',
      maxAccounts: 5,
      chosenAttributes: { firstName: 'PRIVATE ATTRIBUTE' },
    },
    signature: 'ab'.repeat(96),
  },
});

describe('identity workflow validation', () => {
  it('accepts inclusive scan starts and rejects reversed or incompatible ranges', () => {
    expect(identityDiscoveryInputSchema.parse({ startIndex: 4, endIndex: 4 })).toMatchObject({
      startIndex: 4,
      endIndex: 4,
    });
    expect(identityDiscoveryInputSchema.safeParse({ startIndex: 5, endIndex: 4 }).success).toBe(false);
    expect(identityDiscoveryInputSchema.safeParse({ startIndex: -1 }).success).toBe(false);
    const identityId = '01'.repeat(32);
    expect(credentialDiscoveryInputSchema.parse({ identityId, startCredentialNumber: 4 })).toHaveProperty(
      'startCredentialNumber',
      4,
    );
    expect(
      credentialDiscoveryInputSchema.safeParse({ identityId, startCredentialNumber: 5, endCredentialNumber: 4 })
        .success,
    ).toBe(false);
    expect(credentialDiscoveryInputSchema.safeParse({ identityId, full: true, startCredentialNumber: 0 }).success).toBe(
      false,
    );
    expect(credentialDiscoveryInputSchema.safeParse({ identityId, full: true, endCredentialNumber: 4 }).success).toBe(
      false,
    );
    expect(credentialDiscoveryInputSchema.safeParse({ identityId, startCredentialNumber: 256 }).success).toBe(false);
  });
  it('preserves all identity/proof fields without treating attribute strings as cryptographic bytes', () => {
    expect(parseIdentityObject(identity())).toEqual(identity());
    expect(parseSelection({ ...selection(), sdkNetwork: 'Testnet' }).rootPublicKey).toHaveLength(130);
  });
  it.each([
    { device: '../device' },
    { identityIndex: -1 },
    { identityProviderIndex: 2 ** 31 },
    { sdkNetwork: 'localnet' },
    { rootPublicKey: '04' + '00'.repeat(64) },
    { walletProxyUrl: 'http://remote.example' },
    { network: '' },
  ])('rejects invalid selectors without reflecting values: %j', (change) => {
    expect(() => parseSelection({ ...selection(), sdkNetwork: 'Testnet', ...change })).toThrow();
  });
  it.each([
    'file:///protected/state',
    'https://user:password@example.com/',
    'http://example.com/',
    'https://example.com/#secret',
  ])('rejects unsafe HTTP destinations %s', (url) => {
    expect(() => safeHttpUrl(url)).toThrow();
  });
  it.each(['https://example.com/path', 'http://127.0.0.1:7011/api', 'http://localhost:7013'])(
    'accepts HTTPS or loopback HTTP %s',
    (url) => {
      expect(safeHttpUrl(url)).toBeInstanceOf(URL);
    },
  );
  it('checks the response envelope without duplicating SDK validation of trusted issuer contents', () => {
    const input = identity();
    expect(() => parseIdentityObject({ ...input, v: 1 })).toThrow();
    expect(() => parseIdentityObject({ v: 0, value: {} })).toThrow();
    const withIssuerExtension = { ...input, value: { ...input.value, issuerExtension: 'preserved' } };
    expect(parseIdentityObject(withIssuerExtension)).toEqual(withIssuerExtension);
  });
  it('accepts encrypted-ready metadata while validating any attached in-memory identity and rejecting secret fields', () => {
    const record = {
      version: 1,
      id: '01'.repeat(32),
      sourceId: SOURCE_ID,
      selection: { ...selection(), device: '123', sdkNetwork: 'Testnet', walletProxyUrl: 'http://localhost:7013' },
      contextHash: 'ab'.repeat(32),
      idCredPub: identity().value.preIdentityObject.idCredPub,
      status: 'ready',
      identity: identity(),
    };
    expect(parseStoredIdentity(record)).toEqual(record);
    const historical = { ...record };
    delete (historical as Partial<typeof record>).sourceId;
    expect(parseStoredIdentity(historical)).not.toHaveProperty('sourceId');
    expect(parseStoredIdentity({ ...record, identity: undefined })).not.toHaveProperty('identity');
    expect(() => parseStoredIdentity({ ...record, sourceId: SOURCE_ID.toUpperCase() })).toThrow();
    expect(() => parseStoredIdentity({ ...record, sourceId: 'a'.repeat(14) })).toThrow();
    expect(() => parseStoredIdentity({ ...record, idCredPub: 'cd'.repeat(48) })).toThrow();
    expect(() => parseStoredIdentity({ ...record, seed: 'secret' })).toThrow();
    expect(() =>
      parseStoredIdentity({
        ...record,
        status: 'awaiting_verification',
        identity: undefined,
        request: { v: 0, value: { ...identity().value.preIdentityObject, idCredPub: 'cd'.repeat(48) } },
      }),
    ).toThrow();
    expect(() =>
      parseStoredIdentity({
        ...record,
        identity: {
          ...identity(),
          value: {
            ...identity().value,
            preIdentityObject: { ...identity().value.preIdentityObject, proofsOfKnowledge: 'cd' },
          },
        },
        request: { v: 0, value: identity().value.preIdentityObject },
      }),
    ).toThrow();
  });

  it.each([
    ['request', { request: { v: 0, value: identity().value.preIdentityObject } }],
    ['requestAttemptId', { requestAttemptId: '018f47a2-43d2-7ad9-8b5e-89d810f95a22' }],
    ['postIssuance', { postIssuance: { status: 'unconfirmed' } }],
    ['authorizationUrl', { authorizationUrl: 'https://issuer.example.test/verify' }],
    ['retrievalUrl', { retrievalUrl: 'https://issuer.example.test/result' }],
    ['confirmedFailure', {
      requestAttemptId: '018f47a2-43d2-7ad9-8b5e-89d810f95a22',
      confirmedFailure: {
        kind: 'authenticated_key_failure', requestAttemptId: '018f47a2-43d2-7ad9-8b5e-89d810f95a22',
      },
    }],
  ] as const)('rejects %s on the strict ready record shape', (_field, transient) => {
    const record = {
      version: 1, id: '01'.repeat(32), sourceId: SOURCE_ID,
      selection: { ...selection(), sdkNetwork: 'Testnet' },
      contextHash: 'ab'.repeat(32), idCredPub: identity().value.preIdentityObject.idCredPub,
      status: 'ready', ...transient,
    };
    expect(() => parseStoredIdentity(record)).toThrow();
  });

  it.each(['awaiting_verification', 'pending', 'expired'] as const)(
    'retains transient issuance metadata on the %s lifecycle status', (status) => {
      const record = {
        version: 1, id: '01'.repeat(32), sourceId: SOURCE_ID,
        selection: { ...selection(), sdkNetwork: 'Testnet' },
        contextHash: 'ab'.repeat(32), idCredPub: identity().value.preIdentityObject.idCredPub,
        status,
        request: { v: 0, value: identity().value.preIdentityObject },
        requestAttemptId: '018f47a2-43d2-7ad9-8b5e-89d810f95a22',
        postIssuance: { status: 'created', url: 'https://issuer.example.test/verify',
          statusUrl: 'https://issuer.example.test/agent-id/context/identity-object' },
        authorizationUrl: 'https://issuer.example.test/verify',
        retrievalUrl: 'https://issuer.example.test/result',
      };
      expect(parseStoredIdentity(record)).toEqual(record);
    },
  );

  it('retains attempt-bound confirmed failure metadata on the error lifecycle status', () => {
    const requestAttemptId = '018f47a2-43d2-7ad9-8b5e-89d810f95a22';
    const record = {
      version: 1, id: '01'.repeat(32), sourceId: SOURCE_ID,
      selection: { ...selection(), sdkNetwork: 'Testnet' },
      contextHash: 'ab'.repeat(32), idCredPub: identity().value.preIdentityObject.idCredPub,
      status: 'error', request: { v: 0, value: identity().value.preIdentityObject }, requestAttemptId,
      confirmedFailure: { kind: 'authenticated_key_failure', requestAttemptId },
    };
    expect(parseStoredIdentity(record)).toEqual(record);
  });

  it('rejects a lifecycle request whose public credential does not match its durable pin', () => {
    const record = awaitingRecord();
    record.request = {
      ...record.request,
      value: { ...record.request.value, idCredPub: 'cd'.repeat(48) },
    };
    expect(() => parseStoredIdentity(record)).toThrowError(expect.objectContaining({ code: 'STORAGE_FAILED' }));
  });
  it('validates the persisted SDK namespace separately from public start input', () => {
    expect(parseSelection({ ...selection(), sdkNetwork: 'Testnet' }).sdkNetwork).toBe('Testnet');
    expect(parseSelection({ ...selection(), sdkNetwork: 'Testnet' })).not.toHaveProperty('device');
    expect(parseSelection({ ...selection(), sdkNetwork: 'Testnet', device: '123' }).device).toBe('123');
    expect(() => parseSelection({ ...selection(), sdkNetwork: 'Devnet' })).toThrow();
  });

  it.each(['Name', '@agent_name', `@A${'b'.repeat(48)}`])('accepts valid raw persisted labels: %s', (label) => {
    const record = {
      version: 1,
      id: '01'.repeat(32),
      label,
      sourceId: SOURCE_ID,
      selection: { ...selection(), device: '123', sdkNetwork: 'Testnet', walletProxyUrl: 'http://localhost:7013' },
      contextHash: 'ab'.repeat(32),
      idCredPub: identity().value.preIdentityObject.idCredPub,
      status: 'ready',
      identity: identity(),
    };
    expect(parseStoredIdentity(record)).toMatchObject({ label });
  });

  it.each([
    '',
    '@',
    '@@name',
    '1name',
    '@1name',
    'bad label',
    'bad/name',
    'éclair',
    `A${'b'.repeat(49)}`,
    `@A${'b'.repeat(49)}`,
  ])('rejects malformed persisted labels: %s', (label) => {
    const record = {
      version: 1,
      id: '01'.repeat(32),
      label,
      sourceId: SOURCE_ID,
      selection: { ...selection(), device: '123', sdkNetwork: 'Testnet', walletProxyUrl: 'http://localhost:7013' },
      contextHash: 'ab'.repeat(32),
      idCredPub: identity().value.preIdentityObject.idCredPub,
      status: 'ready',
      identity: identity(),
    };
    expect(() => parseStoredIdentity(record)).toThrow();
  });

  it('keeps a persisted unlabeled record valid without default filling', () => {
    const record = {
      version: 1,
      id: '01'.repeat(32),
      sourceId: SOURCE_ID,
      selection: { ...selection(), device: '123', sdkNetwork: 'Testnet', walletProxyUrl: 'http://localhost:7013' },
      contextHash: 'ab'.repeat(32),
      idCredPub: identity().value.preIdentityObject.idCredPub,
      status: 'ready',
      identity: identity(),
    };
    expect(parseStoredIdentity(record)).not.toHaveProperty('label');
  });

  it('accepts and trims bare request labels and ID-or-label selectors on public core schemas', () => {
    expect(identityRequestInputSchema.parse({ identityProviderIndex: 7, label: ' requested ' })).toMatchObject({
      label: 'requested',
    });
    expect(credentialDiscoveryInputSchema.parse({ identityId: ' stored ' })).toMatchObject({ identityId: 'stored' });
    expect(identitySourceAssociationInputSchema.parse({ identityId: 'Protected' })).toMatchObject({
      identityId: 'Protected',
    });
    expect(
      accountOpeningInputSchema.parse({
        identityId: ' Stored ',
        publicKeys: { '0': '11'.repeat(32), '7': '22'.repeat(32) },
        credentialThreshold: 2,
        expirySeconds: 1,
      }),
    ).toMatchObject({
      identityId: 'Stored',
      publicKeys: { '0': '11'.repeat(32), '7': '22'.repeat(32) },
      credentialThreshold: 2,
    });
    expect(
      accountOpeningInputSchema.safeParse({
        identityId: 'Stored',
        publicKey: '11'.repeat(32),
        expirySeconds: 1,
      }).success,
    ).toBe(false);
  });

  it('rejects 256 public keys before account-opening serialization', () => {
    const publicKeys = Object.fromEntries(Array.from({ length: 256 }, (_, index) => [String(index), '11'.repeat(32)]));

    expect(
      accountOpeningInputSchema.safeParse({
        identityId: 'Stored',
        publicKeys,
        credentialThreshold: 255,
        expirySeconds: 1,
      }).success,
    ).toBe(false);
  });

  it.each([
    { identityProviderIndex: 7, label: '1bad' },
    { identityProviderIndex: 7, label: '@@bad' },
    { identityProviderIndex: 7, label: '@ok', authority: 'agent' },
    { identityProviderIndex: 7, source: '@not-a-source' },
  ])('rejects invalid, authority-bearing, or source-confused request input: %j', (input) => {
    expect(identityRequestInputSchema.safeParse(input).success).toBe(false);
  });

  it.each(['0'.repeat(63), 'A'.repeat(64), '@1bad', '@@bad', 'bad label', 'bad/name'])(
    'rejects invalid public identity selectors: %s',
    (identityId) => {
      expect(credentialDiscoveryInputSchema.safeParse({ identityId }).success).toBe(false);
      expect(identitySourceAssociationInputSchema.safeParse({ identityId }).success).toBe(false);
    },
  );
});
