import type { BlockInfoDto } from '@ccd-agent-kit/mcp-utils';
import type { McpJsonObject, McpJsonValue } from '@ccd-agent-kit/mcp-utils';
import type { PublicKeyScheme } from '@ccd-agent-kit/sdk-utils';
import { TransactionKindString, type SmartContractTypeValues } from '@concordium/web-sdk';

export type U64String = string;
export type AccountAddressString = string;
export type BlockHashString = string;

export interface AccountKeysDTO {
  threshold: number;
  credentialCount: number;
  credentialIds: string[];
  credentials?: Record<
    string,
    {
      credentialId?: string;
      threshold?: number;
      keys: Record<string, { scheme: PublicKeyScheme; publicKey: string }>;
    }
  >;
}

export type AccountStakePendingChangeDTO =
  | { change: 'NoChange' }
  | { change: 'ReduceStake'; effectiveTime: string; newStake: U64String }
  | { change: 'RemoveStake'; effectiveTime: string };

export interface AccountStakeDTO {
  stakedAmount: U64String;
  pendingChange: AccountStakePendingChangeDTO;
}

export interface DisplayValueDTO extends McpJsonObject {
  value: U64String;
  decimals: number;
  display: string;
}

export interface AccountInfoDTO {
  address: AccountAddressString;
  'CCD Balance': DisplayValueDTO;
  sequenceNumber: U64String;
  index: U64String;
  accountType: 'Account' | 'Baker' | 'Delegator' | 'Unknown';
  keys: AccountKeysDTO;
  stake?: AccountStakeDTO;
  PLTs: TokenHoldingDTO[];
}

export interface AccountSummaryDTO {
  /** Canonical account address returned by the node. */
  address: AccountAddressString;
  /** Selected or preferred public account label, when known. */
  label?: string;
  /** Current account sequence number. */
  sequenceNumber: U64String;
  /** Canonical account index. */
  index: U64String;
  /** Current chain account role. */
  accountType: 'Account' | 'Validator' | 'Delegator' | 'Unknown';
}

export type AccountStakeResourcePendingChangeDTO =
  | { change: 'NoChange' }
  | { change: 'ReduceStake'; effectiveTime: string; newStake: DisplayValueDTO }
  | { change: 'RemoveStake'; effectiveTime: string };

export interface AccountStakeResourceDTO {
  address: AccountAddressString;
  label?: string;
  poolStatus: 'None' | 'Validator' | 'Delegator';
  stakedAmount: DisplayValueDTO;
  pendingChange: AccountStakeResourcePendingChangeDTO;
  validator?: {
    validatorId: U64String;
    restakeEarnings: boolean;
    isSuspended: boolean;
    pool?: {
      openStatus?: string | null;
      metadataUrl?: string;
      commissionRates?: {
        transactionCommission: number;
        bakingCommission: number;
        finalizationCommission: number;
      };
    };
  };
  delegation?: {
    restakeEarnings: boolean;
    target: { type: 'PassiveDelegation' } | { type: 'Validator'; validatorId: U64String };
  };
}

export interface CcdReleaseDTO {
  timestamp: string;
  amount: DisplayValueDTO;
  transactions: string[];
}

export interface CcdBalanceDTO {
  tokenId: 'CCD';
  decimals: 6;
  totalBalance: DisplayValueDTO;
  availableBalance: DisplayValueDTO;
  lockedBalance: DisplayValueDTO;
  releases: CcdReleaseDTO[];
}

export interface PltBalanceDTO {
  tokenId: string;
  decimals: number;
  totalBalance: DisplayValueDTO;
  availableBalance: DisplayValueDTO;
  lockedBalance: DisplayValueDTO;
  locks: TokenLockDTO[];
}

export type AccountBalanceDTO = CcdBalanceDTO | PltBalanceDTO;

export interface AccountBalancesDTO {
  address: AccountAddressString;
  label?: string;
  balances: Record<string, AccountBalanceDTO>;
}

export interface AccountBalanceResourceDTO {
  address: AccountAddressString;
  label?: string;
  balance: AccountBalanceDTO;
}

export interface NextSequenceNumberDTO {
  sequenceNumber: U64String;
  allFinal: boolean;
}

export type BlockInfoDTO = BlockInfoDto;

export interface BlockItemDTO {
  transactionHash: string;
  status: 'received' | 'committed' | 'finalized';
  blockHash: BlockHashString | null;
  blockItemKind?:
    'accountTransaction' | 'accountTransactionV1' | 'credentialDeployment' | 'updateInstruction' | 'rawBlockItem';
  blockItemHex?: string;
}

/** A JSON value emitted by a Concordium query DTO. */
export type JsonValue = McpJsonValue;

/** A JSON object emitted by a Concordium query DTO. */
export type JsonObject = McpJsonObject;

/** A normalized account endpoint in a CCD transfer. */
export interface TransactionAccountDTO extends JsonObject {
  type: 'account';
  address: AccountAddressString;
}

/** A normalized memo carried by a transfer. */
export interface TransactionMemoDTO extends JsonObject {
  hex: string;
  text?: string;
}

/** A normalized CCD transfer effect. */
export interface CcdTransferEffectDTO extends JsonObject {
  from: TransactionAccountDTO;
  to: TransactionAccountDTO;
  amount: { microCcdAmount: U64String; display: string };
  memo?: TransactionMemoDTO;
}

/** A normalized protocol-level token transfer event. */
export interface TokenTransferEffectDTO extends JsonObject {
  type: 'tokenTransfer';
  tokenId: string;
  from?: AccountAddressString;
  to?: AccountAddressString;
  amount: DisplayValueDTO;
  memo?: TransactionMemoDTO;
}

/** JSON-safe token-update events, with token transfers and lock events projected to stable public shapes. */
export type TokenEffectDTO = TokenTransferEffectDTO | JsonObject | null;

type ProjectedCcdTransferKind = TransactionKindString.Transfer | TransactionKindString.TransferWithMemo;
type OtherAccountTransactionKind = Exclude<
  TransactionKindString,
  ProjectedCcdTransferKind | TransactionKindString.TokenUpdate
>;

type AccountTransactionEffectCommonDTO<T extends TransactionKindString> = JsonObject & {
  transactionType: T;
  sender: AccountAddressString;
  sponsor?: { address: AccountAddressString; cost: U64String };
  cost: U64String;
  energyCost: U64String;
  hash: string;
  index: U64String;
};

/** A known account-transaction summary with required fields for projected transaction kinds. */
export type AccountTransactionEffectSummaryDTO =
  | (AccountTransactionEffectCommonDTO<ProjectedCcdTransferKind> & { ccdTransfer: CcdTransferEffectDTO })
  | (AccountTransactionEffectCommonDTO<TransactionKindString.TokenUpdate> & { tokenEvents: TokenEffectDTO[] })
  | AccountTransactionEffectCommonDTO<OtherAccountTransactionKind>;

/** A block-item effect mapped from a known SDK summary discriminant. */
export type TransactionEffectDTO =
  | {
      type: 'accountTransaction';
      summary: AccountTransactionEffectSummaryDTO;
    }
  | { type: 'accountCreation'; summary: JsonObject }
  | { type: 'updateTransaction'; summary: JsonObject }
  | { type: 'tokenCreation'; summary: JsonObject };

export interface BlockTransactionEventsDTO {
  hash: BlockHashString;
  height: U64String;
  events: TransactionEffectDTO[];
}

export interface TransactionEffectsDTO {
  transactionHash: string;
  status: 'received' | 'committed' | 'finalized';
  blockHash: BlockHashString | null;
  effects: TransactionEffectDTO[];
}

export interface ConsensusInfoDTO {
  bestBlockHash: BlockHashString;
  lastFinalizedBlockHash: BlockHashString;
  lastFinalizedBlockHeight: U64String;
  genesisTime: string;
  currentEraGenesisTime: string;
  /** Only present for protocol version 6+ consensus status. */
  epoch?: U64String;
  /** The genesis index, i.e. the era counter. */
  currentEra: number;
}

export interface ModuleSourceDTO {
  moduleRef: string;
  version: 0 | 1;
  source: Uint8Array;
}

export interface ModuleContractInterfaceDTO {
  name: string;
  entrypoints: string[];
}

export interface ModuleInterfaceDTO {
  moduleRef: string;
  version: 0 | 1;
  sourceSizeBytes: number;
  schemaAvailable: boolean;
  contracts: ModuleContractInterfaceDTO[];
}

export interface InstanceInfoDTO {
  index: U64String;
  subindex: U64String;
  moduleRef: string;
  owner: AccountAddressString;
  amount: U64String;
  name: string;
  methods: string[];
}

export interface InvokeResultDTO {
  tag: 'success' | 'failure';
  usedEnergy: U64String;
  returnValueHex?: string;
  returnValueJson?: SmartContractTypeValues;
  errorHex?: string;
  errorJson?: SmartContractTypeValues;
  reason?: string;
  eventCount: number;
}

export interface PoolInfoDTO {
  poolId: U64String;
  bakerAccount: AccountAddressString;
  stakedAmount: U64String;
  delegatedAmount: U64String;
  delegatedCapitalCap?: U64String;
  currentPaydayStaked: U64String;
  currentPaydayDelegated: U64String;
  poolType: 'BakerPool' | 'PassiveDelegation';
  poolInfo?: {
    openStatus?: string | null;
    metadataUrl?: string;
    commissionRates?: {
      transactionCommission: number;
      bakingCommission: number;
      finalizationCommission: number;
    };
  };
  isSuspended?: boolean;
}

export interface AccountPoolInfoDTO {
  address: AccountAddressString;
  poolStatus: 'None' | 'Baker' | 'Delegator';
  bakerPoolId?: U64String;
  stakedAmount: U64String;
}

export interface PassiveDelegationInfoDTO {
  totalStaked: U64String;
  currentPaydayStaked: U64String;
}

export interface TokenDTO {
  tokenId: string;
  symbol?: string;
  decimals: number;
  'total supply': DisplayValueDTO;
}

export interface TokenInfoDTO {
  tokenId: string;
  moduleRef: string;
  decimals: number;
  'total supply': DisplayValueDTO;
  name: string | undefined;
  metadataUrl: string | undefined;
  governanceAccount: string | undefined;
  allowList: boolean | undefined;
  denyList: boolean | undefined;
  mintable: boolean | undefined;
  burnable: boolean | undefined;
  paused: boolean | undefined;
}

export interface TokenListDTO {
  PLTs: TokenDTO[];
}

export interface TokenLockDTO {
  /** The base58check lock identifier controlling the locked amount. */
  lock: string;
  /** Amount in the token's smallest unit plus a human-friendly display. */
  amount: DisplayValueDTO;
}

export interface TokenHoldingDTO {
  tokenId: string;
  decimals: number;
  /** Total balance in the token's smallest unit plus a human-friendly display. */
  'total balance': DisplayValueDTO;
  /** Unencumbered balance in the token's smallest unit plus a human-friendly display. */
  'available balance': DisplayValueDTO;
  /** Locked balance in the token's smallest unit plus a human-friendly display. */
  'locked balance': DisplayValueDTO;
  /** Per-lock breakdown of the locked balance. */
  locks: TokenLockDTO[];
}

export interface TokenBalanceDTO extends TokenHoldingDTO {
  holder: string;
}

export interface AccountTokensDTO {
  address: AccountAddressString;
  PLTs: TokenHoldingDTO[];
}

/** A simple-v0 lock capability grant projected to public account and role strings. */
export interface LockGrantDTO {
  account: AccountAddressString;
  /** Lock operations authorized for the account. */
  capabilities: Array<'fund' | 'release' | 'send' | 'cancel'>;
}

export interface LockFundAmountDTO {
  tokenId: string;
  decimals: number;
  amount: DisplayValueDTO;
}

export interface LockFundDTO {
  account: AccountAddressString;
  balances: LockFundAmountDTO[];
}

/** Flattened public projection of an SDK simple-v0 lock configuration and its funds. */
export interface LockInfoDTO {
  lockId: string;
  creatorAccountIndex: U64String;
  creatorSequenceNumber: U64String;
  creationOrder: U64String;
  recipients: 'any' | AccountAddressString[];
  expiryUnixSeconds: U64String;
  expiryTime: string;
  grants: LockGrantDTO[];
  tokenIds: string[];
  keepAlive?: boolean;
  memoHex?: string;
  /** Raw lock metadata plus its JSON-safe decoded inspection view when projection succeeds. */
  metadata?: {
    /** Original CBOR metadata bytes as lowercase hex. */
    hex: string;
    /** Decoded metadata with byte strings and big integers normalized for JSON. */
    cbor?: JsonObject;
  };
  funds: LockFundDTO[];
}

export interface Cis2BalanceDTO {
  contractIndex: U64String;
  contractSubindex: U64String;
  tokenId: string;
  address: string;
  balance: U64String;
}
