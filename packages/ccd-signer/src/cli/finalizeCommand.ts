import { z } from 'zod';
import { parseJsonCliValue, validateCliOptions } from '@ccd-agent-kit/cli-utils';
import { signatureRequirementsSchema, type SignatureRequirementsDto } from '@ccd-agent-kit/mcp-utils';
import { readFileSync } from 'node:fs';

import { finalizeTransaction, FinalizeTransactionError } from '../core/sign/finalizeTransaction.js';
import type { RoleSeparatedSignatures } from '../core/sign/model.js';
import { parseRoleSeparatedSignatures } from './helpers.js';
import { loadCliInputSource, resolveCliInputSource, type CliInputSource } from './inputLoader.js';

/** Typed request accepted by the finalization handler after Commander parsing. */
export interface FinalizeCommandRequest {
  source: CliInputSource;
  signatures: RoleSeparatedSignatures;
  signatureRequirements: SignatureRequirementsDto;
}

/** Typed finalization request and injectable command IO. */
export interface RunFinalizeCommandOptions {
  request: FinalizeCommandRequest;
  stdin?: string;
  stderr: string[];
  stdout: string[];
}

/** Builds a finalization request from already parsed CLI option values. */
export function createFinalizeCommandRequest(options: { input?: string; inputFile?: string; stdin?: boolean; signatures?: string; signaturesFile?: string; signatureRequirements?: string }): FinalizeCommandRequest {
  try {
    const source = resolveCliInputSource(options, finalizeCommandMessages.singleInputSourceRequired);
    const normalized = validateCliOptions(
      z
        .object({ signatures: z.string().optional(), signaturesFile: z.string().optional(), signatureRequirements: z.string().optional() })
        .refine((value) => Number(Boolean(value.signatures)) + Number(Boolean(value.signaturesFile)) === 1, {
          message: finalizeCommandMessages.signaturesRequired,
        })
        .refine((value) => value.signatureRequirements !== undefined, {
          message: finalizeCommandMessages.signatureRequirementsRequired,
        }),
      options,
    );
    return {
      source,
      signatures: normalized.signatures ? parseSignatures(normalized.signatures) : parseSignatures(readFileSync(normalized.signaturesFile!, 'utf8')),
      signatureRequirements: parseSignatureRequirements(normalized.signatureRequirements!),
    };
  } catch (error) {
    if (error instanceof FinalizeCliUsageError) throw error;
    throw new FinalizeCliUsageError(error instanceof Error ? error.message : String(error));
  }
}

/** User-facing messages owned by the transaction finalization CLI command. */
export const finalizeCommandMessages = {
  invalidSignaturesJson: 'Detached signatures must be valid JSON with sender and sponsor objects.',
  invalidSignatureRequirementsJson: 'Signature requirements must be valid JSON with decimal string counts.',
  signatureRequirementsRequired: 'Signature requirements are required via --signature-requirements.',
  signaturesRequired: 'Detached signatures are required via --signatures or --signatures-file.',
  singleInputSourceRequired: 'A single input source must be provided via --input, --input-file, or --stdin.',
} as const;

/** Invalid CLI finalization options, rendered with exit code 2 by the root adapter. */
export class FinalizeCliUsageError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'FinalizeCliUsageError';
  }
}

/** Finalizes a typed transaction request and returns the command exit code. */
export async function runFinalizeCommand(options: RunFinalizeCommandOptions): Promise<number> {
  try {
    const rawInput = await loadCliInputSource(options.request.source, options.stdin);
    const result = finalizeTransaction({
      transactionHex: rawInput,
      signatureRequirements: options.request.signatureRequirements,
      signatures: options.request.signatures,
    });

    options.stdout.push(JSON.stringify(result, null, 2));

    return 0;
  } catch (error) {
    if (error instanceof FinalizeTransactionError) {
      options.stderr.push(error.message);
      return 1;
    }

    throw error;
  }
}

function parseSignatureRequirements(value: string): SignatureRequirementsDto {
  const parsed = signatureRequirementsSchema.safeParse(
    parseJsonCliValue(value, finalizeCommandMessages.invalidSignatureRequirementsJson, (message) => new FinalizeCliUsageError(message)),
  );
  if (!parsed.success) {
    throw new FinalizeCliUsageError(finalizeCommandMessages.invalidSignatureRequirementsJson);
  }
  return parsed.data;
}

function parseSignatures(value: string): RoleSeparatedSignatures {
  const signatures = parseRoleSeparatedSignatures(
    value,
    finalizeCommandMessages.invalidSignaturesJson,
    (message) => new FinalizeCliUsageError(message),
  );
  if (typeof signatures.sender !== 'object' || typeof signatures.sponsor !== 'object') {
    throw new FinalizeCliUsageError(finalizeCommandMessages.invalidSignaturesJson);
  }
  return signatures;
}
