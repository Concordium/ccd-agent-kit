import { describe, expect, it } from 'vitest';

import { ed25519PrivateKey, ed25519PublicKey, hexString } from '../../src/index.js';

describe('hexString', () => {
  it('canonicalizes valid hex to lowercase after trimming', () => {
    expect(hexString.require(' A0B1 ')).toBe('a0b1');
  });

  it('rejects non-string values', () => {
    expect(hexString.from(123)).toBeUndefined();
  });

  it('rejects empty hex by default', () => {
    expect(hexString.from('')).toBeUndefined();
    expect(hexString.from('   ')).toBeUndefined();
  });

  it('allows empty hex when requested', () => {
    expect(hexString.from('', { allowEmpty: true })).toBe('');
    expect(hexString.from('   ', { allowEmpty: true })).toBe('');
  });

  it('rejects odd-length hex', () => {
    expect(hexString.from('abc')).toBeUndefined();
  });

  it('rejects non-hex characters', () => {
    expect(hexString.from('zz')).toBeUndefined();
  });

  it('throws when requiring invalid hex', () => {
    expect(() => hexString.require('zz')).toThrow('Invalid hex string');
  });
});

describe('ed25519PublicKey', () => {
  it('canonicalizes 32-byte public keys', () => {
    expect(ed25519PublicKey.require(` ${'AB'.repeat(32)} `)).toBe('ab'.repeat(32));
  });

  it('rejects hex with the wrong byte length', () => {
    expect(ed25519PublicKey.from('ab'.repeat(31))).toBeUndefined();
    expect(ed25519PublicKey.from('ab'.repeat(33))).toBeUndefined();
  });

  it('throws when requiring malformed public keys', () => {
    expect(() => ed25519PublicKey.require('ab'.repeat(31))).toThrow('Invalid Ed25519 public key hex.');
  });
});

describe('ed25519PrivateKey', () => {
  it('canonicalizes 32-byte private signing keys', () => {
    expect(ed25519PrivateKey.require(` ${'CD'.repeat(32)} `)).toBe('cd'.repeat(32));
  });

  it('rejects hex with the wrong byte length', () => {
    expect(ed25519PrivateKey.from('cd'.repeat(31))).toBeUndefined();
    expect(ed25519PrivateKey.from('cd'.repeat(33))).toBeUndefined();
  });

  it('throws when requiring malformed private signing keys', () => {
    expect(() => ed25519PrivateKey.require('cd'.repeat(31))).toThrow('Invalid Ed25519 private key hex.');
  });
});
