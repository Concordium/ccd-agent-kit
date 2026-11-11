import { describe, expect, it } from 'vitest';

import { PivDeviceNotFoundError, isPivSharingViolation } from '../../src/index.js';

describe('PIV public errors', () => {
  it.each([
    [undefined, 'No YubiKey found.'],
    ['12345678', 'YubiKey 12345678 not found.'],
  ] as const)('constructs a typed missing-device error for serial %j', (serial, message) => {
    const error = new PivDeviceNotFoundError(serial);

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(PivDeviceNotFoundError);
    expect(error.message).toBe(message);
  });
});

describe('PIV sharing-violation classification', () => {
  it.each([
    { code: 'SCARD_E_SHARING_VIOLATION' },
    { status: 'SCARD_E_SHARING_VIOLATION' },
    { errno: 'SCARD_E_SHARING_VIOLATION' },
    { code: 0x8010000b },
    { status: 0x8010000b | 0 },
    { errno: 0x8010000b },
    new Error('SCardConnect error: Sharing violation.(0x8010000b)'),
    new Error('native failure (0X8010000B)'),
  ])('recognizes existing native sharing representation %#', (error) => {
    expect(isPivSharingViolation(error)).toBe(true);
  });

  it.each([
    null,
    undefined,
    'SCARD_E_SHARING_VIOLATION',
    0x8010000b,
    new Error('private native failure'),
    { message: 'Sharing violation.(0x8010000b)' },
    { code: '0x8010000b' },
    { code: 0x8010000c },
    new Error('Sharing violation. 0x8010000b'),
  ])('rejects non-sharing representation %#', (error) => {
    expect(isPivSharingViolation(error)).toBe(false);
  });
});
