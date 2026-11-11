import { z } from 'zod';
import { parseJsonCliValue, validateCliOptions } from '@ccd-agent-kit/cli-utils';
import { signatureRequirementsSchema } from '@ccd-agent-kit/mcp-utils';
import { readFileSync } from 'node:fs';

import { SigningError } from '../core/sign/signTransaction.js';
import { finalizeTransaction } from '../core/sign/finalizeTransaction.js';
import type { RoleSeparatedSignatures, SignatureRequirements, SigningRole } from '../core/sign/model.js';
import { ManagedTransactionSigningError, signManagedTransaction } from '../core/sign/managedTransactionSigning.js';
import { parseRoleSeparatedSignatures } from './helpers.js';
import { createCliYubiKeyInteraction } from './yubiKeyInteraction.js';
import { loadCliInputSource, resolveCliInputSource, type CliInputSource } from './inputLoader.js';

/** Typed request accepted by the transaction signing handler after Commander parsing. */
export interface SignCommandRequest {
  /** Resolved unsigned transaction input source. */
  source: CliInputSource;
  role: SigningRole;
  signatures?: RoleSeparatedSignatures;
  keys?: string[];
  maxSignatures?: number;
  signatureRequirements?: SignatureRequirements;
  network?: string;
}

/**
 * Runtime hooks used by the CLI sign command implementation.
 */
export interface RunSignCommandOptions {
  /** Typed request from the Commander adapter. */
  request: SignCommandRequest;
  /** Optional stdin content for tests and non-process callers. */
  stdin?: string;
  /** Receives stdout lines. */
  stdout: string[];
  /** Receives stderr lines. */
  stderr: string[];
  /** Optional YubiKey PIN prompt for tests and alternate hosts. */
  promptPin?: () => Promise<string>;
}

/** Builds a sign request from already parsed CLI option values. */
export function createSignCommandRequest(options: {
  input?: string;
  inputFile?: string;
  stdin?: boolean;
  role: string;
  signatures?: string;
  signaturesFile?: string;
  key?: string[];
  maxSignatures?: string;
  signatureRequirements?: string;
  network?: string;
}): SignCommandRequest {
  try {
    const normalized = validateCliOptions(
      z
        .object({
          role: z.enum(['sender', 'sponsor']),
          signatures: z.string().optional(),
          signaturesFile: z.string().optional(),
          key: z.array(z.string()).optional(),
          maxSignatures: z.coerce.number().int().positive().optional(),
          signatureRequirements: z.string().optional(),
          network: z.string().optional(),
        })
        .refine((value) => !(value.signatures && value.signaturesFile), { message: signCommandMessages.signaturesSourceConflict })
        .refine((value) => !(value.key && value.maxSignatures !== undefined), { message: signCommandMessages.keySelectionConflict }),
      { ...options, key: options.key?.length ? options.key : undefined },
    );
    return {
      source: resolveCliInputSource(options, signCommandMessages.singleInputSourceRequired),
      role: normalized.role,
      signatures: normalized.signatures ? parseSignatures(normalized.signatures) : normalized.signaturesFile ? parseSignatures(readFileSyncUtf8(normalized.signaturesFile)) : undefined,
      keys: normalized.key,
      maxSignatures: normalized.maxSignatures,
      signatureRequirements: normalized.signatureRequirements ? parseSignatureRequirements(normalized.signatureRequirements) : undefined,
      network: normalized.network,
    };
  } catch (error) {
    if (error instanceof CliUsageError) throw error;
    throw new CliUsageError(error instanceof Error ? error.message : String(error));
  }
}

/** Typed errors owned by the transaction signing CLI command. */
export type SignCommandError =
  | { kind: 'single-input-source-required' }
  | { kind: 'signatures-source-conflict' }
  | { kind: 'key-selection-conflict' }
  | { kind: 'invalid-signatures-json' }
  | { kind: 'invalid-signature-requirements-json' }
  | { kind: 'signing-failed'; message: string };

/** User-facing messages owned by the transaction signing CLI command. */
export const signCommandMessages = {
  invalidSignatureRequirementsJson: 'Signature requirements must be valid JSON.',
  invalidSignaturesJson: 'Detached signatures must be valid JSON.',
  keySelectionConflict: 'Provide either --key or --max-signatures, not both.',
  signaturesSourceConflict: 'Provide detached signatures via --signatures or --signatures-file, not both.',
  signingFailed: (message: string) => `Signing failed: ${message}`,
  singleInputSourceRequired: 'A single input source must be provided via --input, --input-file, or --stdin.',
} as const;

/** Renders typed transaction signing command errors for the CLI boundary. */
export function renderSignCommandError(error: SignCommandError): string {
  switch (error.kind) {
    case 'invalid-signature-requirements-json':
      return signCommandMessages.invalidSignatureRequirementsJson;
    case 'invalid-signatures-json':
      return signCommandMessages.invalidSignaturesJson;
    case 'key-selection-conflict':
      return signCommandMessages.keySelectionConflict;
    case 'signatures-source-conflict':
      return signCommandMessages.signaturesSourceConflict;
    case 'signing-failed':
      return signCommandMessages.signingFailed(error.message);
    case 'single-input-source-required':
      return signCommandMessages.singleInputSourceRequired;
  }
}

/**
 * Runs the `sign` command and returns its process exit code.
 *
 * @param options - The runtime command options.
 * @returns A promise resolving to the command exit code.
 */
export async function runSignCommand(options: RunSignCommandOptions): Promise<number> {
  try {
    const rawInput = await loadCliInputSource(options.request.source, options.stdin);

    const result = await signManagedTransaction({
      transactionHex: rawInput,
      keys: options.request.keys,
      maxSignatures: options.request.maxSignatures,
      network: options.request.network,
      role: options.request.role,
      signatureRequirements: options.request.signatureRequirements,
      signatures: options.request.signatures,
      yubiKeyInteraction: createCliYubiKeyInteraction(options.promptPin),
    });

    options.stdout.push(
      JSON.stringify(
        {
          ...result,
          ...(result.isFullySigned && options.request.signatureRequirements !== undefined
            ? finalizeTransaction({
                transactionHex: rawInput,
                signatureRequirements: options.request.signatureRequirements,
                signatures: result.signatures,
              })
            : {}),
        },
        null,
        2,
      ),
    );

    return 0;
  } catch (error) {
    if (error instanceof SigningError) {
      options.stderr.push(renderSignCommandError({ kind: 'signing-failed', message: error.message }));
      return 1;
    }

    if (error instanceof ManagedTransactionSigningError) {
      options.stderr.push(error.message);
      return 1;
    }

    const message = error instanceof Error ? error.message : String(error);
    options.stderr.push(renderSignCommandError({ kind: 'signing-failed', message }));
    return 1;
  }
}

/**
 * Error raised for CLI usage problems.
 */
export class CliUsageError extends Error {
  /**
   * Creates a CLI usage error.
   *
   * @param message - The usage error message.
   */
  public constructor(message: string) {
    super(message);
    this.name = 'CliUsageError';
  }
}

function parseSignatures(value: string): RoleSeparatedSignatures {
  return parseRoleSeparatedSignatures(
    value,
    signCommandMessages.invalidSignaturesJson,
    (message) => new CliUsageError(message),
  );
}

function parseSignatureRequirements(value: string): SignatureRequirements {
  const parsed = signatureRequirementsSchema.safeParse(
    parseJsonCliValue(value, signCommandMessages.invalidSignatureRequirementsJson, (message) => new CliUsageError(message)),
  );
  if (!parsed.success) {
    throw new CliUsageError(signCommandMessages.invalidSignatureRequirementsJson);
  }
  return parsed.data;
}

function readFileSyncUtf8(path: string): string {
  return readFileSync(path, 'utf8');
}
