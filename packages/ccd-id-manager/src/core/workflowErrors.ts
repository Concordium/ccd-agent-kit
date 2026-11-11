/** Stable public workflow failure categories; native, HTTP and SDK diagnostics are never retained. */
export type IdentityWorkflowErrorCode = 'INVALID_INPUT' | 'CONTEXT_MISMATCH' | 'IDENTITY_MISMATCH'
  | 'IDENTITY_NOT_READY' | 'CREDENTIAL_LIMIT' | 'PROVIDER_FAILED' | 'IDENTITY_NOT_FOUND'
  | 'IDENTITY_ALREADY_EXISTS' | 'IDENTITY_FILE_MISSING' | 'CREDENTIAL_NUMBER_USED'
  | 'ACCOUNT_OPENING_PENDING' | 'NETWORK_FAILED' | 'STORAGE_FAILED' | 'CRYPTO_FAILED' | 'AUTHORIZATION_REQUIRED'
  | 'DISCOVERY_INCOMPLETE' | 'INDEX_UNAVAILABLE' | 'SOURCE_NOT_ASSOCIATED' | 'ASSOCIATION_MISMATCH'
  | 'LABEL_IN_USE' | 'LABEL_PROTECTED' | 'LABEL_REQUIRED';

const messages: Record<IdentityWorkflowErrorCode, string> = {
  INVALID_INPUT: 'Invalid identity workflow input.',
  CONTEXT_MISMATCH: 'Identity network or issuer context does not match the pinned selection.',
  IDENTITY_MISMATCH: 'The returned identity does not match the requested identity.',
  IDENTITY_NOT_READY: 'The identity is not ready for account opening.',
  CREDENTIAL_LIMIT: 'Credential number exceeds this identity\'s allowance.',
  PROVIDER_FAILED: 'Identity provider operation failed. No automatic retry was attempted.',
  IDENTITY_NOT_FOUND: 'The identity was not found; recovery did not initiate issuance.',
  IDENTITY_ALREADY_EXISTS: 'The deterministic identity already exists.',
  IDENTITY_FILE_MISSING: 'The encrypted identity file is missing.',
  CREDENTIAL_NUMBER_USED: 'The credential number is already allocated.',
  ACCOUNT_OPENING_PENDING: 'An account opening is already pending for this identity.',
  NETWORK_FAILED: 'Finalized network observation failed.',
  STORAGE_FAILED: 'Identity state could not be read or persisted.',
  CRYPTO_FAILED: 'Identity cryptographic operation failed.',
  AUTHORIZATION_REQUIRED: 'Identity authorization is required. Use the local CLI with a ready device.',
  DISCOVERY_INCOMPLETE: 'Discovery did not prove that the selected index is unused.',
  INDEX_UNAVAILABLE: 'The selected identity index is unavailable.',
  SOURCE_NOT_ASSOCIATED: 'The identity is not associated with an enrolled source.',
  ASSOCIATION_MISMATCH: 'The selected source does not match the historical identity.',
  LABEL_IN_USE: 'The identity label is already used on this network.',
  LABEL_PROTECTED: 'The identity has an operator-protected label. Use the local CLI to change it.',
  LABEL_REQUIRED: 'An identity label is required for this operation.',
};

/** Sanitized public failure with a stable code and no untrusted cause or sensitive details. */
export class IdentityWorkflowError extends Error {
  /** Construct an error containing only a known public classification. */
  constructor(public readonly code: IdentityWorkflowErrorCode) {
    super(messages[code]);
    this.name = 'IdentityWorkflowError';
  }
}

/** Reconstruct known workflow failures or replace untrusted failures with the caller's fixed classification. */
export function workflowFailure(error: unknown, fallback: IdentityWorkflowErrorCode): IdentityWorkflowError {
  return new IdentityWorkflowError(error instanceof IdentityWorkflowError ? error.code : fallback);
}
