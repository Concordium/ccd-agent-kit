import { describe, expect, it } from 'vitest';

import {
  deriveP256PublicKey,
  InvalidP256PublicKeyError,
  validateP256PrivateScalarHex,
  validateP256PublicKey,
} from '../../src/index.js';

const GENERATOR = Buffer.from(
  '046b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296' +
    '4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5',
  'hex',
);

describe('neutral P-256 public-key validation', () => {
  it('accepts canonical uncompressed SEC1 bytes and returns an isolated copy', () => {
    const input = Buffer.from(GENERATOR);
    const validated = validateP256PublicKey(input);
    input.fill(0);

    expect(validated).toEqual(GENERATOR);
    expect(validated).not.toBe(input);
  });

  it.each([
    ['compressed point', Buffer.concat([Buffer.from([2]), GENERATOR.subarray(1, 33)])],
    ['wrong prefix', Buffer.concat([Buffer.from([5]), GENERATOR.subarray(1)])],
    ['off-curve point', Buffer.concat([Buffer.from([4]), Buffer.alloc(64)])],
    ['wrong length', GENERATOR.subarray(0, 64)],
    ['non-bytes', GENERATOR.toString('hex')],
  ])('rejects %s with one stable neutral error', (_label, value) => {
    expect(() => validateP256PublicKey(value)).toThrow(InvalidP256PublicKeyError);
    try {
      validateP256PublicKey(value);
    } catch (error) {
      expect(error).toMatchObject({ name: 'InvalidP256PublicKeyError' });
      expect(String(error)).not.toContain(Buffer.isBuffer(value) ? value.toString('hex') : String(value));
    }
  });
});

describe('P-256 private scalar boundaries', () => {
  it('accepts the largest valid scalar and derives canonical public material', () => {
    const scalar = validateP256PrivateScalarHex('ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632550');
    try {
      expect(scalar).toHaveLength(32);
      expect(validateP256PublicKey(deriveP256PublicKey(scalar))).toHaveLength(65);
    } finally {
      scalar.fill(0);
    }
  });
});
