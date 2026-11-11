import { z } from 'zod';
import type { BlockIdentifier } from '../../concordium/client.js';

/** A U64 value as a decimal string (JSON has no `bigint`). */
export const u64StringSchema = z
  .string()
  .regex(/^\d+$/, 'Expected an unsigned integer as a decimal string.')
  .describe('Unsigned 64-bit integer as a decimal string.');

export const accountAddressSchema = z.string().describe('Account address in base58check or configured account label.');

/**
 * A block reference accepted by tools: a hex block hash, `best`, or
 * `last_final`. Omitted blocks default to the last finalized block.
 */
export const blockReferenceSchema = z.string().describe('Block hash, or the literals `best` / `last_final`.');

export const networkNameSchema = z
  .string()
  .optional()
  .describe('Network name, CAIP-2 reference, or full CAIP-2 identifier. Uses default network when omitted.');

/** Converts a tool-level block reference into a client `BlockIdentifier`. */
export function parseBlockReference(ref: string | undefined): BlockIdentifier | undefined {
  if (ref === undefined) return undefined;
  if (ref === 'best') return { type: 'best' };
  if (ref === 'last_final') return { type: 'last_final' };
  return { type: 'hash', hash: ref };
}

export const contractAddressSchema = z
  .string()
  .describe('Contract instance as index,subindex, index.subindex, or configured contract-instance label.');
