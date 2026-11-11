import { describe, expect, it } from 'vitest';

import { isEvenHex, normalizeMessageInput, parseHexBytes } from '../../src/index.js';

describe('isEvenHex', () => {
  it('accepts non-empty even-length hex', () => {
    expect(isEvenHex('00')).toBe(true);
    expect(isEvenHex('A0ff')).toBe(true);
  });

  it('rejects empty, odd-length, and non-hex strings', () => {
    expect(isEvenHex('')).toBe(false);
    expect(isEvenHex('abc')).toBe(false);
    expect(isEvenHex('zz')).toBe(false);
  });
});

describe('normalizeMessageInput', () => {
  it('normalizes UTF-8 text input', () => {
    const result = normalizeMessageInput({ messageText: 'hello' });

    expect(result).toEqual({
      inputFormat: 'text',
      messageBytes: Uint8Array.from([104, 101, 108, 108, 111]),
      messageHex: '68656c6c6f',
      messageText: 'hello',
    });
  });

  it.each(['A0ff', ' \tA0ff\n'])('normalizes hex %j to the validated bytes', (messageHex) => {
    const result = normalizeMessageInput({ messageHex });
    expect(parseHexBytes(messageHex)).toEqual(Buffer.from([160, 255]));

    expect(result).toEqual({
      inputFormat: 'hex',
      messageBytes: Uint8Array.from([160, 255]),
      messageHex: 'a0ff',
    });
  });

  it('requires exactly one message input', () => {
    expect(() => normalizeMessageInput({})).toThrow('Provide exactly one of messageText or messageHex.');
    expect(() => normalizeMessageInput({ messageText: 'hello', messageHex: '68656c6c6f' })).toThrow(
      'Provide exactly one of messageText or messageHex.',
    );
  });

  it.each(['', '  ', 'abc', 'zz', 'a0 ff'])('rejects invalid hex %j', (messageHex) => {
    expect(() => parseHexBytes(messageHex)).toThrow('Expected even-length hex string.');
    expect(() => normalizeMessageInput({ messageHex })).toThrow(
      'Message hex must be a valid even-length hex string.',
    );
  });
});
