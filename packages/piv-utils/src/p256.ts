import { Buffer } from 'node:buffer';
import { createECDH, ECDH } from 'node:crypto';

const P256_ORDER = BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551');

/** Error raised when bytes are not a canonical uncompressed P-256 public key. */
export class InvalidP256PublicKeyError extends Error {
  /** Constructs a stable validation error without retaining crypto-library diagnostics. */
  constructor() {
    super('A canonical uncompressed P-256 public key is required.');
    this.name = 'InvalidP256PublicKeyError';
  }
}

/** Validates and copies a canonical 65-byte uncompressed SEC1 P-256 public key. */
export function validateP256PublicKey(value: unknown): Buffer {
  try {
    if (!(value instanceof Uint8Array) || value.length !== 65 || value[0] !== 4) throw new Error();
    const copy = Buffer.from(value);
    ECDH.convertKey(copy, 'prime256v1', undefined, undefined, 'uncompressed');
    return copy;
  } catch {
    throw new InvalidP256PublicKeyError();
  }
}

/** Validate a 32-byte hexadecimal P-256 private scalar and return a copied secret buffer. */
export function validateP256PrivateScalarHex(value: unknown): Buffer {
  if (typeof value !== 'string' || !/^[0-9a-fA-F]{64}$/.test(value)) throw new Error('Invalid P-256 private scalar.');
  const scalar = Buffer.from(value, 'hex');
  const number = BigInt(`0x${value}`);
  if (number < 1n || number >= P256_ORDER) {
    scalar.fill(0);
    throw new Error('Invalid P-256 private scalar.');
  }
  return scalar;
}

/** Derive a canonical uncompressed P-256 public key from a validated private scalar. */
export function deriveP256PublicKey(privateScalar: Uint8Array): Buffer {
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(privateScalar);
  return ecdh.getPublicKey(undefined, 'uncompressed');
}
