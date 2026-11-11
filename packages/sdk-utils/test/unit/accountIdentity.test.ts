import { AccountAddress } from '@concordium/web-sdk';
import { describe, expect, it } from 'vitest';

import { sameAccount } from '../../src/index.js';

describe('sameAccount', () => {
  it('matches aliases symmetrically and distinguishes valid accounts', () => {
    const address = '3BRQgT1WY48tQUcgRNNqqSifo2VEENkY4gCX3Qx9UQ9S7kYVLP';
    const other = '3xAJhMaYdBqVb2pyo34nFuNGqsEbtvVaHBELaPoRm9gPvqDqus';
    const alias = AccountAddress.getAlias(AccountAddress.fromBase58(address), 1).toString();

    expect(sameAccount(address, alias)).toBe(true);
    expect(sameAccount(alias, address)).toBe(true);
    expect(sameAccount(address, other)).toBe(false);
    expect(sameAccount(address, 'not-an-address')).toBe(false);
  });

  it('accepts exact string equality without parsing', () => {
    expect(sameAccount('not-a-real-address', 'not-a-real-address')).toBe(true);
  });

  it('returns false for invalid different values without throwing', () => {
    expect(sameAccount('not-a-real-address', 'another-invalid-address')).toBe(false);
  });
});
