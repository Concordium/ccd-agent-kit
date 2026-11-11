import { describe, expect, it } from 'vitest';

import { keySchemes, publicKeyScheme } from '../../src/index.js';

describe('publicKeyScheme', () => {
  it('normalizes supported public key schemes to canonical values', () => {
    expect(publicKeyScheme.from('Ed25519')).toBe(keySchemes.Ed25519);
    expect(publicKeyScheme.from('ed25519')).toBe(keySchemes.Ed25519);
    expect(publicKeyScheme.from(' ED25519 ')).toBe(keySchemes.Ed25519);
    expect(publicKeyScheme.require('ed25519')).toBe(keySchemes.Ed25519);
  });

  it('rejects unsupported public key schemes', () => {
    expect(publicKeyScheme.from('P256')).toBeUndefined();
    expect(publicKeyScheme.from(undefined)).toBeUndefined();
    expect(() => publicKeyScheme.require('P256')).toThrow('Unsupported public key scheme: P256');
  });

  it('lists canonical supported schemes', () => {
    expect(publicKeyScheme.values()).toEqual(['Ed25519']);
  });
});
