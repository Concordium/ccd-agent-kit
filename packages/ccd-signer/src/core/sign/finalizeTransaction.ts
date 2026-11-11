import {
  countSignatureEntries,
  finalizeParsedAccountTransaction,
} from '@ccd-agent-kit/sdk-utils';
import type { SignatureRequirementsDto } from '@ccd-agent-kit/mcp-utils';

import { parseUnsignedHexAccountTransaction } from '../parser/parseTransaction.js';
import type { RoleSeparatedSignatures } from './model.js';
import { decodeSignatureRequirements } from './signatureRequirements.js';

export interface FinalizeTransactionOptions {
  signatures: RoleSeparatedSignatures;
  /** Explicit builder-provided signature-count metadata required for standalone finalization. */
  signatureRequirements: SignatureRequirementsDto;
  transactionHex: string;
}

export interface FinalizedTransactionResult {
  transactionVersion: 'v0' | 'v1';
  blockItemHex: string;
  isFullySigned: true;
  signatures: RoleSeparatedSignatures;
}

export class FinalizeTransactionError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'FinalizeTransactionError';
  }
}

/** Finalizes detached signatures without mutating caller input; returned signature maps are independent copies. */
export function finalizeTransaction(options: FinalizeTransactionOptions): FinalizedTransactionResult {
  const signatures = { sender: options.signatures?.sender ?? {}, sponsor: options.signatures?.sponsor ?? {} };
  return finalizeUnsignedHexTransaction(options.transactionHex, signatures, options.signatureRequirements);
}

function finalizeUnsignedHexTransaction(
  transactionHex: string,
  signatures: RoleSeparatedSignatures,
  signatureRequirements: SignatureRequirementsDto,
): FinalizedTransactionResult {
  const unsigned = parseUnsignedHexAccountTransaction(transactionHex);
  const requirements = validateSignatureRequirements(unsigned, signatureRequirements);

  if (
    countSignatureEntries(signatures.sender) < requirements.sender ||
    countSignatureEntries(signatures.sponsor) < requirements.sponsor
  ) {
    throw new FinalizeTransactionError('Transaction is not fully signed.');
  }

  if (unsigned.kind === 0) {
    if (countSignatureEntries(signatures.sponsor) > 0) {
      throw new FinalizeTransactionError('Sponsor signatures are not valid for version 0 transactions.');
    }

    return { ...finalizeParsedAccountTransaction(unsigned, signatures), isFullySigned: true };
  }

  if (unsigned.transaction.header.sponsor === undefined && countSignatureEntries(signatures.sponsor) > 0) {
    throw new FinalizeTransactionError('Sponsor signatures are not valid for transactions without a sponsor.');
  }

  return { ...finalizeParsedAccountTransaction(unsigned, signatures), isFullySigned: true };
}

function validateSignatureRequirements(
  unsigned: ReturnType<typeof parseUnsignedHexAccountTransaction>,
  value: unknown,
): { sender: number; sponsor: number } {
  const decoded = decodeSignatureRequirements(value, (message) => new FinalizeTransactionError(message));
  const sender = requiredCount(decoded.sender, 'senderNumSignatures');
  const sponsor = decoded.sponsor;
  const sponsorMetadataPresent = sponsor !== undefined;
  const total = decoded.total;
  const hasSponsor = unsigned.kind !== 0 && unsigned.transaction.header.sponsor !== undefined;

  if (sender < 1) {
    throw new FinalizeTransactionError('senderNumSignatures must be a positive integer string.');
  }
  if (!hasSponsor && sponsorMetadataPresent) {
    throw new FinalizeTransactionError('sponsorNumSignatures are not valid for transactions without a sponsor.');
  }
  if (hasSponsor && sponsor === undefined) {
    throw new FinalizeTransactionError('sponsorNumSignatures are required for sponsored transactions.');
  }
  if (hasSponsor && sponsor !== undefined && sponsor < 1) {
    throw new FinalizeTransactionError('sponsorNumSignatures must be a positive integer string for sponsored transactions.');
  }
  const normalizedSponsor = hasSponsor ? sponsor! : 0;
  if (total !== undefined && total !== sender + normalizedSponsor) {
    throw new FinalizeTransactionError('totalSignatureCount must equal senderNumSignatures plus sponsorNumSignatures.');
  }

  return { sender, sponsor: normalizedSponsor };
}

function requiredCount(value: number | undefined, field: string): number {
  if (value === undefined) {
    throw new FinalizeTransactionError(`${field} is required.`);
  }
  return value;
}
