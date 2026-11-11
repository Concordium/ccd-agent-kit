import { describe, expect, it } from 'vitest';

import { detectTransactionFormat } from '../../../../src/core/parser/detectTransactionFormat.js';
import { transactionFixtures } from '../../../helpers/transactionFixtures.js';

describe('detectTransactionFormat', () => {
  it('does not classify JSON transaction input', () => {
    expect(detectTransactionFormat('{"version":0}')).toBeUndefined();
  });

  it('detects hex-encoded block item input', () => {
    expect(detectTransactionFormat(transactionFixtures.v0HexString)).toBe('hex');
  });

  it('detects uppercase 0X-prefixed hex input with surrounding whitespace', () => {
    expect(detectTransactionFormat(`  0X${transactionFixtures.v0HexString}  `)).toBe('hex');
  });

  it('returns undefined for unsupported input text', () => {
    expect(detectTransactionFormat('not-a-transaction')).toBeUndefined();
  });

  it('returns undefined for blank and odd-length hex input', () => {
    expect(detectTransactionFormat('   ')).toBeUndefined();
    expect(detectTransactionFormat('0xabc')).toBeUndefined();
    expect(detectTransactionFormat('abc')).toBeUndefined();
  });
});
