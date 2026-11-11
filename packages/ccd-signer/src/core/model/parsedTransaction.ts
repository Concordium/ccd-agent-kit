import type {
  CredentialDeploymentBlockItemSummary,
  CredentialDeploymentProofsSummary,
  CredentialDeploymentValuesSummary,
  Ed25519PublicKeyHex,
} from '@ccd-agent-kit/sdk-utils';
import type {
  CborAccountAddress,
  Operation,
  TokenOperation,
} from '@concordium/web-sdk';

/**
 * Header fields normalized from parseable account transactions.
 */
export interface ParsedTransactionHeader {
  /** The sender account address in base58 form. */
  sender: string;
  /** The sender nonce. */
  nonce: bigint;
  /** The transaction expiry as epoch milliseconds. */
  expiry: number;
  /** The maximum energy budget authorized by the serialized account-transaction header. */
  energy: bigint;
  /** The sponsor account address in base58 form when present. */
  sponsor?: string;
  /** Local display label for the sender, when annotation found one. */
  senderAccountLabel?: string;
  /** Local display label for the sponsor, when annotation found one. */
  sponsorAccountLabel?: string;
}

/**
 * Signature counts derived from the parsed transaction.
 */
export interface ParsedTransactionSignatureState {
  /** The total number of sender signatures present across credentials and keys. */
  senderSignatureCount: number;
  /** The total number of sponsor signatures present across credentials and keys. */
  sponsorSignatureCount: number;
}

/**
 * A normalized transfer payload summary.
 */
export interface ParsedTransferPayloadSummary {
  /** The normalized payload summary discriminator. */
  kind: 'transfer';
  /** The transfer amount expressed in CCD micro-unit string form. */
  amount: string;
  /** The destination account address in base58 form. */
  toAddress: string;
  /** Local display label for the recipient, when annotation found one. */
  toAccountLabel?: string;
}

/**
 * A normalized byte-oriented value with optional decoded views.
 */
export interface ParsedBinaryValue {
  /** The original hex representation preserved from the parsed payload. */
  hex: string;
  /** Printable UTF-8 text derived from the bytes when available. */
  text?: string;
  /** Best-effort or protocol-defined CBOR-decoded value when available. */
  cbor?: ParsedJsonValue;
}

/** A JSON value validated at an opaque protocol-data boundary. */
export type ParsedJsonValue = string | number | boolean | null | ParsedJsonValue[] | { [key: string]: ParsedJsonValue };

/** A known operation retained in its native SDK form with operation-local participant labels. */
export interface ParsedKnownOperation {
  /** Internal discriminator; never included in terminal JSON or text. */
  kind: 'knownOperation';
  /** Native operation validated by the scoped or unscoped SDK decoder. */
  operation: TokenOperation | Operation;
  /** Local display labels keyed by the exact native account-address object visited during annotation. */
  participantLabels: Map<CborAccountAddress.Type, string>;
}

/** An unrecognized operation retained opaquely until terminal projection. */
export interface ParsedOpaqueOperation {
  /** Internal discriminator; never included in terminal JSON or text. */
  kind: 'opaqueOperation';
  /** Validated JSON representation of the unrecognized single-key operation. */
  operation: { [key: string]: ParsedJsonValue };
}

/** Typed operation retained by the signer inspection model. */
export type ParsedOperation = ParsedKnownOperation | ParsedOpaqueOperation;

/**
 * A normalized transfer-with-memo payload summary.
 */
export interface ParsedTransferWithMemoPayloadSummary {
  /** The normalized payload summary discriminator. */
  kind: 'transferWithMemo';
  /** The transfer amount expressed in CCD micro-unit string form. */
  amount: string;
  /** The destination account address in base58 form. */
  toAddress: string;
  /** Local display label for the recipient, when annotation found one. */
  toAccountLabel?: string;
  /** The memo bytes with optional decoded views. */
  memo: ParsedBinaryValue;
}

/**
 * A normalized register-data payload summary.
 */
export interface ParsedRegisterDataPayloadSummary {
  /** The normalized payload summary discriminator. */
  kind: 'registerData';
  /** The registered data bytes with optional decoded views. */
  data: ParsedBinaryValue;
}

/**
 * A normalized deploy-module payload summary.
 */
export interface ParsedDeployModulePayloadSummary {
  /** The normalized payload summary discriminator. */
  kind: 'deployModule';
  /** The serialized module source as a hex string. */
  source: string;
}

/**
 * A normalized init-contract payload summary.
 */
export interface ParsedInitContractPayloadSummary {
  /** The normalized payload summary discriminator. */
  kind: 'initContract';
  /** The contract init amount. */
  amount: string;
  /** The init function name. */
  initName: string;
  /** The module reference. */
  moduleRef: string;
  /** The serialized parameter bytes as a hex string. */
  param: string;
}

/**
 * A normalized update-contract payload summary.
 */
export interface ParsedUpdateContractPayloadSummary {
  /** The normalized payload summary discriminator. */
  kind: 'updateContract';
  /** The contract update amount. */
  amount: string;
  /** The target contract address. */
  address: {
    /** The contract index. */
    index: number;
    /** The contract subindex. */
    subindex: number;
  };
  /** The receive name. */
  receiveName: string;
  /** The serialized message bytes as a hex string. */
  message: string;
}

/**
 * A normalized configure-delegation payload summary.
 */
export interface ParsedConfigureDelegationPayloadSummary {
  /** The normalized payload summary discriminator. */
  kind: 'configureDelegation';
  /** The configured stake, when present. */
  stake?: string;
  /** Whether earnings are restaked, when present. */
  restakeEarnings?: boolean;
  /** The delegation target, when present. */
  delegationTarget?: {
    /** The delegation target type. */
    delegateType: string;
    /** The baker identifier for baker delegation, when present. */
    bakerId?: number;
  };
}

/**
 * A normalized configure-validator payload summary.
 */
export interface ParsedConfigureValidatorPayloadSummary {
  /** The normalized payload summary discriminator. */
  kind: 'configureValidator';
  /** The configured stake, when present. */
  stake?: string;
  /** Whether earnings are restaked, when present. */
  restakeEarnings?: boolean;
  /** The pool openness value, when present. */
  openForDelegation?: number;
  /** The metadata URL, when present. */
  metadataUrl?: string;
  /** The transaction fee commission, when present. */
  transactionFeeCommission?: number;
  /** The baking reward commission, when present. */
  bakingRewardCommission?: number;
  /** The finalization reward commission, when present. */
  finalizationRewardCommission?: number;
}

/**
 * A normalized update-credentials payload summary.
 */
export interface ParsedUpdateCredentialsPayloadSummary {
  /** The normalized payload summary discriminator. */
  kind: 'updateCredentials';
  /** The credential threshold after the update. */
  threshold: number;
  /** The number of new credentials included in the update. */
  newCredentialCount: number;
  /** The credential identifiers to remove. */
  removeCredentialIds: string[];
}

/**
 * A normalized token-update payload summary.
 */
export interface ParsedScopedTokenUpdatePayloadSummary {
  /** The normalized payload summary discriminator. */
  kind: 'tokenUpdate';
  /** Indicates that every operation applies to the payload-level token identifier. */
  variant: 'scoped';
  /** The token identifier. */
  tokenId: string;
  /** The decoded token-update operations. */
  operations: ParsedOperation[];
}

/**
 * A normalized unscoped token-update payload summary.
 */
export interface ParsedUnscopedTokenUpdatePayloadSummary {
  /** The normalized payload summary discriminator. */
  kind: 'tokenUpdate';
  /** Indicates that token operations carry their own token identifiers. */
  variant: 'unscoped';
  /** The decoded unscoped token-update operations. */
  operations: ParsedOperation[];
}

/** A normalized scoped or unscoped token-update payload summary. */
export type ParsedTokenUpdatePayloadSummary =
  | ParsedScopedTokenUpdatePayloadSummary
  | ParsedUnscopedTokenUpdatePayloadSummary;

/**
 * A generic payload summary fallback for payload kinds without dedicated formatting.
 */
export interface ParsedGenericPayloadSummary {
  /** The normalized payload summary discriminator. */
  kind: 'generic';
  /** The SDK JSON payload type discriminator. */
  type: string;
}

/**
 * The normalized payload summary surface used by renderers.
 */
export type ParsedPayloadSummary =
  | ParsedTransferPayloadSummary
  | ParsedTransferWithMemoPayloadSummary
  | ParsedRegisterDataPayloadSummary
  | ParsedDeployModulePayloadSummary
  | ParsedInitContractPayloadSummary
  | ParsedUpdateContractPayloadSummary
  | ParsedConfigureDelegationPayloadSummary
  | ParsedConfigureValidatorPayloadSummary
  | ParsedUpdateCredentialsPayloadSummary
  | ParsedTokenUpdatePayloadSummary
  | ParsedGenericPayloadSummary;

/**
 * A normalized account transaction inspection result.
 */
export interface ParsedAccountTransaction {
  /** The normalized transaction family. */
  kind: 'accountTransaction';
  /** The Concordium account transaction version. */
  version: 0 | 1;
  /** The payload type rendered as the SDK JSON discriminator. */
  payloadType: string;
  /** The normalized payload summary used by renderers. */
  payloadSummary: ParsedPayloadSummary;
  /** The normalized transaction header. */
  header: ParsedTransactionHeader;
  /** The normalized transaction signature state. */
  signatureState: ParsedTransactionSignatureState;
}

/**
 * A normalized credential deployment inspection result.
 */
export interface ParsedCredentialDeploymentTransaction {
  /** The normalized transaction family. */
  kind: 'credentialDeployment';
  /** The transaction expiry as epoch milliseconds. */
  expiry: number;
  /** The transaction expiry as an ISO-8601 UTC timestamp. */
  expiryDate?: string;
  /** Stable credential-value fields decoded for review when available. */
  credential?: CredentialDeploymentBlockItemSummary['credential'];
  /** Opaque ownership proof metadata decoded for review when available. */
  proofs?: CredentialDeploymentBlockItemSummary['proofs'];
}

/** A credential deployment signing target parsed from signer handoff hex. */
export type ParsedCredentialDeploymentSigningTarget =
  | {
      /** Target discriminator for account-opening credentials. */
      type: 'new_account';
      /** Account-opening message expiry as epoch seconds. */
      messageExpiry: string;
      /** Account-opening message expiry as an ISO-8601 UTC timestamp. */
      messageExpiryDate?: string;
    }
  | {
      /** Target discriminator for credentials added to an existing account. */
      type: 'existing_account';
      /** Existing account address that the credential is being signed for. */
      accountAddress: string;
    };

/** Credential public keys parsed from a credential deployment signing handoff. */
export interface ParsedCredentialDeploymentPublicKeys {
  /** Credential signature threshold. */
  threshold: number;
  /** Validated canonical Ed25519 public keys keyed by credential key index. */
  keys: Record<string, Ed25519PublicKeyHex>;
}

/** A normalized credential deployment signing handoff inspection result. */
export interface ParsedCredentialDeploymentSigningTransaction {
  /** The normalized transaction family. */
  kind: 'credentialDeploymentSigning';
  /** Parsed credential signing target context. */
  target: ParsedCredentialDeploymentSigningTarget;
  /** Credential public keys parsed from the unsigned credential deployment prefix. */
  credentialPublicKeys: ParsedCredentialDeploymentPublicKeys;
  /** Stable credential-value fields decoded by the shared credential handoff decoder. */
  credential: CredentialDeploymentValuesSummary;
  /** Opaque ownership proof metadata decoded by the shared credential handoff decoder. */
  proofs: CredentialDeploymentProofsSummary;
  /** Hex-encoded unsigned credential deployment bytes. */
  unsignedCredentialDeploymentHex: string;
  /** Hex-encoded target context bytes prepended in the signer handoff. */
  targetContextHex: string;
}

/**
 * The normalized output of the parsing layer.
 */
export type ParsedTransaction =
  ParsedAccountTransaction | ParsedCredentialDeploymentTransaction | ParsedCredentialDeploymentSigningTransaction;
