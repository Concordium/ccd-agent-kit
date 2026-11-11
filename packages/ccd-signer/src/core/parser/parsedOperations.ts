import { Buffer } from 'node:buffer';
import { TextDecoder } from 'node:util';

import { Cbor, CborAccountAddress, CborMemo, LockId } from '@concordium/web-sdk';
import { z } from 'zod';

import type { ParsedBinaryValue, ParsedJsonValue, ParsedOperation } from '../model/parsedTransaction.js';

const jsonValueSchema: z.ZodType<ParsedJsonValue> = z.json();
const opaqueOperationSchema = z.record(z.string(), jsonValueSchema).refine((value) => Object.keys(value).length === 1);

/** Wraps an unknown SDK operation after validating its terminal JSON boundary. */
export function parseOpaqueOperation(value: unknown): ParsedOperation {
  return { kind: 'opaqueOperation', operation: opaqueOperationSchema.parse(value) };
}

/** Serializes an internal operation wrapper to its stable single-key public wire shape. */
export function projectParsedOperation(operation: ParsedOperation): { [key: string]: ParsedJsonValue } {
  if (operation.kind === 'opaqueOperation') return operation.operation;

  const text = JSON.stringify(operation.operation, function (this: Record<string, unknown>, key, value: unknown): unknown {
    const original: unknown = key === '' ? operation.operation : this[key];
    if (CborAccountAddress.instanceOf(original)) {
      const accountLabel = operation.participantLabels.get(original);
      return { ...original.toJSON(), ...(accountLabel === undefined ? {} : { accountLabel }) };
    }
    if (CborMemo.instanceOf(original) || (key === 'memo' && original instanceof Uint8Array)) {
      return normalizeOperationMemo(original);
    }
    if (original instanceof Uint8Array) {
      return Buffer.from(original).toString('hex');
    }
    if (isObject(original) && 'lock' in original && LockId.instanceOf(original.lock)) {
      const details = Object.fromEntries(Object.entries(original).filter(([field]) => field !== 'lock'));
      return { ...details, lockId: original.lock.toString() };
    }
    return value;
  });
  return z.record(z.string(), jsonValueSchema).parse(JSON.parse(text));
}

/** Validates an opaque decoded CBOR value as JSON data for the inspection model. */
export function parseParsedJsonValue(value: unknown): ParsedJsonValue {
  return jsonValueSchema.parse(value);
}

/** Projects a native SDK operation memo into the rich public inspection view. */
export function normalizeOperationMemo(value: CborMemo.Type | Uint8Array): ParsedBinaryValue {
  const bytes = CborMemo.instanceOf(value) ? value.content : value;
  const normalized = normalizeBinaryValue(CborMemo.instanceOf(value) ? value.toString() : Buffer.from(value).toString('hex'), bytes);
  try {
    const decoded = CborMemo.instanceOf(value) ? CborMemo.parse(value) : Cbor.decode(Cbor.fromBuffer(Uint8Array.from(bytes).buffer));
    const cbor = parseParsedJsonValue(normalizeDecodedValue(decoded));
    return { ...normalized, cbor, ...(normalized.text === undefined && typeof cbor === 'string' ? { text: cbor } : {}) };
  } catch {
    return normalized;
  }
}

function normalizeBinaryValue(hex: string, bytes: Uint8Array): ParsedBinaryValue {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return /^(?:[\t\n\r]|[\x20-\x7e])+$/.test(text) ? { hex, text } : { hex };
  } catch {
    return { hex };
  }
}

function normalizeDecodedValue(value: unknown): unknown {
  if (value instanceof Uint8Array) return Buffer.from(value).toString('hex');
  if (Array.isArray(value)) return value.map(normalizeDecodedValue);
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, normalizeDecodedValue(entry)]));
  }
  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return isObject(value) && Object.getPrototypeOf(value) === Object.prototype;
}
