import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { hexString } from '@ccd-agent-kit/sdk-utils';
import type { IdentityObjectV1, Versioned } from '@concordium/web-sdk';
import { identityObjectSchema } from './workflowValidation.js';

const HKDF_SALT = Buffer.from('ccd-id-manager/hkdf/v1');
const FILE_ID_INFO = Buffer.from('ccd-id-manager/identity-file-id/v1');
const FILE_KEY_INFO = Buffer.from('ccd-id-manager/identity-file-key/v1');
const ENVELOPE_TYPE = 'ccd-id-manager.identity';
const ENVELOPE_CIPHER = 'aes-256-gcm';
const ENVELOPE_AAD = Buffer.from('ccd-id-manager.identity|1|aes-256-gcm');

/** Stable, sanitized identity storage cryptography failure classifications. */
export type IdentityStorageCryptoErrorCode =
  | 'INVALID_SEED'
  | 'INVALID_KEY'
  | 'INVALID_ENVELOPE'
  | 'UNSUPPORTED_ENVELOPE'
  | 'INVALID_PLAINTEXT'
  | 'ENCRYPTION_FAILED'
  | 'DECRYPTION_FAILED';

const messages: Record<IdentityStorageCryptoErrorCode, string> = {
  INVALID_SEED: 'Identity storage derivation requires a 64-byte seed.',
  INVALID_KEY: 'Identity storage encryption requires a 32-byte key.',
  INVALID_ENVELOPE: 'The encrypted identity envelope is malformed.',
  UNSUPPORTED_ENVELOPE: 'The encrypted identity envelope is not supported.',
  INVALID_PLAINTEXT: 'The decrypted identity object is malformed.',
  ENCRYPTION_FAILED: 'Identity encryption failed.',
  DECRYPTION_FAILED: 'Identity decryption failed.',
};

/** Sanitized local identity-storage cryptography error with no retained cause. */
export class IdentityStorageCryptoError extends Error {
  /** Construct an error using only its stable classification. */
  constructor(public readonly code: IdentityStorageCryptoErrorCode) {
    super(messages[code]);
    this.name = 'IdentityStorageCryptoError';
  }
}

/** Version-1 AES-256-GCM identity-file envelope. */
export interface IdentityEnvelope {
  /** Envelope format version. */
  version: 1;
  /** Identity-manager envelope discriminator. */
  type: 'ccd-id-manager.identity';
  /** Authenticated encryption algorithm. */
  cipher: 'aes-256-gcm';
  /** Twelve-byte initialization vector as canonical lower-case hex. */
  iv: string;
  /** Sixteen-byte authentication tag as canonical lower-case hex. */
  tag: string;
  /** Nonempty encrypted JSON bytes as canonical lower-case hex. */
  cipherText: string;
}

/** Domain-separated values derived from one identity SDK seed. */
export interface IdentityStorageMaterial {
  /** Opaque 32-byte file identifier encoded as canonical lower-case hex. */
  fileId: string;
  /** Caller-owned 32-byte AES-256 key which must be cleared after use. */
  encryptionKey: Buffer;
}

function requireBytes(value: unknown, length: number, code: 'INVALID_SEED' | 'INVALID_KEY'): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== length) {
    throw new IdentityStorageCryptoError(code);
  }
  return value;
}

/** Derive the opaque file identifier and caller-owned AES key without modifying the seed. */
export function deriveIdentityStorageMaterial(seed: Uint8Array): IdentityStorageMaterial {
  const source = requireBytes(seed, 64, 'INVALID_SEED');
  const fileId = Buffer.from(hkdfSync('sha256', source, HKDF_SALT, FILE_ID_INFO, 32));
  try {
    return {
      fileId: fileId.toString('hex'),
      encryptionKey: Buffer.from(hkdfSync('sha256', source, HKDF_SALT, FILE_KEY_INFO, 32)),
    };
  } finally {
    fileId.fill(0);
  }
}

function requireKey(value: unknown): Uint8Array {
  return requireBytes(value, 32, 'INVALID_KEY');
}

function isCanonicalHex(value: unknown, bytes?: number): value is string {
  if (typeof value !== 'string' || hexString.from(value) !== value) return false;
  return bytes === undefined ? value.length > 0 : value.length === bytes * 2;
}

function parseEnvelope(value: unknown): IdentityEnvelope {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new IdentityStorageCryptoError('INVALID_ENVELOPE');
  }
  const envelope = value as Partial<IdentityEnvelope>;
  if (envelope.version !== 1 || envelope.type !== ENVELOPE_TYPE || envelope.cipher !== ENVELOPE_CIPHER) {
    throw new IdentityStorageCryptoError('UNSUPPORTED_ENVELOPE');
  }
  if (
    !isCanonicalHex(envelope.iv, 12)
    || !isCanonicalHex(envelope.tag, 16)
    || !isCanonicalHex(envelope.cipherText)
  ) {
    throw new IdentityStorageCryptoError('INVALID_ENVELOPE');
  }
  return envelope as IdentityEnvelope;
}

/** Encrypt an unmodified SDK identity object in the version-1 local file envelope. */
export function encryptIdentityEnvelope(
  identity: Versioned<IdentityObjectV1>,
  encryptionKey: Uint8Array,
): IdentityEnvelope {
  const key = requireKey(encryptionKey);
  if (!identityObjectSchema.safeParse(identity).success) throw new IdentityStorageCryptoError('INVALID_PLAINTEXT');
  let plainText: Buffer | undefined;
  try {
    plainText = Buffer.from(JSON.stringify(identity));
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(ENVELOPE_AAD);
    const cipherText = Buffer.concat([cipher.update(plainText), cipher.final()]);
    return {
      version: 1,
      type: ENVELOPE_TYPE,
      cipher: ENVELOPE_CIPHER,
      iv: iv.toString('hex'),
      tag: cipher.getAuthTag().toString('hex'),
      cipherText: cipherText.toString('hex'),
    };
  } catch {
    throw new IdentityStorageCryptoError('ENCRYPTION_FAILED');
  } finally {
    plainText?.fill(0);
  }
}

/** Decrypt and minimally validate the unmodified SDK identity object in a version-1 envelope. */
export function decryptIdentityEnvelope(
  value: unknown,
  encryptionKey: Uint8Array,
): Versioned<IdentityObjectV1> {
  const key = requireKey(encryptionKey);
  const envelope = parseEnvelope(value);
  let plainText: Buffer | undefined;
  const chunks: Buffer[] = [];
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'hex'));
    decipher.setAAD(ENVELOPE_AAD);
    decipher.setAuthTag(Buffer.from(envelope.tag, 'hex'));
    chunks.push(decipher.update(Buffer.from(envelope.cipherText, 'hex')));
    chunks.push(decipher.final());
    plainText = Buffer.concat(chunks);
  } catch {
    throw new IdentityStorageCryptoError('DECRYPTION_FAILED');
  } finally {
    for (const chunk of chunks) chunk.fill(0);
  }

  try {
    const parsed = identityObjectSchema.safeParse(JSON.parse(plainText.toString('utf8')) as unknown);
    if (!parsed.success) throw new Error();
    return parsed.data;
  } catch {
    throw new IdentityStorageCryptoError('INVALID_PLAINTEXT');
  } finally {
    plainText.fill(0);
  }
}
