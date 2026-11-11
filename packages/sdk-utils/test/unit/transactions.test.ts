import { createHash } from 'node:crypto';

import {
  AccountTransactionV0,
  Payload,
  buildBasicAccountSigner,
  getCredentialDeploymentSignDigest,
  type UnsignedCredentialDeploymentInformation,
} from '@concordium/web-sdk';
import * as ed from '@concordium/web-sdk/shims/ed25519';
import { describe, expect, it } from 'vitest';

import {
  buildAccountOpeningCredentialDeploymentHandoff,
  assembleSignedCredentialDeployment,
  finalizeAccountTransactionHex,
  finalizeParsedAccountTransaction,
  finalizeCredentialDeploymentHex,
  summarizeCredentialDeploymentBlockItem,
  summarizeCredentialDeploymentSigningHandoff,
  parseSignedAccountBlockItemHex,
  parseUnsignedAccountTransactionHex,
  verifyAccountTransactionSignatureSlot,
} from '../../src/index.js';

const V0_HEADER_AND_PAYLOAD =
  '1f0dd0acc617a2b459155982b8548c89ccdbb06579437251b25cf3b19c35eabf000000000000000100000000000001fc00000030000000006a8c662b1684a404fd5895491a80b3f4300761abbad8ff3a67d0d83b62b736b335bac1cdf3000568656c6c6f00000000000003e8';
const UNSIGNED_V0_TRANSFER_WITH_MEMO = `0000${V0_HEADER_AND_PAYLOAD}`;
const UNSIGNED_V1_TRANSFER_WITH_MEMO = `0300000000${V0_HEADER_AND_PAYLOAD}`;
const UNSIGNED_V1_SPONSORED_PLT =
  '03000000011f0dd0acc617a2b459155982b8548c89ccdbb06579437251b25cf3b19c35eabf0000000000000001000000000000031600000066000000006a8c380984a404fd5895491a80b3f4300761abbad8ff3a67d0d83b62b736b335bac1cdf31b000000006081a16d746f6b656e5472616e73666572a365746f6b656e63494d5466616d6f756e74c482250169726563697069656e74d99d73a201d99d71a10119039703582027845fe807bc80cdd09f9f3f72b8daa602dd1de659309a5b383ecb49fbf1be6d';
const CREDENTIAL_PUBLIC_KEY = 'e6e387ecae9f68f3547da5546bf02d1ee071a7efb95a2e53781c9b482ef3d8e1';
const CREDENTIAL_KEY = { schemeId: 'Ed25519', verifyKey: CREDENTIAL_PUBLIC_KEY };
const MESSAGE_EXPIRY_HEX = '000000006ab6a117';
const SYNTHETIC_CREDENTIAL_VALUES = [
  '01',
  '00',
  '00',
  CREDENTIAL_PUBLIC_KEY,
  '01',
  'aa'.repeat(48),
  '00000000',
  '01',
  '0000',
  '07eb09',
  '07ea09',
  '0000',
].join('');
const SYNTHETIC_PROOFS = ['bb'.repeat(96), 'cc'.repeat(64), 'dd'.repeat(740)].join('');
const CREDENTIAL_HANDOFF_HEX = `00${MESSAGE_EXPIRY_HEX}${SYNTHETIC_CREDENTIAL_VALUES}${SYNTHETIC_PROOFS}`;
const SYNTHETIC_UNSIGNED_CDI: UnsignedCredentialDeploymentInformation = {
  arData: {},
  credId: 'aa'.repeat(48),
  credentialPublicKeys: {
    keys: { 0: CREDENTIAL_KEY },
    threshold: 1,
  },
  ipIdentity: 0,
  policy: { createdAt: '202609', revealedAttributes: {}, validTo: '202709' },
  proofs: {
    challenge: 'cc'.repeat(32),
    commitments: 'dd'.repeat(64),
    credCounterLessThanMaxAccounts: 'ee'.repeat(740),
    proofIdCredPub: { 1: '12'.repeat(96), 3: '34'.repeat(96) },
    proofIpSig: '56'.repeat(96),
    proofRegId: '78'.repeat(160),
    sig: '9a'.repeat(96),
  },
  revocationThreshold: 1,
};

async function keyPair(seedByte: string) {
  const signKey = seedByte.repeat(64);
  const verifyKey = Buffer.from(await ed.getPublicKeyAsync(Uint8Array.from(Buffer.from(signKey, 'hex')))).toString(
    'hex',
  );
  return { signKey, verifyKey };
}

async function signCredentialHandoff(credDeploymentHex: string, signKey: string): Promise<string> {
  const bytes = Buffer.from(credDeploymentHex, 'hex');
  const targetLength = bytes[0] === 0 ? 9 : 33;
  const digest = createHash('sha256')
    .update(bytes.subarray(targetLength))
    .update(bytes.subarray(0, targetLength))
    .digest();
  return Buffer.from(await ed.signAsync(digest, Uint8Array.from(Buffer.from(signKey, 'hex')))).toString('hex');
}

function buildHandoff(overrides: Partial<UnsignedCredentialDeploymentInformation>) {
  return buildAccountOpeningCredentialDeploymentHandoff({
    messageExpiry: 1790353687,
    unsignedCdi: { ...SYNTHETIC_UNSIGNED_CDI, ...overrides },
  });
}

function withPayloadSize(transactionHex: string, offset: number, payloadSize: number): string {
  const bytes = Buffer.from(transactionHex, 'hex');
  bytes.writeUInt32BE(payloadSize, offset);
  return bytes.toString('hex');
}

describe('transaction hex helpers', () => {
  it.each([
    ['basic credential', 1790353687n, SYNTHETIC_UNSIGNED_CDI],
    [
      'multi-key credential with AR data and attributes',
      '1790353687',
      {
        ...SYNTHETIC_UNSIGNED_CDI,
        credentialPublicKeys: {
          keys: { 0: CREDENTIAL_KEY, 2: CREDENTIAL_KEY },
          threshold: 2,
        },
        arData: { 2: { encIdCredPubShare: 'ab'.repeat(96) } },
        policy: { ...SYNTHETIC_UNSIGNED_CDI.policy, revealedAttributes: { firstName: 'Ada', lastName: 'Lovelace' } },
      },
    ],
  ] as const)('builds a handoff matching the SDK digest for %s', (_name, messageExpiry, unsignedCdi) => {
    const handoff = buildAccountOpeningCredentialDeploymentHandoff({ messageExpiry, unsignedCdi });
    const targetContext = Buffer.from(handoff.credDeploymentHex.slice(0, 18), 'hex');
    const unsignedCredentialDeployment = Buffer.from(handoff.unsignedCredentialDeploymentHex, 'hex');
    const digest = createHash('sha256')
      .update(Buffer.concat([unsignedCredentialDeployment, targetContext]))
      .digest('hex');

    expect(handoff.credDeploymentHex).toBe(
      `00${Buffer.from(targetContext.subarray(1)).toString('hex')}${handoff.unsignedCredentialDeploymentHex}`,
    );
    expect(digest).toBe(
      Buffer.from(
        getCredentialDeploymentSignDigest({
          expiry: { expiryEpochSeconds: 1790353687n } as never,
          unsignedCdi,
        }),
      ).toString('hex'),
    );
  });

  it('normalizes credential deployment public key schemes without regard to casing', () => {
    const credentialPublicKeys = {
      keys: { 0: { ...CREDENTIAL_KEY, schemeId: 'ed25519' } },
      threshold: 1,
    };
    expect(() => buildHandoff({ credentialPublicKeys })).not.toThrow();
  });

  it('rejects unsupported account-opening credential handoff fields', () => {
    expect(() =>
      buildAccountOpeningCredentialDeploymentHandoff({ messageExpiry: -1, unsignedCdi: SYNTHETIC_UNSIGNED_CDI }),
    ).toThrow('messageExpiry must fit in u64.');
    expect(() =>
      buildHandoff({
        policy: { ...SYNTHETIC_UNSIGNED_CDI.policy, revealedAttributes: { unknown: 'x' } as never },
      }),
    ).toThrow('Unsupported revealed attribute: unknown');
    expect(() => buildHandoff({ ipIdentity: 0x1_0000_0000 })).toThrow('Value does not fit in u32');
  });

  it.each([
    ['empty keys', {}, 1, 'at least one public key'],
    ['zero threshold', { 0: CREDENTIAL_KEY }, 0, 'threshold must be between 1 and'],
    ['excessive threshold', { 0: CREDENTIAL_KEY }, 2, 'threshold must be between 1 and'],
    ['duplicate indexes', { 0: CREDENTIAL_KEY, '00': CREDENTIAL_KEY }, 1, 'Duplicate credential public key index: 0'],
    ['invalid key', { 0: { ...CREDENTIAL_KEY, verifyKey: 'aa' } }, 1, 'Invalid Ed25519 public key hex'],
    ['unsupported scheme', { 0: { ...CREDENTIAL_KEY, schemeId: 'P256' } }, 1, 'Unsupported public key scheme: P256'],
  ] as const)('rejects %s in credential handoffs', (_label, keys, threshold, message) => {
    expect(() => buildHandoff({ credentialPublicKeys: { keys, threshold } })).toThrow(message);
  });

  it('decodes standard block items with empty signature maps', () => {
    expect(parseUnsignedAccountTransactionHex(UNSIGNED_V0_TRANSFER_WITH_MEMO)).toMatchObject({
      version: 0,
      sender: '3BRQgT1WY48tQUcgRNNqqSifo2VEENkY4gCX3Qx9UQ9S7kYVLP',
    });
    expect(parseUnsignedAccountTransactionHex(UNSIGNED_V1_SPONSORED_PLT)).toMatchObject({
      version: 1,
      sender: '3BRQgT1WY48tQUcgRNNqqSifo2VEENkY4gCX3Qx9UQ9S7kYVLP',
      sponsor: '3xAJhMaYdBqVb2pyo34nFuNGqsEbtvVaHBELaPoRm9gPvqDqus',
    });
  });

  it.each([
    ['bare v0 header and payload', V0_HEADER_AND_PAYLOAD],
    ['signed v0 sender map', `00010001000040${'11'.repeat(64)}${V0_HEADER_AND_PAYLOAD}`],
    ['signed v1 sender map', `03010001000040${'11'.repeat(64)}00000000${V0_HEADER_AND_PAYLOAD}`],
    ['signed v1 sponsor map', `0300010001000040${'11'.repeat(64)}${UNSIGNED_V1_SPONSORED_PLT.slice(6)}`],
  ])('rejects %s as unsigned account input', (_label, transactionHex) => {
    expect(() => parseUnsignedAccountTransactionHex(transactionHex)).toThrow();
  });

  it.each([
    ['v0', `00010000${V0_HEADER_AND_PAYLOAD}`],
    ['v1', `0301000000${UNSIGNED_V1_SPONSORED_PLT.slice(6)}`],
  ])('rejects noncanonical empty-map %s block items', (_version, transactionHex) => {
    expect(() => parseUnsignedAccountTransactionHex(transactionHex)).toThrow('not canonical');
  });

  it.each(['', '00', '0000', UNSIGNED_V0_TRANSFER_WITH_MEMO.slice(0, -2), UNSIGNED_V1_SPONSORED_PLT.slice(0, -2)])(
    'rejects malformed or truncated standard block item %#',
    (transactionHex) => {
      expect(() => parseUnsignedAccountTransactionHex(transactionHex)).toThrow();
    },
  );

  it.each([
    ['v0', UNSIGNED_V0_TRANSFER_WITH_MEMO, 2, 48, 48],
    ['v1', UNSIGNED_V1_SPONSORED_PLT, 3, 50, 102],
  ] as const)(
    'rejects unsigned and signed %s payload-size mismatches',
    (_version, transactionHex, prefixBytes, headerOffset, actualSize) => {
      const signed = finalizeAccountTransactionHex(transactionHex, {
        sender: { 0: { 0: '11'.repeat(64) } },
        sponsor: {},
      }).blockItemHex;
      const transactionBytes = Buffer.from(transactionHex.slice(prefixBytes * 2), 'hex').length;
      const signedOffset = Buffer.from(signed, 'hex').length - transactionBytes + headerOffset;
      for (const declaredSize of [actualSize - 1, actualSize + 1, 0]) {
        expect
          .soft(() =>
            parseUnsignedAccountTransactionHex(
              withPayloadSize(transactionHex, prefixBytes + headerOffset, declaredSize),
            ),
          )
          .toThrow();
        expect
          .soft(() => parseSignedAccountBlockItemHex(withPayloadSize(signed, signedOffset, declaredSize)))
          .toThrow();
      }
    },
  );

  it('verifies one account transaction signature slot against one public key', async () => {
    const keys = await keyPair('1');
    const unsigned = parseUnsignedAccountTransactionHex(UNSIGNED_V0_TRANSFER_WITH_MEMO);
    if (unsigned.version !== 0) throw new Error('Expected a v0 fixture.');
    const signature = await AccountTransactionV0.createSignature(
      unsigned.transaction,
      buildBasicAccountSigner(keys.signKey),
    );

    await expect(
      verifyAccountTransactionSignatureSlot({
        publicKey: keys.verifyKey,
        signature: signature[0]![0]!,
        unsigned,
      }),
    ).resolves.toBe(true);
    await expect(
      verifyAccountTransactionSignatureSlot({
        publicKey: '00'.repeat(32),
        signature: signature[0]![0]!,
        unsigned,
      }),
    ).resolves.toBe(false);
  });

  it.each([
    ['v0', UNSIGNED_V0_TRANSFER_WITH_MEMO, 4, {}],
    ['v1', UNSIGNED_V1_TRANSFER_WITH_MEMO, 6, {}],
    ['v1', UNSIGNED_V1_SPONSORED_PLT, 6, { 0: { 0: '22'.repeat(64) } }],
  ] as const)(
    'finalizes %s empty-map block item without changing transaction bytes',
    (version, transactionHex, prefixLength, sponsor) => {
      const parsed = parseUnsignedAccountTransactionHex(transactionHex);
      const signatures = {
        sender: { 0: { 0: '11'.repeat(64), 2: '33'.repeat(64) }, 3: { 1: '44'.repeat(64) } },
        sponsor,
      };
      const finalized = finalizeAccountTransactionHex(transactionHex, signatures);

      expect(finalized.transactionVersion).toBe(version);
      expect(finalized.blockItemHex.endsWith(transactionHex.slice(prefixLength))).toBe(true);
      expect(finalizeParsedAccountTransaction(parsed, signatures)).toEqual(finalized);
      expect(parseSignedAccountBlockItemHex(finalized.blockItemHex)).toEqual({
        transactionHex,
        signatures: finalized.signatures,
      });
      finalized.signatures.sender['0']!['0'] = 'ff'.repeat(64);
      expect(signatures.sender[0]![0]).toBe('11'.repeat(64));
    },
  );

  it('rejects malformed and non-account block items when splitting account signatures', async () => {
    expect(() => parseSignedAccountBlockItemHex('02')).toThrow();
    const keys = await keyPair('a');
    const handoff = buildHandoff({
      credentialPublicKeys: { keys: { 0: { schemeId: 'Ed25519', verifyKey: keys.verifyKey } }, threshold: 1 },
    });
    const signature = await signCredentialHandoff(handoff.credDeploymentHex, keys.signKey);
    const credential = (await finalizeCredentialDeploymentHex(handoff.credDeploymentHex, { 0: signature }))
      .blockItemHex;
    expect(() => parseSignedAccountBlockItemHex(credential)).toThrow();
  });

  it('rejects sponsor signatures for v0 finalization', () => {
    const parsed = parseUnsignedAccountTransactionHex(UNSIGNED_V0_TRANSFER_WITH_MEMO);
    const signatures = {
      sender: { 0: { 0: '11'.repeat(64) } },
      sponsor: { 0: { 0: '22'.repeat(64) } },
    };

    expect(() => finalizeAccountTransactionHex(UNSIGNED_V0_TRANSFER_WITH_MEMO, signatures)).toThrow(
      'V0 transactions do not support sponsor signatures.',
    );
    expect(() => finalizeParsedAccountTransaction(parsed, signatures)).toThrow(
      'V0 transactions do not support sponsor signatures.',
    );
  });

  it('assembles and finalizes a target-bound threshold-1 account-opening credential deployment', async () => {
    const keys = await keyPair('a');
    const handoff = buildHandoff({
      credentialPublicKeys: { keys: { 0: { schemeId: 'Ed25519', verifyKey: keys.verifyKey } }, threshold: 1 },
    });
    const signature = await signCredentialHandoff(handoff.credDeploymentHex, keys.signKey);
    const assembled = await assembleSignedCredentialDeployment(handoff.credDeploymentHex, { 0: signature });
    const finalized = await finalizeCredentialDeploymentHex(handoff.credDeploymentHex, { 0: signature });
    expect(assembled).toMatchObject({
      credentialPublicKeys: { keys: { 0: { schemeId: 'Ed25519', verifyKey: keys.verifyKey } }, threshold: 1 },
      proofs: expect.stringContaining(signature),
    });
    expect(finalized).toMatchObject({
      blockItemKind: 'credentialDeployment',
      messageExpiry: String(Number.parseInt(MESSAGE_EXPIRY_HEX, 16)),
      signatures: { '0': signature },
    });
    expect(finalized.blockItemHex).toMatch(/^[0-9a-f]+$/);
  });

  it('assembles a sparse multi-key credential only when its threshold is met', async () => {
    const first = await keyPair('1');
    const second = await keyPair('2');
    const handoff = buildHandoff({
      credentialPublicKeys: {
        keys: {
          0: { schemeId: 'Ed25519', verifyKey: first.verifyKey },
          7: { schemeId: 'Ed25519', verifyKey: second.verifyKey },
        },
        threshold: 2,
      },
    });
    const signatures = {
      0: await signCredentialHandoff(handoff.credDeploymentHex, first.signKey),
      7: await signCredentialHandoff(handoff.credDeploymentHex, second.signKey),
    };

    await expect(assembleSignedCredentialDeployment(handoff.credDeploymentHex, signatures)).resolves.toMatchObject({
      credentialPublicKeys: { threshold: 2 },
      proofs: expect.stringContaining(signatures[0]),
    });
    await expect(finalizeCredentialDeploymentHex(handoff.credDeploymentHex, signatures)).resolves.toMatchObject({
      blockItemKind: 'credentialDeployment',
      signatures,
    });
  });

  it('matches the SDK signed-credential serializer for sparse multi-key indexes', async () => {
    const first = await keyPair('7');
    const second = await keyPair('8');
    const handoff = buildHandoff({
      credentialPublicKeys: {
        keys: {
          0: { schemeId: 'Ed25519', verifyKey: first.verifyKey },
          7: { schemeId: 'Ed25519', verifyKey: second.verifyKey },
        },
        threshold: 2,
      },
    });
    const signatures = {
      0: await signCredentialHandoff(handoff.credDeploymentHex, first.signKey),
      7: await signCredentialHandoff(handoff.credDeploymentHex, second.signKey),
    };
    const assembled = await assembleSignedCredentialDeployment(handoff.credDeploymentHex, signatures);
    const finalized = await finalizeCredentialDeploymentHex(handoff.credDeploymentHex, signatures);
    const sdkUpdatePayload = Buffer.from(
      Payload.serialize(
        Payload.updateCredentials({
          newCredentials: [{ index: 3, cdi: assembled }],
          removeCredentialIds: [],
          threshold: 1,
        }),
      ),
    );
    const sdkCredential = sdkUpdatePayload.subarray(3, sdkUpdatePayload.length - 2);

    expect(Buffer.from(finalized.blockItemHex, 'hex').subarray(10)).toEqual(sdkCredential);
  });

  it.each(['duplicate', 'out-of-order'] as const)(
    'rejects %s anonymity-revoker indexes even when the malformed handoff has a valid signature',
    async (malformation) => {
      const keys = await keyPair('9');
      const handoff = buildHandoff({
        credentialPublicKeys: { keys: { 0: { schemeId: 'Ed25519', verifyKey: keys.verifyKey } }, threshold: 1 },
        arData: {
          2: { encIdCredPubShare: 'ab'.repeat(96) },
          7: { encIdCredPubShare: 'cd'.repeat(96) },
        },
      });
      const malformed = Buffer.from(handoff.credDeploymentHex, 'hex');
      const firstArOffset = 100;
      if (malformation === 'duplicate') {
        malformed.writeUInt32BE(2, firstArOffset + 100);
      } else {
        const first = Buffer.from(malformed.subarray(firstArOffset, firstArOffset + 100));
        const second = Buffer.from(malformed.subarray(firstArOffset + 100, firstArOffset + 200));
        second.copy(malformed, firstArOffset);
        first.copy(malformed, firstArOffset + 100);
      }
      const malformedHex = malformed.toString('hex');
      const signature = await signCredentialHandoff(malformedHex, keys.signKey);

      await expect(assembleSignedCredentialDeployment(malformedHex, { 0: signature })).rejects.toThrow();
    },
  );

  it.each([
    ['malformed handoff', '00', { 0: '11'.repeat(64) }],
    ['unknown key index', undefined, { 9: '11'.repeat(64) }],
    ['noncanonical key index', undefined, { '00': '11'.repeat(64) }],
    ['malformed signature', undefined, { 0: '11' }],
  ] as const)('rejects %s during signed credential assembly', async (_name, replacement, signatures) => {
    const keys = await keyPair('3');
    const handoff = buildHandoff({
      credentialPublicKeys: { keys: { 0: { schemeId: 'Ed25519', verifyKey: keys.verifyKey } }, threshold: 1 },
    });
    await expect(
      assembleSignedCredentialDeployment(replacement ?? handoff.credDeploymentHex, signatures),
    ).rejects.toThrow();
  });

  it('rejects bad, wrong-target, and under-threshold signatures', async () => {
    const first = await keyPair('4');
    const second = await keyPair('5');
    const handoff = buildHandoff({
      credentialPublicKeys: {
        keys: {
          0: { schemeId: 'Ed25519', verifyKey: first.verifyKey },
          1: { schemeId: 'Ed25519', verifyKey: second.verifyKey },
        },
        threshold: 2,
      },
    });
    const signature = await signCredentialHandoff(handoff.credDeploymentHex, first.signKey);
    const wrongTarget = `00${'00'.repeat(8)}${handoff.unsignedCredentialDeploymentHex}`;

    await expect(assembleSignedCredentialDeployment(handoff.credDeploymentHex, { 0: signature })).rejects.toThrow(
      /threshold/i,
    );
    await expect(
      assembleSignedCredentialDeployment(handoff.credDeploymentHex, { 0: '11'.repeat(64), 1: '22'.repeat(64) }),
    ).rejects.toThrow(/signature/i);
    await expect(
      assembleSignedCredentialDeployment(wrongTarget, {
        0: signature,
        1: await signCredentialHandoff(handoff.credDeploymentHex, second.signKey),
      }),
    ).rejects.toThrow(/signature/i);
  });

  it('assembles an existing-account target but refuses to finalize it as account opening', async () => {
    const keys = await keyPair('6');
    const opening = buildHandoff({
      credentialPublicKeys: { keys: { 0: { schemeId: 'Ed25519', verifyKey: keys.verifyKey } }, threshold: 1 },
    });
    const existing = `01${'1f0dd0acc617a2b459155982b8548c89ccdbb06579437251b25cf3b19c35eabf'}${opening.unsignedCredentialDeploymentHex}`;
    const signature = await signCredentialHandoff(existing, keys.signKey);

    await expect(assembleSignedCredentialDeployment(existing, { 0: signature })).resolves.toMatchObject({
      proofs: expect.any(String),
    });
    await expect(finalizeCredentialDeploymentHex(existing, { 0: signature })).rejects.toThrow(/account-opening/i);
  });

  it('summarizes finalized credential deployment block items without decoding proof internals', async () => {
    const keys = await keyPair('b');
    const handoff = buildHandoff({
      credentialPublicKeys: { keys: { 0: { schemeId: 'Ed25519', verifyKey: keys.verifyKey } }, threshold: 1 },
    });
    const signature = await signCredentialHandoff(handoff.credDeploymentHex, keys.signKey);
    const finalized = await finalizeCredentialDeploymentHex(handoff.credDeploymentHex, { 0: signature });

    expect(summarizeCredentialDeploymentBlockItem(finalized.blockItemHex)).toEqual({
      credential: {
        anonymityRevokerCount: 0,
        createdAt: '202609',
        createdAtDate: '2026-09',
        credentialId: 'aa'.repeat(48),
        credentialPublicKeys: {
          keys: { '0': keys.verifyKey },
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
      expiry: '1790353687',
      kind: 'credentialDeployment',
      proofs: {
        byteLength: 966,
      },
    });
  });

  it('summarizes exact revealed values from credential-deployment signing handoff bytes', () => {
    const handoff = buildHandoff({
      policy: {
        ...SYNTHETIC_UNSIGNED_CDI.policy,
        revealedAttributes: { lastName: 'Lovelace', firstName: 'Ada' },
      },
    });

    const expected = {
      kind: 'credentialDeploymentSigning',
      target: { type: 'new_account', messageExpiry: '1790353687' },
      credential: expect.objectContaining({
        credentialPublicKeys: { keys: { '0': CREDENTIAL_PUBLIC_KEY }, threshold: 1 },
        revealedAttributeCount: 2,
        revealedAttributes: { firstName: 'Ada', lastName: 'Lovelace' },
      }),
      proofs: expect.objectContaining({ byteLength: expect.any(Number) }),
    };
    expect(summarizeCredentialDeploymentSigningHandoff(handoff.credDeploymentHex)).toEqual(expected);
    expect(summarizeCredentialDeploymentSigningHandoff(Buffer.from(handoff.credDeploymentHex, 'hex'))).toEqual(
      expected,
    );
  });

  it.each([
    ['valid non-ASCII UTF-8', 'Åda 文'],
    ['a leading U+FEFF character', '\uFEFFPublic fixture'],
  ])('preserves %s in exact revealed policy values', (_label, value) => {
    const handoff = buildHandoff({
      policy: {
        ...SYNTHETIC_UNSIGNED_CDI.policy,
        revealedAttributes: { firstName: value },
      },
    });

    expect(
      summarizeCredentialDeploymentSigningHandoff(handoff.credDeploymentHex).credential.revealedAttributes,
    ).toEqual({
      firstName: value,
    });
  });

  it('summarizes a valid existing-account signing target from exact handoff bytes', () => {
    const unsignedCredentialDeployment = buildHandoff({}).unsignedCredentialDeploymentHex;
    const accountAddressHex = '1f0dd0acc617a2b459155982b8548c89ccdbb06579437251b25cf3b19c35eabf';

    expect(
      summarizeCredentialDeploymentSigningHandoff(`01${accountAddressHex}${unsignedCredentialDeployment}`),
    ).toMatchObject({
      kind: 'credentialDeploymentSigning',
      target: {
        type: 'existing_account',
        accountAddress: '3BRQgT1WY48tQUcgRNNqqSifo2VEENkY4gCX3Qx9UQ9S7kYVLP',
      },
      credential: { revealedAttributes: {} },
    });
  });

  it.each([
    ['missing target', ''],
    ['truncated new-account target', '00'],
    ['truncated existing-account target', '01'],
    ['unknown target', '02'],
  ])('rejects a signing handoff with %s', (_label, handoff) => {
    expect(() => summarizeCredentialDeploymentSigningHandoff(handoff)).toThrow();
  });

  it('rejects a signing handoff without a credential payload', () => {
    expect(() => summarizeCredentialDeploymentSigningHandoff(`00${MESSAGE_EXPIRY_HEX}`)).toThrow(
      'missing credential public keys',
    );
  });

  it.each([
    ['duplicate tags', '0002000141000142'],
    ['unknown tag', '0001ff0141'],
    ['invalid UTF-8', '00010001ff'],
  ])('rejects handoffs containing %s in the serialized disclosure policy', (_label, policyHex) => {
    const validProofs = buildHandoff({}).unsignedCredentialDeploymentHex.slice(SYNTHETIC_CREDENTIAL_VALUES.length);
    const malformedValues = `${SYNTHETIC_CREDENTIAL_VALUES.slice(0, -4)}${policyHex}`;
    expect(() =>
      summarizeCredentialDeploymentSigningHandoff(`00${MESSAGE_EXPIRY_HEX}${malformedValues}${validProofs}`),
    ).toThrow();
  });

  it('rejects a structurally truncated policy', () => {
    expect(() =>
      summarizeCredentialDeploymentSigningHandoff(`00${MESSAGE_EXPIRY_HEX}${SYNTHETIC_CREDENTIAL_VALUES.slice(0, -2)}`),
    ).toThrow();
    expect(() =>
      summarizeCredentialDeploymentSigningHandoff(
        `00${MESSAGE_EXPIRY_HEX}${SYNTHETIC_CREDENTIAL_VALUES.slice(0, -4)}00010002c3`,
      ),
    ).toThrow();
  });

  it.each([
    [
      'initial',
      Buffer.from(`01${MESSAGE_EXPIRY_HEX}00`, 'hex'),
      'Initial credential deployment summaries are not supported.',
    ],
    ['unknown', `01${MESSAGE_EXPIRY_HEX}02`, 'Unsupported credential deployment type: 2'],
  ])('rejects %s credential variants before interpreting their values', (_name, input, error) => {
    expect(() => summarizeCredentialDeploymentBlockItem(input)).toThrow(error);
  });

  it('rejects malformed credential deployment block item summaries', async () => {
    expect(() => summarizeCredentialDeploymentBlockItem('00')).toThrow(
      'blockItemHex is not a credential deployment block item.',
    );

    const keys = await keyPair('c');
    const handoff = buildHandoff({
      credentialPublicKeys: { keys: { 0: { schemeId: 'Ed25519', verifyKey: keys.verifyKey } }, threshold: 1 },
    });
    const signature = await signCredentialHandoff(handoff.credDeploymentHex, keys.signKey);
    const finalized = await finalizeCredentialDeploymentHex(handoff.credDeploymentHex, { 0: signature });
    expect(() => summarizeCredentialDeploymentBlockItem(`${finalized.blockItemHex}00`)).toThrow(
      'Credential deployment block item has trailing bytes.',
    );

    const truncatedArData = `01${MESSAGE_EXPIRY_HEX}01${SYNTHETIC_CREDENTIAL_VALUES.slice(0, (1 + 34 + 1 + 48 + 4 + 1) * 2)}0001`;
    expect(() => summarizeCredentialDeploymentBlockItem(truncatedArData)).toThrow('anonymity revoker data');
  });

  it.each([
    ['empty keys', '00', /at least one public key/],
    ['zero threshold', `010000${CREDENTIAL_PUBLIC_KEY}00`, /threshold/],
    ['excessive threshold', `010000${CREDENTIAL_PUBLIC_KEY}02`, /threshold/],
    ['duplicate indexes', `020000${CREDENTIAL_PUBLIC_KEY}0000${CREDENTIAL_PUBLIC_KEY}01`, /Duplicate/],
    ['missing threshold', `010000${CREDENTIAL_PUBLIC_KEY}`, /threshold/],
  ])('rejects encoded credential %s before reading proofs', (_name, values, error) => {
    expect(() => summarizeCredentialDeploymentBlockItem(`01${MESSAGE_EXPIRY_HEX}01${values}`)).toThrow(error);
  });

  it('parses revealed attributes while finalizing credential deployment handoffs', async () => {
    const keys = await keyPair('d');
    const handoff = buildHandoff({
      credentialPublicKeys: { keys: { 0: { schemeId: 'Ed25519', verifyKey: keys.verifyKey } }, threshold: 1 },
      policy: { ...SYNTHETIC_UNSIGNED_CDI.policy, revealedAttributes: { firstName: 'Ada' } },
    }).credDeploymentHex;
    const signature = await signCredentialHandoff(handoff, keys.signKey);
    const finalized = await finalizeCredentialDeploymentHex(handoff, { 0: signature });

    expect(summarizeCredentialDeploymentBlockItem(finalized.blockItemHex).credential).toMatchObject({
      revealedAttributeCount: 1,
      revealedAttributes: { firstName: 'Ada' },
    });
  });

  it.each([
    ['invalid target', '01', { 0: '11'.repeat(64) }, 'not an account-opening credential deployment handoff'],
    ['missing signature', CREDENTIAL_HANDOFF_HEX, {}, 'threshold'],
    [
      'colliding flat indexes',
      CREDENTIAL_HANDOFF_HEX,
      Object.fromEntries([
        ['0', 'aa'.repeat(64)],
        ['00', 'bb'.repeat(64)],
      ]),
      'canonical',
    ],
    ['short signature', CREDENTIAL_HANDOFF_HEX, { 0: '11' }, 'must be a 64-byte hex string'],
    ['unknown key', CREDENTIAL_HANDOFF_HEX, { 9: '11'.repeat(64) }, 'Credential key 9 is not present'],
  ] as const)('rejects %s during credential finalization', async (_name, handoff, signatures, error) => {
    await expect(finalizeCredentialDeploymentHex(handoff, signatures)).rejects.toThrow(error);
  });

  it('rejects credential deployment handoffs without enough ownership proof bytes', async () => {
    const shortProofHandoff = `00${MESSAGE_EXPIRY_HEX}${SYNTHETIC_CREDENTIAL_VALUES}${'bb'.repeat(96)}`;

    await expect(finalizeCredentialDeploymentHex(shortProofHandoff, { 0: '11'.repeat(64) })).rejects.toThrow(
      'Credential deployment ownership proofs are too short.',
    );
  });
});
