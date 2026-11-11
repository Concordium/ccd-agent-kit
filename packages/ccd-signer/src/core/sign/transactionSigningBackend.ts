import type { AccountTransactionSignature } from '@concordium/web-sdk';
import type { SigningRole } from './model.js';

/**
 * A request to produce a Concordium account-transaction signature.
 */
export interface TransactionSigningRequest {
  /** The exact transaction digest bytes to sign. */
  digest: Uint8Array;
  /** Existing detached signatures for the requested signing role. */
  existingSignatures: AccountTransactionSignature;
  /** Exact credential/key pairs to sign, such as `0:0`. */
  keys?: string[];
  /** Maximum number of automatically selected keys to sign. Undefined when exact keys are requested. */
  maxSignatures?: number;
  /** Number of signatures still required for the requested role. */
  missingSignatures: number;
  /** The signing role. */
  role: SigningRole;
}

/**
 * A backend that produces an ed25519-based Concordium account-transaction
 * signature.
 *
 * Implementations read the private key from different sources (encrypted
 * file, wallet export, hardware device, etc.) and return the raw
 * signature in the account-transaction signature envelope format.
 */
export interface TransactionSigningBackend {
  /**
   * Produces an account-transaction signature for the given request.
   *
   * @param request - The signing request containing the role and digest bytes.
   * @returns The account-transaction signature envelope.
   */
  createSignature(request: TransactionSigningRequest): Promise<AccountTransactionSignature>;
}
