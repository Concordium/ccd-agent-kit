import { describe, expect, it } from 'vitest';

import {
  assertAllowedYubiKeySigningSlot,
  assertYubiKeyPinPolicy,
  assertYubiKeyTouchPolicy,
  isAllowedYubiKeySigningSlot,
  parseAllowedYubiKeySigningSlot,
} from '../../src/index.js';

describe('YubiKey signing-slot policy', () => {
  it.each([
    [' 9C ', '9c'],
    [' 82 ', '82'],
    ['95', '95'],
  ])('normalizes and accepts allowed slot %j', (input, expected) => {
    expect(isAllowedYubiKeySigningSlot(input)).toBe(true);
    expect(parseAllowedYubiKeySigningSlot(input)).toBe(expected);
  });

  it.each(['9a', '81', '96', ''])('rejects disallowed slot %j', (slot) => {
    expect(isAllowedYubiKeySigningSlot(slot)).toBe(false);
    expect(parseAllowedYubiKeySigningSlot(slot)).toBeUndefined();
  });

  it('asserts the normalized signing-slot policy', () => {
    expect(assertAllowedYubiKeySigningSlot(' 9C ')).toBe('9c');
    expect(() => assertAllowedYubiKeySigningSlot('9a')).toThrow(Error);
  });
});

describe('YubiKey generation policy', () => {
  it.each(['never', 'once', 'always'])('accepts PIN policy %s', (policy) => {
    expect(assertYubiKeyPinPolicy(policy)).toBe(policy);
  });

  it.each(['never', 'cached', 'always'])('accepts touch policy %s', (policy) => {
    expect(assertYubiKeyTouchPolicy(policy)).toBe(policy);
  });

  it('rejects unsupported policies without normalization', () => {
    expect(() => assertYubiKeyPinPolicy(' once ')).toThrow(Error);
    expect(() => assertYubiKeyTouchPolicy('sometimes')).toThrow(Error);
  });
});
