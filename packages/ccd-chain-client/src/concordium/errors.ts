import { z } from 'zod';

import type { ChainCapabilityError } from './protocol.js';

const NODE_ERROR_MESSAGE = 'Concordium node request failed.';
const nodeErrorSchema = z.object({ code: z.number().optional() });

/** Stable node-boundary failures; capability and argument errors retain their original identity. */
export type ConcordiumClientError =
  | { kind: 'node'; message: string; code?: number }
  | { kind: 'invalid-argument'; message: string }
  | ChainCapabilityError;

function isKnownClientError(
  err: unknown,
): err is Extract<ConcordiumClientError, { kind: 'invalid-argument' | 'chain-capability' }> {
  return (
    typeof err === 'object' &&
    err !== null &&
    ((err as { kind?: unknown }).kind === 'invalid-argument' || (err as { kind?: unknown }).kind === 'chain-capability')
  );
}

function toClientError(err: unknown): ConcordiumClientError {
  if (isKnownClientError(err)) return err;
  const parsed = nodeErrorSchema.safeParse(err);
  const code = parsed.success ? parsed.data.code : undefined;
  return {
    kind: 'node',
    message: NODE_ERROR_MESSAGE,
    ...(code === undefined ? {} : { code }),
  };
}

/** Runs `fn`, preserving public domain failures and sanitizing failures from the node boundary. */
export function guard<T>(fn: () => Promise<T>): Promise<T> {
  return fn().catch((err: unknown) => {
    throw toClientError(err);
  });
}
