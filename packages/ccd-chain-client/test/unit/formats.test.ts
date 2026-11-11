import { describe, expect, it } from 'vitest';
import { formatCcd, formatTokenAmount, microCcdToCcd } from '../../src/concordium/formats.js';

describe('microCcdToCcd', () => {
  it('converts whole microCCD to CCD without a unit', () => {
    expect(microCcdToCcd('1000000')).toBe('1.000000');
  });

});

describe('formatCcd', () => {
  it('appends the CCD suffix', () => {
    expect(formatCcd('1000000')).toBe('1.000000 CCD');
  });

});

describe('formatTokenAmount', () => {
  it('scales a raw amount down by the token decimals', () => {
    expect(formatTokenAmount('1234567890', 6)).toBe('1234.567890');
  });

});
