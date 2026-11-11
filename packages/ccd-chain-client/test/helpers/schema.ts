import { Buffer } from 'node:buffer';

function word32(value: number): Buffer {
  const out = Buffer.alloc(4);
  out.writeUInt32LE(value);
  return out;
}

function schemaString(value: string): Buffer {
  return Buffer.concat([word32(Buffer.byteLength(value)), Buffer.from(value, 'utf8')]);
}

export function schemaOption(value?: Buffer): Buffer {
  return value === undefined ? Buffer.from([0]) : Buffer.concat([Buffer.from([1]), value]);
}

export function schemaFunction(tag: number, ...types: Buffer[]): Buffer {
  return Buffer.concat([Buffer.from([tag]), ...types]);
}

export function schemaMap(entries: Array<[string, Buffer]>): Buffer {
  return Buffer.concat([word32(entries.length), ...entries.flatMap(([key, value]) => [schemaString(key), value])]);
}
