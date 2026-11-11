import { Buffer } from 'node:buffer';
import type { PivSlotMetadata } from './types.js';

function readTlv(data: Buffer, start: number): { tag: number; value: Buffer; end: number } {
  let offset = start;
  const take = () => {
    if (offset >= data.length) throw new Error('Malformed PIV TLV.');
    return data[offset++]!;
  };
  let tag = take();
  if ((tag & 0x1f) === 0x1f) tag = (tag << 8) | take();
  const first = take();
  let length = first;
  if (first === 0x81) length = take();
  else if (first === 0x82) length = (take() << 8) | take();
  else if (first >= 0x80) throw new Error('Unsupported PIV TLV length.');
  const end = offset + length;
  if (end > data.length) throw new Error('Truncated PIV TLV value.');
  return { tag, value: data.subarray(offset, end), end };
}

/** Decode one complete TLV for consumers requiring strict framing. */
export function parseFirstTlvStrict(data: Buffer): { tag: number; value: Buffer } | undefined {
  if (data.length === 0) return undefined;
  const { tag, value } = readTlv(data, 0);
  return { tag, value };
}

/** Decode all TLVs, rejecting malformed framing rather than returning partial observations. */
export function parseAllTlvsStrict(data: Buffer): Array<{ tag: number; value: Buffer }> {
  const values: Array<{ tag: number; value: Buffer }> = [];
  let offset = 0;
  while (offset < data.length) {
    const { tag, value, end } = readTlv(data, offset);
    values.push({ tag, value });
    offset = end;
  }
  return values;
}

/** Decode identity-facing metadata with complete, untruncated public-key templates. */
export function parseSlotMetadata(data: Buffer, slot: string): PivSlotMetadata {
  const metadata: PivSlotMetadata = { slot, status: 'empty' };
  for (const { tag, value } of parseAllTlvsStrict(data)) {
    if (((tag === 1 || tag === 3) && value.length !== 1) || (tag === 2 && value.length !== 2)) throw new Error('Malformed PIV metadata field.');
    if (tag === 1) metadata.algorithm = value[0]!;
    if (tag === 2) {
      const pinPolicy = value[0] === 1 ? 'never' : value[0] === 2 ? 'once' : value[0] === 3 ? 'always' : undefined;
      const touchPolicy = value[1] === 1 ? 'never' : value[1] === 2 ? 'always' : value[1] === 3 ? 'cached' : undefined;
      if (pinPolicy !== undefined) metadata.pinPolicy = pinPolicy;
      if (touchPolicy !== undefined) metadata.touchPolicy = touchPolicy;
    }
    if (tag === 3) metadata.origin = value[0] === 1 ? 'generated' : value[0] === 2 ? 'imported' : 'unknown';
    if (tag === 4) metadata.publicKeyTemplate = Buffer.from(value);
  }
  if (metadata.algorithm !== undefined || metadata.publicKeyTemplate !== undefined) metadata.status = 'occupied';
  return metadata;
}
