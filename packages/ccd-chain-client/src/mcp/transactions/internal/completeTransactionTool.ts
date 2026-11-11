import { hexStringSchema, roleSeparatedSignaturesSchema } from '@ccd-agent-kit/mcp-utils';
import {
  finalizeParsedAccountTransaction,
  parseUnsignedAccountTransactionHex,
} from '@ccd-agent-kit/sdk-utils';
import { z } from 'zod';
import { networkNameSchema } from '../../toolPlumbing/toolSchemas.js';
import type { ToolContext } from '../../toolPlumbing/toolTypes.js';
import { combineParsedTransactionSignatures } from './combineTransactionSignaturesTool.js';

const roleSeparatedSignatureSetsSchema = z.union([roleSeparatedSignaturesSchema, z.array(roleSeparatedSignaturesSchema).min(1)]);
type RoleSeparatedSignatureSet = z.infer<typeof roleSeparatedSignaturesSchema>;

/** Arguments for public post-signing transaction completion. */
export const completeTransactionArgsSchema = z
  .object({
    transactionHex: hexStringSchema.describe('Unsigned account transaction or finalized block item hex.').optional(),
    signatures: roleSeparatedSignatureSetsSchema
      .describe('Detached account signatures as one role-separated set or an array of sets.')
      .optional(),
    submit: z.boolean().optional().describe('Broadcast the finalized block item. Defaults to false.'),
    finalize: z.boolean().optional().describe('Create blockItemHex when possible. Defaults to true; false means do not create blockItemHex.'),
    returnInput: z.boolean().optional(),
    network: networkNameSchema,
  })
  .refine((args) => args.transactionHex !== undefined || args.signatures !== undefined, {
    message: 'Provide transactionHex, signatures, or both.',
  })
  .refine((args) => !(args.submit === true && args.finalize === false), {
    message: 'submit true requires finalization; finalize cannot be false.',
  });
export type CompleteTransactionArgs = z.infer<typeof completeTransactionArgsSchema>;

/** Result returned by public post-signing transaction completion. */
export type CompleteTransactionResult = Record<string, unknown> & {
  submitted: boolean;
  submissionSkipped?: boolean;
  skipReason?: string;
  blockItemHex?: string;
  transactionHash?: string;
  verificationSkipped?: boolean;
};

/**
 * Completes post-signing transaction handling without signing: combine detached
 * signatures, finalize complete signature sets, and optionally submit.
 * Signature combination reads caller maps and builds independently owned output maps.
 */
export async function completeTransaction(
  ctx: ToolContext,
  args: CompleteTransactionArgs,
): Promise<CompleteTransactionResult> {
  if (args.transactionHex === undefined && args.signatures === undefined) {
    throw { kind: 'invalid-argument', message: 'Provide transactionHex, signatures, or both.' };
  }
  if (args.submit === true && args.finalize === false) {
    throw { kind: 'invalid-argument', message: 'submit true requires finalization; finalize cannot be false.' };
  }

  if (args.signatures === undefined) {
    if (args.submit !== true) return { submitted: false };
    return submitBlockItem(ctx, args.network, args.transactionHex!, args.returnInput === true);
  }

  const signatureSets = normalizeSignatureSets(args.signatures);
  if (args.transactionHex === undefined) {
    return {
      signatures: combineUnverifiedSignatureSets(signatureSets),
      submitted: false,
      verificationSkipped: true,
      skipReason: 'transactionHex not provided',
    };
  }

  const unsigned = runCompletionStage(
    () => parseUnsignedAccountTransactionHex(args.transactionHex!),
    'transactionHex is not a valid unsigned account transaction.',
  );
  const combined = await combineParsedTransactionSignatures(ctx, unsigned, signatureSets, args.network);
  if (!combined.isFullySigned) {
    return {
      ...combined,
      submitted: false,
      ...(args.submit === true ? { submissionSkipped: true, skipReason: 'incomplete-signature-set' as const } : {}),
    };
  }
  if (args.finalize === false) return { ...combined, submitted: false };

  const finalized = runCompletionStage(
    () => finalizeParsedAccountTransaction(unsigned, combined.signatures),
    'Account transaction signatures could not be finalized.',
  );
  return maybeSubmit(ctx, combined.network, { ...combined, ...finalized }, args.submit === true);
}

function normalizeSignatureSets(signatures: z.infer<typeof roleSeparatedSignatureSetsSchema>): RoleSeparatedSignatureSet[] {
  return Array.isArray(signatures) ? signatures : [signatures];
}

function combineUnverifiedSignatureSets(signatureSets: RoleSeparatedSignatureSet[]): RoleSeparatedSignatureSet {
  const combined: RoleSeparatedSignatureSet = { sender: {}, sponsor: {} };
  for (const signatureSet of signatureSets) {
    for (const role of ['sender', 'sponsor'] as const) {
      for (const [credentialIndex, keys] of Object.entries(signatureSet[role])) {
        const target = (combined[role][Number(credentialIndex)] ??= {});
        for (const [keyIndex, signature] of Object.entries(keys)) target[Number(keyIndex)] = signature.toLowerCase();
      }
    }
  }
  return combined;
}

function runCompletionStage<T>(operation: () => T, failureMessage: string): T {
  try {
    return operation();
  } catch (error) {
    if (isPublicProducerError(error)) throw error;
    throw { kind: 'invalid-argument', message: failureMessage };
  }
}

function isPublicProducerError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as Record<string, unknown>;
  if (typeof candidate.message !== 'string') return false;
  if (candidate.kind === 'invalid-argument') return true;
  if (candidate.kind === 'node') return candidate.code === undefined || typeof candidate.code === 'number';
  return (
    candidate.kind === 'chain-capability' &&
    typeof candidate.capability === 'string' &&
    typeof candidate.network === 'string'
  );
}

async function maybeSubmit<T extends { blockItemHex: string }>(
  ctx: ToolContext,
  network: string | undefined,
  result: T,
  submit: boolean,
): Promise<CompleteTransactionResult> {
  if (!submit) return { ...result, submitted: false };
  const submitted = await submitBlockItem(ctx, network, result.blockItemHex, true);
  return { ...result, ...submitted };
}

async function submitBlockItem(
  ctx: ToolContext,
  network: string | undefined,
  blockItemHex: string,
  returnInput: boolean,
): Promise<CompleteTransactionResult> {
  const { client, networkName } = ctx.clients.getClient(network);
  const transactionHash = await client.submitBlockItem(blockItemHex);
  return { ...(returnInput ? { blockItemHex } : {}), submitted: true, transactionHash, network: networkName };
}
