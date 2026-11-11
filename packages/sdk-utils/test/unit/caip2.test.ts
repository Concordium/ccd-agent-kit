import { describe, expect, it } from 'vitest';

import { caip2FromGenesis, caip2Reference } from '../../src/index.js';

describe('CAIP-2 helpers', () => {
  it.each([
    [
      'lowercase',
      '9dd9ca4d19e9393877d2c44b70f89acb00000000000000000000000000000000',
      'ccd:9dd9ca4d19e9393877d2c44b70f89acb',
    ],
    [
      'uppercase',
      '9DD9CA4D19E9393877D2C44B70F89ACB00000000000000000000000000000000',
      'ccd:9DD9CA4D19E9393877D2C44B70F89ACB',
    ],
  ])('derives a CCD CAIP-2 identifier from a %s full genesis hash', (_case, genesisHash, expected) => {
    expect(caip2FromGenesis(genesisHash)).toBe(expected);
  });

  it('rejects invalid genesis hashes', () => {
    expect(() => caip2FromGenesis('9dd9')).toThrow('Invalid genesis hash');
    expect(() => caip2FromGenesis('a'.repeat(65))).toThrow('Invalid genesis hash');
    expect(() => caip2FromGenesis('z'.repeat(64))).toThrow('Invalid genesis hash');
  });

  it('extracts the CAIP-2 reference', () => {
    expect(caip2Reference('ccd:4221332d34e1694168c2a0c0b3fd0f27')).toBe('4221332d34e1694168c2a0c0b3fd0f27');
  });

  it('rejects invalid CAIP-2 identifiers', () => {
    expect(() => caip2Reference('concordium:4221332d34e1694168c2a0c0b3fd0f27')).toThrow('Invalid CAIP-2 identifier');
    expect(() => caip2Reference('4221332d34e1694168c2a0c0b3fd0f27')).toThrow('Invalid CAIP-2 identifier');
    expect(() => caip2Reference('ccd:4221332d34e1694168c2a0c0b3fd0f2')).toThrow('Invalid CAIP-2 identifier');
    expect(() => caip2Reference(`ccd:${'4'.repeat(33)}`)).toThrow('Invalid CAIP-2 identifier');
    expect(() => caip2Reference('ccd:'.padEnd(36, 'z'))).toThrow('Invalid CAIP-2 identifier');
  });
});
