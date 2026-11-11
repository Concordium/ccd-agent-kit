import type { RoleSeparatedSignaturesDto, SignatureRequirementsDto } from '@ccd-agent-kit/mcp-utils';
import type { AccountTransactionSignature } from '@concordium/web-sdk';

/**
 * The supported signing roles for account transactions.
 */
export type SigningRole = 'sender' | 'sponsor';

/** Detached signatures grouped by signing role. */
export type RoleSeparatedSignatures = RoleSeparatedSignaturesDto;

/**
 * The normalized output of a signing operation.
 */
export interface SignedTransactionResult {
  /** The original transaction representation, preserved verbatim. */
  transaction: string;
  /** The role that produced the new signature. */
  roleSigned: SigningRole;
  /** The newly produced detached signature. */
  newSignature: AccountTransactionSignature;
  /** The merged detached signatures for both roles. */
  signatures: RoleSeparatedSignatures;
  /** Whether the merged signature set satisfies complete positive requirements for all roles present in the transaction. */
  isFullySigned: boolean;
  /** Whether builder-compatible signature requirement metadata was supplied. */
  signatureRequirementsKnown: boolean;
  /** Remaining required signature counts by role. */
  missingSignatures: {
    sender: number;
    sponsor: number;
  };
}

/** Builder-compatible signature requirement metadata. */
export type SignatureRequirements = SignatureRequirementsDto;
