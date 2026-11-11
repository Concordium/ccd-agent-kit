import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';

import {
  apdu, ApduStatusError, decodeDeviceInfo, isPinRetryStatus, isStatusError,
  managementKeyAuthenticationBlockSize, parseAllTlvs, parseFirstTlv, parseAllTlvsStrict, parseFirstTlvStrict, parseSlotMetadata, pinPolicyByte, tlv, touchPolicyByte,
} from '../../src/index.js';

describe('neutral PIV codecs', () => {
  it('preserves the original short-APDU encoder without adding input validation', () => {
    expect(apdu(0, 0xf8, 0, 0).toString('hex')).toBe('00f8000000');
    expect(apdu(0, 0x20, 0, 0x80, Buffer.from('1234', 'hex')).toString('hex')).toBe('0020008002123400');
    expect(apdu(0, 0, 0, 0, Buffer.alloc(255))).toHaveLength(261);
    expect(apdu(0, 0, 0, 0, Buffer.alloc(256))[4]).toBe(0);
  });

  it.each([0, 127, 128, 255, 256, 65535])('round-trips single-byte tags and %i-byte values', (length) => {
    const value = Buffer.alloc(length, 0xaa);
    const encoded = tlv(0x04, value);
    expect(parseFirstTlv(encoded)).toEqual({ tag: 0x04, value });
    expect(parseAllTlvs(encoded)).toEqual([{ tag: 0x04, value }]);
    expect(parseFirstTlvStrict(encoded)).toEqual({ tag: 0x04, value });
    expect(parseAllTlvsStrict(encoded)).toEqual([{ tag: 0x04, value }]);
  });

  it('keeps the original permissive encoder and observation parser semantics', () => {
    expect(tlv(0x7f49, Buffer.alloc(0)).toString('hex')).toBe('4900');
    expect(tlv(4, Buffer.alloc(65536)).subarray(0, 4).toString('hex')).toBe('04820000');
    expect(parseFirstTlv(Buffer.from('01', 'hex'))).toBeUndefined();
    expect(parseFirstTlv(Buffer.from('0102ff', 'hex'))).toEqual({ tag: 1, value: Buffer.from('ff', 'hex') });
    expect(parseAllTlvs(Buffer.from('0101000202ff', 'hex'))).toEqual([{ tag: 1, value: Buffer.from([0]) }]);
    expect(parseFirstTlv(Buffer.from('7f490181', 'hex'))).toEqual({ tag: 0x7f49, value: Buffer.from('81', 'hex') });
    expect(parseAllTlvs(Buffer.from('7f490181', 'hex'))).toEqual([{ tag: 0x7f49, value: Buffer.from('81', 'hex') }]);
    expect(parseFirstTlvStrict(Buffer.from('7f490181', 'hex'))).toEqual({ tag: 0x7f49, value: Buffer.from('81', 'hex') });
    expect(parseAllTlvsStrict(Buffer.from('7f490181', 'hex'))).toEqual([{ tag: 0x7f49, value: Buffer.from('81', 'hex') }]);
  });

  it('allows rest after the first TLV but validates every chunk when parsing all', () => {
    const data = Buffer.from('0101e002020203', 'hex');
    expect(parseFirstTlv(data)).toEqual({ tag: 1, value: Buffer.from([0xe0]) });
    expect(parseAllTlvs(data)).toEqual([
      { tag: 1, value: Buffer.from([0xe0]) }, { tag: 2, value: Buffer.from([2, 3]) },
    ]);
    expect(parseFirstTlv(Buffer.alloc(0))).toBeUndefined();
    expect(parseAllTlvs(Buffer.alloc(0))).toEqual([]);
  });

  it.each(['01', '7f', '7f49', '0181', '018201', '01800000', '0183000000', '0102ff'])('rejects malformed TLV %s', (hex) => {
    const malformed = Buffer.from(hex, 'hex');
    expect(() => parseFirstTlvStrict(malformed)).toThrow();
    expect(() => parseAllTlvsStrict(malformed)).toThrow();
    expect(() => parseAllTlvsStrict(Buffer.concat([Buffer.from('010100', 'hex'), malformed]))).toThrow();
  });

  it('exposes status identity without matching arbitrary error messages', () => {
    const error = new ApduStatusError(0x63c2);
    expect(error).toBeInstanceOf(Error);
    expect(error.status).toBe(0x63c2);
    expect(isStatusError(error, 0x63c2)).toBe(true);
    expect(isStatusError(error, 0x6982)).toBe(false);
    expect(isPinRetryStatus(error)).toBe(true);
    expect(isPinRetryStatus(new ApduStatusError(0x6982))).toBe(false);
    expect(isStatusError(new Error('0x63c2'), 0x63c2)).toBe(false);
    expect(isPinRetryStatus(undefined)).toBe(false);
  });

  it('maps management block sizes and neutral policies', () => {
    expect(managementKeyAuthenticationBlockSize(0x03)).toBe(8);
    for (const algorithm of [0x08, 0x0a, 0x0c]) expect(managementKeyAuthenticationBlockSize(algorithm)).toBe(16);
    expect(['never', 'once', 'always'].map((policy) => pinPolicyByte(policy as 'never' | 'once' | 'always'))).toEqual([1, 2, 3]);
    expect(['never', 'always', 'cached'].map((policy) => touchPolicyByte(policy as 'never' | 'always' | 'cached'))).toEqual([1, 2, 3]);
    expect(pinPolicyByte('invalid' as 'always')).toBe(3);
    expect(touchPolicyByte('invalid' as 'always')).toBe(3);
  });

  it('decodes metadata without scheme interpretation and rejects malformed fields', () => {
    expect(parseSlotMetadata(Buffer.from('0101e002020103030102', 'hex'), '9c')).toEqual({
      slot: '9c', status: 'occupied', algorithm: 0xe0, pinPolicy: 'never', touchPolicy: 'cached', origin: 'imported',
    });
    expect(parseSlotMetadata(Buffer.from('01019902020302030103', 'hex'), '9d')).toMatchObject({
      algorithm: 0x99, pinPolicy: 'always', touchPolicy: 'always', origin: 'unknown',
    });
    expect(parseSlotMetadata(Buffer.from('0202ffff', 'hex'), '9d')).toEqual({ slot: '9d', status: 'empty' });
    expect(parseSlotMetadata(Buffer.alloc(0), '9d')).toEqual({ slot: '9d', status: 'empty' });
    for (const hex of ['0100', '020101', '0300']) expect(() => parseSlotMetadata(Buffer.from(hex, 'hex'), '9d')).toThrow();
  });
});

describe('management device facts (migrated from signer)', () => {
  it('decodes firmware, model, FIPS and unknown form factors', () => {
    expect(decodeDeviceInfo(Buffer.from('0401010503050800', 'hex'))).toEqual({
      firmwareVersion: '5.8.0', formFactor: 'USB-A keychain', model: 'YubiKey 5 NFC',
    });
    for (const [factor, model] of [[2, 'YubiKey 5 Nano'], [3, 'YubiKey 5C'], [4, 'YubiKey 5C Nano'], [5, 'YubiKey 5Ci']] as const) {
      expect(decodeDeviceInfo(Buffer.from([4, 1, factor, 5, 3, 5, 8, 0])).model).toBe(model);
    }
    expect(decodeDeviceInfo(Buffer.from('0401860503040400', 'hex'))).toMatchObject({
      formFactor: 'USB-A biometric', model: 'YubiKey Bio USB-A FIPS',
    });
    expect(decodeDeviceInfo(Buffer.from('0401070503040400', 'hex')).model).toBe('YubiKey Bio USB-C');
    expect(decodeDeviceInfo(Buffer.from('0401090503040400', 'hex'))).toMatchObject({ firmwareVersion: '4.4.0', formFactor: '0x9' });
    expect(decodeDeviceInfo(Buffer.alloc(0)).model).toBeUndefined();
  });

  it('honors metadata boundaries and an optional payload length', () => {
    expect(decodeDeviceInfo(Buffer.from('080401030503050800', 'hex'))).toEqual({
      firmwareVersion: '5.8.0', formFactor: 'USB-C keychain', model: 'YubiKey 5C',
    });
    expect(decodeDeviceInfo(Buffer.from('0a080401030503050800', 'hex'))).toEqual({});
    expect(decodeDeviceInfo(Buffer.from('04010305020404', 'hex'))).toEqual({ formFactor: 'USB-C keychain' });
  });

  it('only infers standard models from YubiKey 5 firmware', () => {
    expect(decodeDeviceInfo(Buffer.from('0401030503040400', 'hex'))).toEqual({
      firmwareVersion: '4.4.0', formFactor: 'USB-C keychain',
    });
  });
});
