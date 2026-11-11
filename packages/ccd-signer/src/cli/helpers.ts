import { parseJsonCliValue, type UsageErrorFactory } from '@ccd-agent-kit/cli-utils';
import { roleSeparatedSignaturesSchema } from '@ccd-agent-kit/mcp-utils';
import type { RoleSeparatedSignatures } from '../core/sign/model.js';

/** Parses sender/sponsor detached signatures from a JSON CLI option. */
export function parseRoleSeparatedSignatures(
  value: string,
  error: string,
  usageError: UsageErrorFactory,
): RoleSeparatedSignatures {
  const parsed = roleSeparatedSignaturesSchema.safeParse(parseJsonCliValue(value, error, usageError));
  if (!parsed.success) {
    throw usageError(error);
  }
  return parsed.data;
}
