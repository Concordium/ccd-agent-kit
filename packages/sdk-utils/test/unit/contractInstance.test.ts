import { describe, expect, it } from 'vitest';
import { contractInstance } from '../../src/index.js';

describe('contractInstance', () => {
  it('requires a canonical instance while rejecting non-address values', () => {
    expect(contractInstance.require('00123.000')).toEqual({ index: '123', subindex: '0' });
    for (const value of [null, undefined, 123, ['123', '0']]) {
      expect(contractInstance.from(value)).toBeUndefined();
      expect(() => contractInstance.require(value)).toThrow();
    }
  });
  it('parses comma and dot contract instance identifiers into canonical addresses', () => {
    expect(contractInstance.from('123,0')).toEqual({ index: '123', subindex: '0' });
    expect(contractInstance.from('00123.000')).toEqual({ index: '123', subindex: '0' });
    expect(contractInstance.format({ index: '123', subindex: '0' })).toBe('123,0');
  });

  it('parses object-shaped addresses used internally', () => {
    expect(contractInstance.from({ index: '7', subindex: '1' })).toEqual({ index: '7', subindex: '1' });
  });

  it('rejects invalid contract instance identifiers', () => {
    expect(contractInstance.from('123')).toBeUndefined();
    expect(contractInstance.from('123/0')).toBeUndefined();
    expect(contractInstance.from({ index: '123', subindex: 0 })).toBeUndefined();
    expect(() => contractInstance.require('123')).toThrow('Invalid contract instance identifier');
  });
});
