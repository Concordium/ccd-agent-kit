import { createCipheriv, createECDH, hkdfSync } from 'node:crypto';
import type { IdentityObjectV1, Network, Versioned } from '@concordium/web-sdk';
import { hashToCurve, p256 } from '@noble/curves/p256';

export const ROOT_CONTEXT = {
  network: 'Testnet',
  identityProviderIndex: 3,
  identityIndex: 7,
} as const;

export const ROOT_MESSAGE =
  'ccd-id-manager/identity-seed/v1|00000001|00000003|00000007';
export const ROOT_DST = 'ccd-id-manager/identity-seed/v1/P256_XMD:SHA-256_SSWU_RO_';
export const HKDF_SALT = 'ccd-id-manager/hkdf/v1';
export const PEER_HEX =
  '04ce33181009b9cad4afb479dca353c5951176eefa07ad0970f6ce58252eeac53c28fb353771d68c580a767612692de65e57fb2982f1101a541b023bb8efbef69f';
export const ROOT_PUBLIC_KEY_HEX =
  '046b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c2964fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5';
export const SHARED_SECRET_HEX = 'ce33181009b9cad4afb479dca353c5951176eefa07ad0970f6ce58252eeac53c';
export const SEED_HEX =
  '93b9cce9bb4018f9b89f8ea42fc2ccdf61a7422f7883d6b7dac7ae436e2452740c953a4004c558f34fd37d1f4199807c924236fd55e59297e437f4569828921e';
export const FILE_ID_HEX = 'd12800f713e7b012fd56ac4e7d9873b9b95793b34c92368849fe5cf5136d2662';
export const FILE_KEY_HEX = '568fb300aa787f434cec17d8a48d8a71926716e1f350f13e67b35baa2cada627';
export const ENVELOPE_AAD = 'ccd-id-manager.identity|1|aes-256-gcm';

export const MAINNET_VECTOR = {
  message: 'ccd-id-manager/identity-seed/v1|00000397|00000003|00000007',
  peer: '04d26f84584ff5d4882ca805423acc4039e79387956a6ae2f07d97e81bc48cfa124ac19d75c1d30a718d151bee0d5870c9aeca3d334e3fbc543896b1edde5842e7',
  sharedSecret: 'd26f84584ff5d4882ca805423acc4039e79387956a6ae2f07d97e81bc48cfa12',
  seed: '6e7f84b564281dc5938e55dbb0bc2e39ad48c6db991318b7d05960bedd77b40a1455c380f2b4a3575aef238b393f2d2ad322212cbc70250abfd8a20bfd8fe121',
  fileId: '1aff6e4a107303a8d4fd73e3d15a77c74f54e7d0a7e5c8f07341ae38514cea4c',
  fileKey: '825c3a75cef7013e79e28ffecc40b5c0d4011ddac2c6106dc9da7f12a33ee631',
} as const;

/** Independently generated Node ECDH/HKDF vector with a nontrivial scalar and leading-zero x coordinate. */
export const LEADING_ZERO_VECTOR = {
  scalar: 186,
  publicKey: '0445dfa86e37555a11b098f18b51d60b637308b8353f6c8a0af691c10e71b3786b8f5d6a022af67f65c258084f1554933578094dc3cdb9f57fd3a8e6b9b4343891',
  sharedSecret: '00740c0ca2d7862c3dc448efc8236c2af51762a4f2d7da6f3097246138df4c6a',
  seed: 'cfba67619259650c0fe68181cb4a97f33824366219073a3510d275d6f44c4772b8f4401de1fe0e6e2c6bbc1a87f2526d958d65163236f2ccdb0f819aa7931295',
  fileId: '2bf8f82d8eaf2598ceb2438e591b317062dd5ba616dc0cf629d30a87ef595cdd',
  fileKey: 'fbbd5c57ecb23ced503de8030ae63c171195abf252251114a1682f4162a85da0',
} as const;

export function independentPeer(context: {
  network: Network;
  identityProviderIndex: number;
  identityIndex: number;
} = ROOT_CONTEXT): Buffer {
  const coinType = context.network === 'Mainnet' ? 919 : 1;
  const message = `ccd-id-manager/identity-seed/v1|${coinType.toString(16).padStart(8, '0')}|${context.identityProviderIndex.toString(16).padStart(8, '0')}|${context.identityIndex.toString(16).padStart(8, '0')}`;
  return Buffer.from(
    p256.ProjectivePoint.fromAffine(
      hashToCurve(Buffer.from(message), { DST: Buffer.from(ROOT_DST) }).toAffine(),
    ).toRawBytes(false),
  );
}

export function independentHkdf(ikm: Uint8Array, info: string, length: number): Buffer {
  return Buffer.from(hkdfSync('sha256', ikm, Buffer.from(HKDF_SALT), Buffer.from(info), length));
}

/** Public, deterministic software stand-in. The scalar is test data, never production key material. */
export function fixedScalarDevice(value = 1) {
  const ecdh = createECDH('prime256v1');
  const scalar = Buffer.alloc(32);
  scalar.writeUInt32BE(value, 28);
  ecdh.setPrivateKey(scalar);
  scalar.fill(0);
  return {
    publicKey: ecdh.getPublicKey(undefined, 'uncompressed'),
    secret: (peer: Uint8Array) => ecdh.computeSecret(peer),
  };
}

export const IDENTITY_OBJECT = {
  v: 0,
  value: {
    preIdentityObject: {
      idCredPub: 'ab'.repeat(48),
      choiceArData: { arIdentities: [1, 2], threshold: 2 },
      ipArData: {
        1: { encPrfKeyShare: 'ab', proofComEncEq: 'bc' },
        2: { encPrfKeyShare: 'cd', proofComEncEq: 'de' },
      },
      idCredSecCommitment: '88',
      prfKeyCommitmentWithIP: '99',
      prfKeySharingCoeffCommitments: ['ef'],
      proofsOfKnowledge: 'aa',
    },
    attributeList: {
      validTo: '203012',
      createdAt: '202610',
      maxAccounts: 3,
      chosenAttributes: { firstName: 'Ada', lastName: 'Lovelace' },
    },
    signature: 'cc',
  },
} as unknown as Versioned<IdentityObjectV1>;

export function independentEnvelope(plainText = JSON.stringify(IDENTITY_OBJECT)) {
  const iv = Buffer.from('000102030405060708090a0b', 'hex');
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(FILE_KEY_HEX, 'hex'), iv);
  cipher.setAAD(Buffer.from(ENVELOPE_AAD));
  const cipherText = Buffer.concat([cipher.update(Buffer.from(plainText)), cipher.final()]);
  return {
    version: 1 as const,
    type: 'ccd-id-manager.identity' as const,
    cipher: 'aes-256-gcm' as const,
    iv: iv.toString('hex'),
    tag: cipher.getAuthTag().toString('hex'),
    cipherText: cipherText.toString('hex'),
  };
}
