import type { ToolContext } from '../../toolPlumbing/toolTypes.js';

/** Default expiry offset (30 minutes) applied when the caller provides none. */
export const DEFAULT_EXPIRY_MS = 30 * 60 * 1000;

/** Default NRG energy budget when the caller provides none. */
export const DEFAULT_ENERGY = 10000n;

export async function resolveTransactionMetadata(
  ctx: ToolContext,
  sender: string,
  sequenceNumber: string | undefined = undefined,
  expiryMs: number | undefined = undefined,
): Promise<{ sequenceNumber: string; expiry: number }> {
  const resolvedSequenceNumber =
    sequenceNumber ?? (await ctx.clients.getClient().client.getNextAccountSequenceNumber(sender)).sequenceNumber;
  return {
    sequenceNumber: resolvedSequenceNumber,
    expiry: Math.floor((Date.now() + (expiryMs ?? DEFAULT_EXPIRY_MS)) / 1000),
  };
}
