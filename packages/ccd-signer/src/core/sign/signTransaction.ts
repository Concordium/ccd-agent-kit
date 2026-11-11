import {
  cloneSignatureMap,
  computeAccountTransactionSigningDigest,
  countSignatureEntries,
  normalizeRoleSeparatedSignatureMaps,
} from '@ccd-agent-kit/sdk-utils';
import type { AccountTransactionSignature } from '@concordium/web-sdk';

import { parseUnsignedHexAccountTransaction } from '../parser/parseTransaction.js';
import type {
  RoleSeparatedSignatures,
  SignatureRequirements,
  SignedTransactionResult,
  SigningRole,
} from './model.js';
import type { TransactionSigningBackend } from './transactionSigningBackend.js';
import { decodeSignatureRequirements } from './signatureRequirements.js';

/**
 * Stable signing error codes.
 */
export type SigningErrorCode = 'invalid_input' | 'unsupported_role';

/**
 * Options for signing a parseable account transaction.
 */
export interface SignTransactionOptions {
  /** The backend used to create a Concordium account-transaction signature. */
  backend: TransactionSigningBackend;
  /** Exact credential/key pairs to sign, such as `0:0`. */
  keys?: string[];
  /** Maximum number of automatically selected keys to sign. Defaults to 1. */
  maxSignatures?: number;
  /** The role to sign as. */
  role: SigningRole;
  /** Optional builder-compatible signature requirements, valid for hex input only. */
  signatureRequirements?: SignatureRequirements;
  /** Existing detached signatures to merge before creating a new one. */
  signatures?: RoleSeparatedSignatures;
}

export type ParsedUnsignedAccountTransaction = ReturnType<typeof parseUnsignedHexAccountTransaction>;

/**
 * Error raised when transaction signing cannot proceed.
 */
export class SigningError extends Error {
  /** The stable signing error code. */
  public readonly code: SigningErrorCode;

  /**
   * Creates a signing error.
   *
   * @param code - The stable signing error code.
   * @param message - The human-readable error message.
   */
  public constructor(code: SigningErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = 'SigningError';
  }
}

/**
 * Signs a parseable account transaction and returns detached signatures.
 *
 * @param input - The unsigned transaction hex.
 * @param options - The signing options.
 * @returns Independently owned new and merged signatures, plus completion status; caller/backend maps are not shared.
 * @throws {SigningError} If the input cannot be signed or the role is unsupported.
 */
export async function signTransaction(
  input: string,
  options: SignTransactionOptions,
): Promise<SignedTransactionResult> {
  validateKeySelection(options);
  const mergedExistingSignatures = normalizeRoleSeparatedSignatureMaps(options.signatures);
  const unsigned = parseUnsignedHexAccountTransaction(input);
  return signUnsignedHexTransaction(input, unsigned, options, mergedExistingSignatures);
}

/** Signs unsigned account transaction data returned by the parser without reparsing the retained unsigned bytes. */
export async function signParsedTransaction(
  input: string,
  unsigned: ParsedUnsignedAccountTransaction,
  options: SignTransactionOptions,
): Promise<SignedTransactionResult> {
  validateKeySelection(options);
  const mergedExistingSignatures = normalizeRoleSeparatedSignatureMaps(options.signatures);
  return signUnsignedHexTransaction(input, unsigned, options, mergedExistingSignatures);
}

function validateKeySelection(options: SignTransactionOptions): void {
  if (options.keys !== undefined && options.maxSignatures !== undefined) {
    throw new SigningError('invalid_input', 'Provide either keys or maxSignatures, not both.');
  }
  if (options.maxSignatures !== undefined && (!Number.isInteger(options.maxSignatures) || options.maxSignatures < 1)) {
    throw new SigningError('invalid_input', 'maxSignatures must be a positive integer.');
  }
  if (options.keys !== undefined && options.keys.length === 0) {
    throw new SigningError('invalid_input', 'keys must contain at least one credential/key pair.');
  }
}

function validateSignatureRequirements(
  requirements: unknown,
): { sender?: number; sponsor?: number } | undefined {
  if (requirements === undefined) {
    return undefined;
  }
  const { sender, sponsor, total } = decodeSignatureRequirements(
    requirements,
    (message) => new SigningError('invalid_input', message),
  );

  if (total !== undefined && total !== (sender ?? 0) + (sponsor ?? 0)) {
    throw new SigningError(
      'invalid_input',
      'totalSignatureCount must equal senderNumSignatures plus sponsorNumSignatures.',
    );
  }

  return { sender, sponsor };
}

function mergeRoleSeparatedSignatures(
  existing: RoleSeparatedSignatures,
  role: SigningRole,
  newSignature: AccountTransactionSignature,
): RoleSeparatedSignatures {
  const target = role === 'sender' ? existing.sender : existing.sponsor;

  for (const [credentialIndex, keySignatures] of Object.entries(newSignature)) {
    for (const keyIndex of Object.keys(keySignatures)) {
      if (target[Number(credentialIndex)]?.[Number(keyIndex)] !== undefined) {
        throw new SigningError(
          'invalid_input',
          `Duplicate signature found for ${role} credential index ${credentialIndex} at key index ${keyIndex}.`,
        );
      }
    }
  }

  return {
    sender: role === 'sender' ? mergeSignatureMaps(existing.sender, newSignature) : existing.sender,
    sponsor: role === 'sponsor' ? mergeSignatureMaps(existing.sponsor, newSignature) : existing.sponsor,
  };
}

function mergeSignatureMaps(
  left: AccountTransactionSignature,
  right: AccountTransactionSignature,
): AccountTransactionSignature {
  const merged = cloneSignatureMap(left);

  for (const [credentialIndex, keySignatures] of Object.entries(right)) {
    const credentialIndexNumber = Number(credentialIndex);
    const target = (merged[credentialIndexNumber] ??= {});
    for (const [keyIndex, signature] of Object.entries(keySignatures)) target[Number(keyIndex)] = signature;
  }

  return merged;
}

function ensureSignatureCreated(signatureMap: AccountTransactionSignature, missingSignatures: number): void {
  if (missingSignatures > 0 && countSignatureEntries(signatureMap) === 0) {
    throw new SigningError('invalid_input', 'No new signature was produced.');
  }
}

async function signUnsignedHexTransaction(
  input: string,
  unsigned: ParsedUnsignedAccountTransaction,
  options: SignTransactionOptions,
  mergedExistingSignatures: RoleSeparatedSignatures,
): Promise<SignedTransactionResult> {
  const version = unsigned.transaction.version;
  const requirements = validateSignatureRequirements(options.signatureRequirements);
  const requirementsKnown = hasCompleteSignatureRequirements(unsigned, requirements);

  if (options.role === 'sponsor' && version !== 1) {
    throw new SigningError('unsupported_role', 'Sponsor signing requires a version 1 transaction.');
  }

  if (countSignatureEntries(mergedExistingSignatures.sponsor) > 0 && version !== 1) {
    throw new SigningError('invalid_input', 'Sponsor signatures are not valid for version 0 transactions.');
  }

  const missingBeforeSigning = getUnsignedHexMissingSignatures(
    unsigned,
    mergedExistingSignatures,
    options,
    requirements,
  );
  const newSignature = await options.backend.createSignature({
    digest: computeAccountTransactionSigningDigest(unsigned.transaction),
    existingSignatures: mergedExistingSignatures[options.role],
    keys: options.keys,
    maxSignatures: options.keys === undefined ? (options.maxSignatures ?? 1) : undefined,
    missingSignatures: missingBeforeSigning[options.role],
    role: options.role,
  });
  ensureSignatureCreated(newSignature, missingBeforeSigning[options.role]);

  const ownedNewSignature = cloneSignatureMap(newSignature);
  const mergedSignatures = mergeRoleSeparatedSignatures(mergedExistingSignatures, options.role, ownedNewSignature);
  const missingAfterSigning = {
    ...missingBeforeSigning,
    [options.role]: Math.max(missingBeforeSigning[options.role] - countSignatureEntries(newSignature), 0),
  };

  return {
    transaction: input,
    roleSigned: options.role,
    newSignature: ownedNewSignature,
    signatures: mergedSignatures,
    isFullySigned: requirementsKnown && missingAfterSigning.sender === 0 && missingAfterSigning.sponsor === 0,
    signatureRequirementsKnown: requirements !== undefined,
    missingSignatures: missingAfterSigning,
  };
}

function hasUnsignedHexSponsor(unsigned: ReturnType<typeof parseUnsignedHexAccountTransaction>): boolean {
  return unsigned.kind !== 0 && unsigned.transaction.header.sponsor !== undefined;
}

function hasCompleteSignatureRequirements(
  unsigned: ReturnType<typeof parseUnsignedHexAccountTransaction>,
  requirements: { sender?: number; sponsor?: number } | undefined,
): boolean {
  if (requirements?.sender === undefined || requirements.sender < 1) {
    return false;
  }

  if (hasUnsignedHexSponsor(unsigned)) {
    return requirements.sponsor !== undefined && requirements.sponsor > 0;
  }

  return requirements.sponsor === undefined || requirements.sponsor === 0;
}

function getUnsignedHexMissingSignatures(
  unsigned: ReturnType<typeof parseUnsignedHexAccountTransaction>,
  signatures: RoleSeparatedSignatures,
  options: SignTransactionOptions,
  requirements: { sender?: number; sponsor?: number } | undefined,
): { sender: number; sponsor: number } {
  const senderRequired = requirements?.sender ?? getUnsignedHexRequiredSignatures('sender', signatures.sender, options);
  const sponsorRequired = hasUnsignedHexSponsor(unsigned)
    ? (requirements?.sponsor ?? getUnsignedHexRequiredSignatures('sponsor', signatures.sponsor, options))
    : 0;

  return {
    sender: Math.max(senderRequired - countSignatureEntries(signatures.sender), 0),
    sponsor: Math.max(sponsorRequired - countSignatureEntries(signatures.sponsor), 0),
  };
}

function getUnsignedHexRequiredSignatures(
  role: SigningRole,
  signatures: AccountTransactionSignature,
  options: SignTransactionOptions,
): number {
  const existingCount = countSignatureEntries(signatures);
  if (options.role !== role) {
    return Math.max(existingCount, 1);
  }

  if (options.keys !== undefined) {
    return existingCount + options.keys.length;
  }

  return existingCount + (options.maxSignatures ?? 1);
}
