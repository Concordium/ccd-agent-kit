import { Buffer } from 'node:buffer';

import { describe, expect, it } from 'vitest';

import { normalizeOperationMemo } from '../../../../src/core/parser/parsedOperations.js';

describe('native operation memo projection', () => {
  it('uses a decoded CBOR string as text when the encoded bytes are not printable text', () => {
    expect(normalizeOperationMemo(Uint8Array.from([0x62, 0xc3, 0xa9]))).toEqual({
      cbor: 'é',
      hex: '62c3a9',
      text: 'é',
    });
  });

  it('preserves valid non-ASCII UTF-8 as hex when it is not valid CBOR', () => {
    expect(normalizeOperationMemo(Uint8Array.from([0xc3, 0xa9]))).toEqual({ hex: 'c3a9' });
  });

  it('preserves an empty memo without inventing text or CBOR fields', () => {
    expect(normalizeOperationMemo(new Uint8Array())).toEqual({ hex: '' });
  });

  it('decodes CBOR from a Buffer view without reading its backing pool', () => {
    expect(normalizeOperationMemo(Buffer.from([0x01]))).toEqual({ cbor: 1, hex: '01' });
  });
});
