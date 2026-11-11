import { signatureRequirementsSchema } from '@ccd-agent-kit/mcp-utils';

export interface DecodedSignatureRequirements {
  /** Required sender signatures when supplied. */
  sender?: number;
  /** Required sponsor signatures when supplied. */
  sponsor?: number;
  /** Required total signatures when supplied. */
  total?: number;
}

/** Decodes shared requirement fields while leaving flow-specific threshold decisions to the caller. */
export function decodeSignatureRequirements(
  value: unknown,
  createError: (message: string) => Error,
): DecodedSignatureRequirements {
  const parsed = signatureRequirementsSchema.safeParse(value);
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path.join('.') || 'signatureRequirements';
    throw createError(`Invalid signatureRequirements: ${field}.`);
  }

  return {
    sender: decodeCount(parsed.data.senderNumSignatures),
    sponsor: decodeCount(parsed.data.sponsorNumSignatures),
    total: decodeCount(parsed.data.totalSignatureCount),
  };
}

function decodeCount(value: string | undefined): number | undefined {
  return value === undefined ? undefined : Number(value);
}
