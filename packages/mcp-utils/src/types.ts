import type { AccountTransactionSignature, CredentialSignature } from '@concordium/web-sdk';

/** JSON value that can be carried in MCP structured content and JSON text. */
export type McpJsonValue = null | boolean | number | string | McpJsonValue[] | { [key: string]: McpJsonValue };

/** JSON object that can be carried in MCP structured content and JSON text. */
export type McpJsonObject = { [key: string]: McpJsonValue };

/** Shared account identity metadata for account-label-aware MCP surfaces. */
export interface AccountIdentityDto {
  /** Account address in base58check form. */
  address: string;
  /** Optional canonical local account label. */
  accountLabel?: string;
}

/** A JSON-safe transaction metadata DTO. */
export interface TransactionMetadataDto {
  /** The sender account address. */
  sender: string;
  /** Optional sponsor account address. */
  sponsor?: string;
  /** The sender account sequence number as a decimal string. */
  sequenceNumber: string;
  /** Unix timestamp in seconds at which the transaction expires. */
  expiry: number;
  /** The NRG energy budget as a decimal string. */
  energy: string;
  /** Optional sender signature count as a decimal string. */
  senderNumSignatures?: string;
  /** Optional sponsor signature count as a decimal string. */
  sponsorNumSignatures?: string;
  /** Optional total signature count as a decimal string. */
  totalSignatureCount?: string;
  /** Optional estimated cost in micro CCD as a decimal string. */
  estimatedCostMicroCcd?: string;
}

/** JSON-safe signature-count requirements for account transaction signing/finalization. */
export interface SignatureRequirementsDto {
  /** Optional sender signature count as a non-negative safe-integer decimal string. */
  senderNumSignatures?: string;
  /** Optional sponsor signature count as a non-negative safe-integer decimal string. */
  sponsorNumSignatures?: string;
  /** Optional total signature count as a non-negative safe-integer decimal string. */
  totalSignatureCount?: string;
}

/** A JSON-safe build transaction result DTO. */
export interface BuildTransactionResultDto {
  /** High-level transaction type for external consumers. */
  transactionType: string;
  /** JSON-shaped transaction payload (human readable). */
  payload: McpJsonValue;
  /** Full unsigned transaction hex for signer handoff. */
  transactionHex: string;
  /** Transaction metadata with JSON-safe numeric values. */
  metadata: TransactionMetadataDto;
}

/** A JSON-safe finalize transaction result DTO. */
export type FinalizeTransactionResultDto = FinalizeAccountTransactionResultDto | FinalizeCredentialDeploymentResultDto;

/** A JSON-safe finalized account transaction result DTO. */
export interface FinalizeAccountTransactionResultDto {
  /** The transaction version ('v0' or 'v1'). */
  transactionVersion: 'v0' | 'v1';
  /** The signed block item hex. */
  blockItemHex: string;
  /** The merged detached signatures. */
  signatures: {
    /** Sender signatures keyed by credential/key index. */
    sender: AccountTransactionSignature;
    /** Sponsor signatures keyed by credential/key index. */
    sponsor: AccountTransactionSignature;
  };
}

/** A JSON-safe finalized credential deployment result DTO. */
export interface FinalizeCredentialDeploymentResultDto {
  /** Block item kind discriminator. */
  blockItemKind: 'credentialDeployment';
  /** Account-opening message expiry as a decimal string. */
  messageExpiry: string;
  /** The signed block item hex. */
  blockItemHex: string;
  /** Flat credential signatures keyed by credential key index. */
  signatures: CredentialSignature;
}

/** A JSON-safe verify transaction signature result DTO. */
export interface VerifyTransactionSignatureResultDto {
  /** Whether the signature is valid. */
  valid: boolean;
  /** The transaction version. */
  transactionVersion: 'v0' | 'v1';
  /** The network name. */
  network: string;
  /** Sender signature verification result. */
  sender: { address: string; valid: boolean };
  /** Optional sponsor signature verification result. */
  sponsor?: { address: string; valid: boolean };
}

/** Normalized role-separated detached signatures with both roles present. */
export interface RoleSeparatedSignaturesDto {
  /** Sender signatures keyed by credential/key index. */
  sender: AccountTransactionSignature;
  /** Sponsor signatures keyed by credential/key index. */
  sponsor: AccountTransactionSignature;
}

/** A JSON-safe account summary DTO for resource responses. */
export interface AccountSummaryDto extends AccountIdentityDto {
  /** The account sequence number as a decimal string. */
  sequenceNumber: string;
  /** The account index as a decimal string. */
  index: string;
  /** Public account type label. */
  accountType: 'Account' | 'Validator' | 'Delegator' | 'Unknown';
}

/** Configured network entry exposed by network catalogue MCP resources. */
export interface NetworkCatalogueEntryDto {
  /** User-facing configured network name. */
  name: string;
  /** CAIP-2 chain identifier for the network. */
  caip2: string;
}

/** Signer network catalogue resource payload. */
export interface NetworksResourceDto<DefaultNetworkSource extends string = string> {
  [key: string]: unknown;
  /** Active default network name. */
  defaultNetwork: string;
  /** Whether the default came from configuration or the session environment. */
  defaultNetworkSource: DefaultNetworkSource;
  /** Available configured networks with CAIP-2 identifiers. */
  networks: NetworkCatalogueEntryDto[];
}

/** A JSON-safe block info DTO for resource responses. */
export interface BlockInfoDto {
  /** The block hash. */
  hash: string;
  /** The block height as a decimal string. */
  height: string;
  /** The slot time as an ISO timestamp. */
  slotTime: string;
  /** The genesis/era index. */
  era: number;
  /** The transaction count as a decimal string. */
  transactionsCount: string;
  /** Whether the block is finalized. */
  finalized: boolean;
}

/** A JSON-safe display amount with raw smallest-unit value and scaled text. */
export interface DisplayValueDto {
  /** Raw smallest-unit value represented as a decimal string. */
  value: string;
  /** Number of decimal places used by the value. */
  decimals: number;
  /** Human-readable value scaled by `decimals`. */
  display: string;
}

/** Catalogue entry for a protocol-level token. */
export interface PLTCatalogueItemDto {
  /** The token identifier. */
  tokenId: string;
  /** The token decimals. */
  decimals: number;
  /** Total token supply. */
  totalSupply: DisplayValueDto;
}

/** Protocol-level token catalogue returned by list resources and tools. */
export interface PLTCatalogueDto {
  /** Known protocol-level tokens on the selected network. */
  PLTs: PLTCatalogueItemDto[];
}

/** Full protocol-level token details for a single token. */
export interface PLTInfoDto extends PLTCatalogueItemDto {
  /** Module reference implementing the token. */
  moduleRef: string;
  /** Optional token display name. */
  name?: string;
  /** Optional token metadata URL. */
  metadataUrl?: string;
  /** Optional token governance account. */
  governanceAccount?: string;
  /** Whether the token uses an allow list. */
  allowList?: boolean;
  /** Whether the token uses a deny list. */
  denyList?: boolean;
  /** Whether the token is mintable. */
  mintable?: boolean;
  /** Whether the token is burnable. */
  burnable?: boolean;
  /** Whether the token is paused. */
  paused?: boolean;
}
