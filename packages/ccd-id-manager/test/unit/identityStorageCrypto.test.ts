import { createCipheriv,createDecipheriv } from 'node:crypto';
import { describe,expect,it,vi } from 'vitest';
import {
IdentityStorageCryptoError,
decryptIdentityEnvelope,
deriveIdentityStorageMaterial,
encryptIdentityEnvelope,
} from '../../src/core/identityStorageCrypto.js';
import { PRIVATE_DIAGNOSTIC,expectSanitized } from '../helpers.js';
import {
ENVELOPE_AAD,
FILE_ID_HEX,
FILE_KEY_HEX,
IDENTITY_OBJECT,
SEED_HEX,
independentEnvelope,
independentHkdf,
} from '../identityCryptoFixtures.js';

const seed = () => Buffer.from(SEED_HEX, 'hex');
const key = () => Buffer.from(FILE_KEY_HEX, 'hex');

function captureDecipherUpdates() {
  const probe = createDecipheriv('aes-256-gcm', key(), Buffer.alloc(12));
  const prototype = Object.getPrototypeOf(probe) as { update(data: Uint8Array): Buffer };
  const originalUpdate = prototype.update;
  const outputs: Buffer[] = [];
  const spy = vi.spyOn(prototype, 'update').mockImplementation(function (this: typeof probe, data) {
    const output = originalUpdate.call(this, data);
    outputs.push(output);
    return output;
  });
  return { outputs, spy };
}

function expectCryptoError(run: () => unknown, code: string) {
  let failure: unknown;
  try {
    run();
  } catch (error) {
    failure = error;
  }
  expectSanitized(failure, IdentityStorageCryptoError, code);
}

describe('identity storage derivation', () => {
  it('matches independent HKDF-SHA-256 vectors for the file ID and AES key', () => {
    const input = seed();
    const original = Buffer.from(input);
    const material = deriveIdentityStorageMaterial(input);
    expect(material.fileId).toBe(FILE_ID_HEX);
    expect(material.fileId).toMatch(/^[0-9a-f]{64}$/);
    expect(material.fileId).toBe(
      independentHkdf(input, 'ccd-id-manager/identity-file-id/v1', 32).toString('hex'),
    );
    expect(Buffer.isBuffer(material.encryptionKey)).toBe(true);
    expect(material.encryptionKey).toHaveLength(32);
    expect(material.encryptionKey.toString('hex')).toBe(FILE_KEY_HEX);
    expect(material.encryptionKey).toEqual(
      independentHkdf(input, 'ccd-id-manager/identity-file-key/v1', 32),
    );
    expect(input).toEqual(original);
  });

  it('domain-separates the file ID and key and returns caller-owned keys', () => {
    const first = deriveIdentityStorageMaterial(seed());
    const second = deriveIdentityStorageMaterial(seed());
    expect(first.encryptionKey.toString('hex')).not.toBe(first.fileId);
    first.encryptionKey.fill(0);
    expect(second.encryptionKey.toString('hex')).toBe(FILE_KEY_HEX);
  });

  it.each([undefined, '00', Array(64).fill(1), Buffer.alloc(63), Buffer.alloc(65)])(
    'rejects malformed 64-byte seed input (%s)',
    (value) => {
      expectCryptoError(() => deriveIdentityStorageMaterial(value as Uint8Array), 'INVALID_SEED');
    },
  );
});

describe('identity AES-256-GCM envelope', () => {
  it('decrypts an independently generated deterministic vector with exact header-bound AAD', () => {
    expect(decryptIdentityEnvelope(independentEnvelope(), key())).toEqual(IDENTITY_OBJECT);
  });

  it('round-trips the unmodified SDK identity object with a fresh 12-byte IV and 16-byte tag', () => {
    const before = structuredClone(IDENTITY_OBJECT);
    const first = encryptIdentityEnvelope(IDENTITY_OBJECT, key());
    const second = encryptIdentityEnvelope(IDENTITY_OBJECT, key());
    for (const envelope of [first, second]) {
      expect(envelope).toMatchObject({ version: 1, type: 'ccd-id-manager.identity', cipher: 'aes-256-gcm' });
      expect(envelope.iv).toMatch(/^[0-9a-f]{24}$/);
      expect(envelope.tag).toMatch(/^[0-9a-f]{32}$/);
      expect(envelope.cipherText).toMatch(/^(?:[0-9a-f]{2})+$/);
      expect(decryptIdentityEnvelope(envelope, key())).toEqual(IDENTITY_OBJECT);
    }
    expect(first.iv).not.toBe(second.iv);
    expect(IDENTITY_OBJECT).toEqual(before);
  });

  it('clears unauthenticated update output when GCM tag verification fails', () => {
    const envelope = independentEnvelope();
    envelope.tag = `${envelope.tag[0] === '0' ? '1' : '0'}${envelope.tag.slice(1)}`;
    const { outputs, spy } = captureDecipherUpdates();
    try {
      expectCryptoError(() => decryptIdentityEnvelope(envelope, key()), 'DECRYPTION_FAILED');
    } finally {
      spy.mockRestore();
    }
    expect(outputs).toHaveLength(1);
    const output = outputs[0]!;
    expect(output).toEqual(Buffer.alloc(output.length));
  });

  it('clears decipher update output after copying authenticated plaintext', () => {
    const { outputs, spy } = captureDecipherUpdates();
    try {
      expect(decryptIdentityEnvelope(independentEnvelope(), key())).toEqual(IDENTITY_OBJECT);
    } finally {
      spy.mockRestore();
    }
    expect(outputs).toHaveLength(1);
    const output = outputs[0]!;
    expect(output).toEqual(Buffer.alloc(output.length));
  });

  it('returns only ciphertext envelope fields, never plaintext for persistence', () => {
    const envelope = encryptIdentityEnvelope(IDENTITY_OBJECT, key());
    expect(Object.keys(envelope).sort()).toEqual(['cipher', 'cipherText', 'iv', 'tag', 'type', 'version']);
    expect(JSON.stringify(envelope)).not.toContain('Ada');
    expect(JSON.stringify(envelope)).not.toContain('preIdentityObject');
  });

  it.each([null, []])('rejects a non-object plaintext before encryption (%s)', (identity) => {
    expectCryptoError(
      () => encryptIdentityEnvelope(identity as never, key()),
      'INVALID_PLAINTEXT',
    );
  });

  it('sanitizes unexpected serialization failures', () => {
    const identity = {
      ...IDENTITY_OBJECT,
      toJSON() {
        throw new Error(PRIVATE_DIAGNOSTIC);
      },
    };
    expectCryptoError(() => encryptIdentityEnvelope(identity, key()), 'ENCRYPTION_FAILED');
  });

  it('rejects a wrong key without exposing plaintext or mutating the envelope', () => {
    const envelope = independentEnvelope();
    const before = structuredClone(envelope);
    expectCryptoError(() => decryptIdentityEnvelope(envelope, Buffer.alloc(32, 9)), 'DECRYPTION_FAILED');
    expect(envelope).toEqual(before);
  });

  it.each(['tag', 'cipherText'] as const)('rejects tampered %s', (field) => {
    const envelope = independentEnvelope();
    envelope[field] = `${envelope[field][0] === '0' ? '1' : '0'}${envelope[field].slice(1)}`;
    expectCryptoError(() => decryptIdentityEnvelope(envelope, key()), 'DECRYPTION_FAILED');
  });

  it.each([
    ['version', 2],
    ['type', 'ccd-id-manager.other'],
    ['cipher', 'aes-128-gcm'],
  ])('rejects unsupported header %s before decryption', (field, value) => {
    const envelope = { ...independentEnvelope(), [field]: value };
    expectCryptoError(() => decryptIdentityEnvelope(envelope, key()), 'UNSUPPORTED_ENVELOPE');
  });

  it.each([
    ['null envelope', null],
    ['array envelope', []],
    ['short IV', { ...independentEnvelope(), iv: '00'.repeat(11) }],
    ['long tag', { ...independentEnvelope(), tag: '00'.repeat(17) }],
    ['odd ciphertext', { ...independentEnvelope(), cipherText: 'abc' }],
    ['uppercase hex', { ...independentEnvelope(), iv: 'AA'.repeat(12) }],
    ['non-hex', { ...independentEnvelope(), tag: 'zz'.repeat(16) }],
  ])('rejects malformed input: %s', (_label, envelope) => {
    expectCryptoError(() => decryptIdentityEnvelope(envelope, key()), 'INVALID_ENVELOPE');
  });

  it.each([Buffer.alloc(0), Buffer.alloc(31), Buffer.alloc(33), '00', undefined])(
    'rejects malformed AES keys before encryption and decryption (%s)',
    (invalidKey) => {
      expectCryptoError(
        () => encryptIdentityEnvelope(IDENTITY_OBJECT, invalidKey as Uint8Array),
        'INVALID_KEY',
      );
      expectCryptoError(
        () => decryptIdentityEnvelope(independentEnvelope(), invalidKey as Uint8Array),
        'INVALID_KEY',
      );
    },
  );

  it('authenticates the exact AAD and rejects valid AEAD carrying a malformed identity object', () => {
    const malformed = independentEnvelope(JSON.stringify({ privateDiagnostic: PRIVATE_DIAGNOSTIC }));
    expectCryptoError(() => decryptIdentityEnvelope(malformed, key()), 'INVALID_PLAINTEXT');

    const iv = Buffer.from(malformed.iv, 'hex');
    const cipher = createCipheriv('aes-256-gcm', key(), iv);
    cipher.setAAD(Buffer.from(`${ENVELOPE_AAD}\n`));
    const cipherText = Buffer.concat([cipher.update(JSON.stringify(IDENTITY_OBJECT)), cipher.final()]);
    const wrongAad = {
      ...malformed,
      tag: cipher.getAuthTag().toString('hex'),
      cipherText: cipherText.toString('hex'),
    };
    expectCryptoError(() => decryptIdentityEnvelope(wrongAad, key()), 'DECRYPTION_FAILED');
  });
});
