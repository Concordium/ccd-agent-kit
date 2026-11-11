import { describe,expect,it } from 'vitest';

import { getDiscoveryStopReason,getNextIdentityIndex } from '../../src/core/discoveryPolicy.js';

describe('shared discovery stopping policy', () => {
  it('stops at the SDK upper bound without iterating to it', () => {
    expect(getDiscoveryStopReason({
      index: 0x7fffffff, upperBound: 0x7fffffff, highWater: -1, misses: 0, gapLimit: 3,
    })).toBe('limit');
  });

  it('reports an explicit inclusive range even when it equals the SDK bound', () => {
    expect(getDiscoveryStopReason({
      index: 255, upperBound: 255, endIndex: 255, highWater: -1, misses: 3, gapLimit: 3,
    })).toBe('range');
  });

  it.each([
    ['before known high-water', { index: 2, upperBound: 100, highWater: 5, misses: 3, gapLimit: 3 }, undefined],
    ['at known high-water', { index: 5, upperBound: 100, highWater: 5, misses: 3, gapLimit: 3 }, 'gap'],
    ['after a reset', { index: 6, upperBound: 100, highWater: 5, misses: 1, gapLimit: 3 }, undefined],
  ] as const)('%s', (_label, input, expected) => {
    expect(getDiscoveryStopReason(input)).toBe(expected);
  });
});

describe('identity allocation policy', () => {
  it.each([
    [[], 0],
    [[5, 1, 3], 6],
  ] as const)('allocates after the highest occupied index in %j', (occupied, expected) => {
    expect(getNextIdentityIndex(occupied)).toBe(expected);
  });

  it('rejects an occupied maximum identity index', () => {
    expect(() => getNextIdentityIndex([0x7fffffff])).toThrowError(expect.objectContaining({ code: 'INDEX_UNAVAILABLE' }));
  });
});
