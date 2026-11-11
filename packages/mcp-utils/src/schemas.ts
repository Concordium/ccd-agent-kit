import { z } from 'zod';
import type { AccountTransactionSignature } from '@concordium/web-sdk';
import type { McpJsonValue, RoleSeparatedSignaturesDto, SignatureRequirementsDto } from './types.js';

const EVEN_HEX_PATTERN = /^(?:[0-9a-fA-F]{2})+$/;
const CANONICAL_BYTE_INDEX_PATTERN = /^(?:0|[1-9]\d?|1\d{2}|2[0-4]\d|25[0-5])$/;
const DECIMAL_STRING_PATTERN = /^\d+$/;
const safeIntegerDecimalStringSchema = z
  .string()
  .refine(
    (value) => DECIMAL_STRING_PATTERN.test(value) && Number.isSafeInteger(Number(value)),
    'Expected a non-negative safe integer decimal string.',
  );

/** Zod schema for non-empty even-length hex strings. */
export const hexStringSchema = z.string().refine((value) => EVEN_HEX_PATTERN.test(value), {
  message: 'Expected an even-length hex string.',
});

/** Validates detached signatures with canonical decimal credential/key indexes from 0 through 255. */
export const signatureMapSchema: z.ZodType<AccountTransactionSignature> = z.record(
  z.string().regex(CANONICAL_BYTE_INDEX_PATTERN, 'Expected a canonical decimal credential index from 0 to 255.'),
  z.record(
    z.string().regex(CANONICAL_BYTE_INDEX_PATTERN, 'Expected a canonical decimal key index from 0 to 255.'),
    hexStringSchema,
  ),
);

/**
 * Validates role-separated account transaction signatures.
 *
 * Missing `sender` or `sponsor` roles default to empty signature maps, while
 * explicit `null`, arrays, unknown roles, and malformed nested signature maps
 * are rejected.
 */
export const roleSeparatedSignaturesSchema: z.ZodType<RoleSeparatedSignaturesDto> = z
  .object({
    sender: signatureMapSchema.default({}),
    sponsor: signatureMapSchema.default({}),
  })
  .strict();

/**
 * Validates optional account transaction signature-count requirements.
 *
 * Counts are kept as decimal strings to match signing/finalization DTOs. Empty
 * objects are allowed; callers decide whether a count is required for their flow.
 */
export const signatureRequirementsSchema: z.ZodType<SignatureRequirementsDto> = z
  .object({
    senderNumSignatures: safeIntegerDecimalStringSchema.optional(),
    sponsorNumSignatures: safeIntegerDecimalStringSchema.optional(),
    totalSignatureCount: safeIntegerDecimalStringSchema.optional(),
  })
  .strict();

/** Zod schema for JSON values that can be carried in MCP structured content and JSON text. */
export const mcpJsonValueSchema: z.ZodType<McpJsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(mcpJsonValueSchema),
    z.record(z.string(), mcpJsonValueSchema),
  ]),
);
