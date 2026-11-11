/** Stable, sanitized identity-provider domain error codes. */
export type IdentityProviderErrorCode =
  | 'INVALID_NETWORK'
  | 'INVALID_SELECTOR'
  | 'INVALID_CONFIGURATION'
  | 'INVALID_LABEL'
  | 'DUPLICATE_LABEL'
  | 'PROVIDER_NOT_FOUND'
  | 'PROVIDER_NOT_CONFIGURED'
  | 'ISSUANCE_NOT_CONFIGURED'
  | 'RECOVERY_NOT_CONFIGURED'
  | 'PROVIDER_DISABLED'
  | 'STORAGE_FAILED'
  | 'NODE_FAILED'
  | 'CONTEXT_MISMATCH';

const MESSAGES: Record<IdentityProviderErrorCode, string> = {
  INVALID_NETWORK: 'The selected network is invalid.',
  INVALID_SELECTOR: 'The identity-provider selector is invalid.',
  INVALID_CONFIGURATION: 'The identity-provider configuration is invalid.',
  INVALID_LABEL: 'The identity-provider label is invalid.',
  DUPLICATE_LABEL: 'The identity-provider label is already in use.',
  PROVIDER_NOT_FOUND: 'The identity provider was not found.',
  PROVIDER_NOT_CONFIGURED: 'configure both --issuance and --recovery before using this identity provider.',
  ISSUANCE_NOT_CONFIGURED: 'configure --issuance before using this identity provider.',
  RECOVERY_NOT_CONFIGURED: 'configure --recovery before using this identity provider.',
  PROVIDER_DISABLED: 'The identity provider is disabled.',
  STORAGE_FAILED: 'Identity-provider storage failed.',
  NODE_FAILED: 'The finalized identity-provider context could not be loaded.',
  CONTEXT_MISMATCH: 'Identity-provider context validation failed.',
};

/** A provider-domain failure that deliberately retains no diagnostic cause. */
export class IdentityProviderError extends Error {
  readonly code: IdentityProviderErrorCode;

  constructor(code: IdentityProviderErrorCode) {
    super(MESSAGES[code]);
    this.name = 'IdentityProviderError';
    this.code = code;
  }
}
