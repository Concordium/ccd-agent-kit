import type { AccountTransactionSignature } from '@concordium/web-sdk';
import { describe, expect, it } from 'vitest';

import {
  cloneSignatureMap,
  countSignatureEntries,
  isEmptySignatureMap,
  normalizeRoleSeparatedSignatureMaps,
} from '../../src/index.js';

describe('signature map helpers', () => {
  it('detects empty signature maps', () => {
    expect(isEmptySignatureMap({})).toBe(true);
    expect(isEmptySignatureMap({ '0': {} })).toBe(true);
    expect(isEmptySignatureMap({ '0': { '0': 'abcd' } })).toBe(false);
  });

  it('counts signature entries', () => {
    expect(countSignatureEntries({})).toBe(0);
    expect(countSignatureEntries({ '0': { '0': 'aaaa', '1': 'bbbb' }, '2': { '0': 'cccc' } })).toBe(3);
  });

  it('clones signature maps without sharing nested objects', () => {
    const input: AccountTransactionSignature = { '0': { '0': 'aaaa' } };
    const cloned = cloneSignatureMap(input);
    cloned['0']!['0'] = 'bbbb';

    expect(input).toEqual({ '0': { '0': 'aaaa' } });
  });

  it('normalizes missing role-separated signature maps', () => {
    expect(normalizeRoleSeparatedSignatureMaps({ sender: { '0': { '0': 'aaaa' } } })).toEqual({
      sender: { '0': { '0': 'aaaa' } },
      sponsor: {},
    });
  });
});
