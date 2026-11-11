import { Buffer } from 'node:buffer';
import type { PivPinPolicy, PivTouchPolicy } from './types.js';
export { parseSlotMetadata } from './strictCodecs.js';

/** Encode a short APDU using the original signer wire format; callers bound command data. */
export function apdu(cla: number, ins: number, p1: number, p2: number, data?: Buffer): Buffer {
  if (data === undefined || data.length === 0) return Buffer.from([cla, ins, p1, p2, 0]);
  return Buffer.concat([Buffer.from([cla, ins, p1, p2, data.length]), data, Buffer.from([0])]);
}

/** Encode the original signer's single-byte TLV tag and definite length format. */
export function tlv(tag: number, value: Buffer): Buffer {
  const length = value.length;
  const encodedLength = length < 128 ? [length] : length <= 255 ? [0x81, length] : [0x82, length >> 8, length & 255];
  return Buffer.concat([Buffer.from([tag]), Buffer.from(encodedLength), value]);
}

/** Parse the first TLV using the original signer's permissive observation semantics. */
export function parseFirstTlv(data: Buffer): { tag: number; value: Buffer } | undefined {
  if (data.length < 2) return undefined;
  let offset = 0;
  let tag = data[offset++]!;
  if ((tag & 0x1f) === 0x1f) tag = (tag << 8) | data[offset++]!;
  const first = data[offset++]!;
  let length = first;
  if (first === 0x81) length = data[offset++]!;
  else if (first === 0x82) length = (data[offset++]! << 8) | data[offset++]!;
  return { tag, value: data.subarray(offset, offset + length) };
}

/** Return complete observed TLVs, stopping at an incomplete value as in the original signer. */
export function parseAllTlvs(data: Buffer): Array<{ tag: number; value: Buffer }> {
  const values: Array<{ tag: number; value: Buffer }> = [];
  let offset = 0;
  while (offset < data.length) {
    let tag = data[offset++]!;
    if ((tag & 0x1f) === 0x1f) tag = (tag << 8) | data[offset++]!;
    const first = data[offset++]!;
    let length = first;
    if (first === 0x81) length = data[offset++]!;
    else if (first === 0x82) length = (data[offset++]! << 8) | data[offset++]!;
    if (offset + length > data.length) break;
    values.push({ tag, value: data.subarray(offset, offset + length) });
    offset += length;
  }
  return values;
}

/** Numeric failed APDU status, shared by all PIV consumers. */
export class ApduStatusError extends Error {
  /** Retains the card's status word without parsing error text. */
  constructor(public readonly status: number) {
    super(`YubiKey APDU failed with status 0x${status.toString(16)}.`);
  }
}

/** Tests a numeric status on a genuine APDU failure. */
export function isStatusError(error: unknown, status: number): boolean {
  return error instanceof ApduStatusError && error.status === status;
}

/** Recognizes a failed PIN verification with remaining retries. */
export function isPinRetryStatus(error: unknown): boolean {
  return error instanceof ApduStatusError && (error.status & 0xfff0) === 0x63c0;
}

/** Returns the management authentication challenge size for TDES or AES. */
export function managementKeyAuthenticationBlockSize(algorithm: number): number {
  return algorithm === 3 ? 8 : 16;
}

/** Encode PIN policy using the original signer mapping; consumers validate their inputs. */
export function pinPolicyByte(policy: PivPinPolicy): number {
  return policy === 'never' ? 1 : policy === 'once' ? 2 : 3;
}

/** Encode touch policy using the original signer mapping; consumers validate their inputs. */
export function touchPolicyByte(policy: PivTouchPolicy): number {
  return policy === 'never' ? 1 : policy === 'always' ? 2 : 3;
}
