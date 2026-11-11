import type {
  CryptographicParameters, IdentityObjectV1, IdObjectRequestV1,
  IdRecoveryRequest, IdentityProvider, Network, Versioned,
} from '@concordium/web-sdk';
import type { AccountCredentialObservation, AccountCredentialSourceBlock } from '@ccd-agent-kit/config-utils';
import type { CatalogLabelMode } from '@ccd-agent-kit/config-utils';
import type { IdentitySourceService } from './sources/types.js';
import type { IdentityWorkflowErrorCode } from './workflowErrors.js';

/** Explicit identity selection. Every value is authenticated or pinned before use. */
export interface IdentitySelection {
  network: string;
  sdkNetwork: Network;
  /** Historical inert locator; new records omit it. */
  device?: string;
  rootPublicKey: string;
  identityProviderIndex: number;
  identityIndex: number;
  /** Historical inert metadata retained only when reading old records. */
  walletProxyUrl?: string;
}

/** Public input for identity issuance; source trust replaces raw root selectors. */
export interface IdentityRequestInput {
  network?: string;
  source?: string;
  identityProviderIndex: number;
  identityIndex?: number;
  /** Optional bare initial label for a newly created local identity record. */
  label?: string;
  /** Initial protection mode; omission defaults an explicit label to hard. */
  mode?: CatalogLabelMode;
}

/** Select an identity and assign a label; authority is fixed by the workflow method, never by MCP input. */
export interface IdentityLabelInput {
  network?: string;
  identityId: string;
  /** Explicit mutation; omission retains the historical operator set behavior. */
  operation?: 'set' | 'remove';
  /** New bare label; omission preserves existing spelling during an operator mode conversion. */
  label?: string;
  /** Operator-selected protection mode; unavailable through the agent method. */
  mode?: CatalogLabelMode;
}

/** Public input for deterministic identity recovery. */
export interface IdentityRecoveryInput { network?: string; source?: string; identityProviderIndex: number; identityIndex: number }

/** Public identity discovery input. */
export interface DiscoverIdentitiesInput { network?: string; source?: string; identityProviderIndex?: number; gapLimit?: number; startIndex?: number; endIndex?: number }

/** Public account-credential discovery input. */
export interface DiscoverAccountCredentialsInput { network?: string; identityId: string; gapLimit?: number; startCredentialNumber?: number; endCredentialNumber?: number; full?: boolean }

/** CLI-only historical source-association input. */
export interface AssociateIdentitySourceInput { network?: string; identityId: string; source?: string }

/** Node-context selector after shared network resolution and before SDK namespace verification. */
export type IdentityContextSelection = Omit<IdentitySelection, 'sdkNetwork'>;

/** Node-verified public issuer context and full derivation network binding. */
export interface IdentityContext extends IdentityProvider {
  network: string;
  genesisHash: string;
  sdkNetwork: Network;
  globalContext: CryptographicParameters;
  issuanceUrl: string;
  recoveryUrl: string;
  /** Private POST transport configuration; omitted for the legacy GET flow. */
  issuance?: { method: 'POST' };
  /** Raw configured AR preferences for new issuance only. */
  anonymityRevocation?: {
    anonymityRevokers?: number[];
    anonymityRevokerThreshold?: number;
  };
}

/** Validated POST issuance session with separate human and tool endpoints. */
export interface IdentityIssuanceContext {
  /** Human-verification URL returned by the provider; never fetched by the tool. */
  url: string;
  /** Tool polling endpoint on the configured IDP origin, derived from the returned context ID. */
  statusUrl: string;
}

/** Durable state for a POST issuance attempt that must never be resubmitted automatically. */
export type PostIssuanceState =
  | { status: 'unconfirmed' }
  | {
    status: 'created';
    url: string;
    /** Absent only for historical attempts completed through recovery. */
    statusUrl?: string | undefined;
  }
  | {
    status: 'created';
    url: string;
    /** Tool polling endpoint on the configured IDP origin. */
    statusUrl?: string | undefined;
    /** Historical inert provider context; never used as fetch authority. */
    ctxId: string;
    /** Historical inert SDK network label. */
    network: 'Mainnet' | 'Testnet';
    /** Historical inert provider expiry. */
    expiresAt: string;
  };

/** Provider failure explicitly authenticated to one durable request attempt. */
export interface ConfirmedIdentityFailure {
  kind: 'authenticated_key_failure';
  requestAttemptId: string;
}

/** Durable protected metadata shared by issuance-lifecycle and issued identities. */
export interface StoredIdentityBase {
  version: 1;
  id: string;
  /** Stable source association, required on new records. */
  sourceId?: string;
  /** Stored label; a leading @ marks an agent-modifiable label, otherwise it is operator-protected. */
  label?: string;
  selection: IdentitySelection;
  contextHash: string;
  idCredPub: IdObjectRequestV1['idCredPub'];
}

/** Protected metadata retained only while an identity issuance is not complete. */
export interface StoredIdentityLifecycle extends StoredIdentityBase {
  status: 'awaiting_verification' | 'pending' | 'error' | 'expired';
  request?: Versioned<IdObjectRequestV1>;
  retrievalUrl?: string;
  /** Operational request-attempt identity; excluded from cryptographic selection and context pins. */
  requestAttemptId?: string;
  /** Explicit provider failure authenticated to the current request attempt. */
  confirmedFailure?: ConfirmedIdentityFailure;
  /** Persisted human-verification URL for a GET issuance attempt; never fetched as authority. */
  authorizationUrl?: string;
  /** Private POST issuance lifecycle state. */
  postIssuance?: PostIssuanceState;
  identity?: never;
}

/** Durable issued metadata. Issuance-lifecycle fields are forbidden after completion. */
export interface StoredIssuedIdentity extends StoredIdentityBase {
  status: 'ready';
  request?: never;
  retrievalUrl?: never;
  requestAttemptId?: never;
  confirmedFailure?: never;
  authorizationUrl?: never;
  postIssuance?: never;
  /** In-memory stores may attach the decrypted object; production registries never do. */
  identity?: Versioned<IdentityObjectV1>;
}

/** Protected registry metadata. The SDK identity object is stored only as ciphertext. */
export type StoredIdentity = StoredIdentityLifecycle | StoredIssuedIdentity;

/** Workflow metadata stored in the protected identity index. */
export type StoredIdentityWorkflow =
  | Pick<StoredIdentityLifecycle, 'status' | 'contextHash' | 'idCredPub' | 'request' | 'retrievalUrl'
    | 'requestAttemptId' | 'confirmedFailure' | 'authorizationUrl' | 'postIssuance'>
  | Pick<StoredIssuedIdentity, 'status' | 'contextHash' | 'idCredPub'>;

/** Immutable network metadata stored by the identity manager. */
export interface IdentityNetworkMetadata {
  caip2: string;
  genesisHash: string;
  sdkNetwork: Network;
}

/** One network identity registry. */
export interface IdentityIndex {
  version: 1;
  network: IdentityNetworkMetadata;
  identities: Record<string, IdentityIndexRecord>;
}

/** One identity's public registry entry. */
export interface IdentityIndexRecord {
  file: string;
  recipeVersion: 1;
  /** Stable source association, required on new records. */
  sourceId?: string;
  /** Optional local selector, outside cryptographic selection, workflow attempts, and ciphertext. */
  label?: string;
  selection: Omit<IdentitySelection, 'network' | 'sdkNetwork'> & { rootPublicKeyFingerprint: string };
  workflow: StoredIdentityWorkflow;
}

/** Durable account-opening allocation entry. */
export type CredentialRegistryEntry = {
  identityId: string;
  credentialNumber: number;
  status: 'confirmed';
} | {
  identityId: string;
  credentialNumber: number;
  status: 'pending';
  expectedAccountAddress: string;
  expirySeconds: number;
};

/** Versioned account-opening allocation registry. */
export interface CredentialRegistry { version: 1; credentials: Record<string, CredentialRegistryEntry> }

/** Agent-safe identity summary. */
export type PublicIdentityStatus = 'pending' | 'issued' | 'failed' | 'unknown';

/** Agent-safe projection of one persisted identity workflow. */
export interface IdentitySummary {
  identityId: string;
  network: string;
  identityProviderIndex: number;
  identityIndex: number;
  status: PublicIdentityStatus;
  sourceId?: string;
  /** Bare public label; persistence-only protection markers are never projected. */
  label?: string;
  authorizationUrl?: string;
}

/** Issuance either starts verification or recovers an identity that already exists. */
export type IdentityRequestResult =
  | IdentitySummary & { outcome: 'requested'; status: 'pending' }
  | IdentitySummary & { outcome: 'identity_already_exists'; status: 'issued' };

/** Read-only durable input used to schedule one attempt-bound monitor check. */
export interface IdentityMonitorCandidate {
  record: StoredIdentity;
  reservedAt: number;
}

/** Network-scoped encrypted identity and registry persistence boundary. */
export interface IdentityStore {
  create(record: StoredIdentity): Promise<void>;
  load(network: string, id: string): Promise<StoredIdentity>;
  /** Save workflow metadata only when the persisted workflow equals the caller's observed snapshot. */
  save(record: StoredIdentity, expectedWorkflow: IdentityIndexRecord['workflow']): Promise<void>;
  /** Atomically save an error workflow and permanently fail its matching identity-index reservation. */
  save(record: StoredIdentity & { status: 'error' }, expectedWorkflow: IdentityIndexRecord['workflow'], reservationState: 'failed'): Promise<void>;
  list(network: string): Promise<StoredIdentity[]>;
  /** Atomically rename one canonical identity, enforcing per-network uniqueness and agent protection. */
  setIdentityLabel(input: { network: string; identityId: string; authority: 'operator' | 'agent' } & (
    { operation?: 'set'; label: string } | { operation: 'remove' }
  )): Promise<StoredIdentity>;
  bootstrapNetwork(network: IdentityNetworkMetadata): Promise<void>;
  /** Create encrypted identity state only when the index remains absent or equals the observed workflow snapshot. */
  createIdentity(network: IdentityNetworkMetadata, id: string, record: IdentityIndexRecord, identity: Versioned<IdentityObjectV1>, key: Uint8Array, expectedWorkflow: IdentityIndexRecord['workflow'] | null): Promise<void>;
  /** Restore missing ciphertext only when the index still equals the observed workflow snapshot. */
  restoreIdentity(network: IdentityNetworkMetadata, id: string, record: IdentityIndexRecord, identity: Versioned<IdentityObjectV1>, key: Uint8Array, expectedWorkflow: IdentityIndexRecord['workflow']): Promise<void>;
  loadIdentity(network: string, id: string, key: Uint8Array): Promise<Versioned<IdentityObjectV1>>;
  readIndex(network: string): Promise<IdentityIndex>;
  withMutation<T>(network: string, operation: () => Promise<T>): Promise<T>;
  loadCredentials(network: string): Promise<CredentialRegistry>;
  saveCredentials(network: string, registry: CredentialRegistry): Promise<void>;
  /** List indexes currently occupied by reservations or protected identity records. */
  listIdentityReservations(scope: IdentityReservationScope): Promise<number[]>;
  /** List timeout-eligible rows, initializing scoped legacy rows and non-ready historical records on first reconciliation. */
  listExpiredIdentityReservations(scope: IdentityReservationScope, now: number, timeoutMs: number): Promise<Array<{ identityIndex: number; reservedAt: number }>>;
  /** Strictly scan stored configured-network metadata for monitorable attempts without mutating or initializing state. */
  listIdentityMonitorCandidates(now: number): Promise<IdentityMonitorCandidate[]>;
  /** Read one fully scoped reservation row without creating or changing reservation state. */
  readIdentityRequestReservation(input: IdentityIndexReservation): Promise<{
    state: 'reserved' | 'used' | 'failed' | 'released';
    reservedAt: number;
  } | undefined>;
  /** Atomically create or promote one reservation after rechecking current occupancy. */
  reserveIdentityIndex(input: IdentityReservationCommand): Promise<void>;
  /** Compare-and-swap one reserved row to its reconciled terminal state. */
  resolveIdentityReservation(input: IdentityIndexReservation & (
    | { reservedAt: number; state: 'released'; expectedWorkflow: IdentityIndexRecord['workflow'] | null }
    | { reservedAt: number; state: 'failed'; expectedWorkflow?: never }
  )): Promise<void>;
}

/** Network-scoped allocation; SDK-derived identity material may be reused on other networks. */
export interface IdentityReservationScope { genesisHash: string; sourceId: string; sdkNetwork: Network; identityProviderIndex: number }

/** One identity index occupied only on its specified full-genesis network. */
export interface IdentityIndexReservation extends IdentityReservationScope { identityIndex: number }

/** Atomic identity-index reservation mutation with mode-specific concurrency input. */
export type IdentityReservationCommand = IdentityIndexReservation & (
  { mode: 'next'; expectedHighWater: number }
  | { mode: 'explicit' | 'used' | 'failed'; expectedHighWater?: never }
);

/** Complete encrypted-store contract. */
export type EncryptedIdentityStore = IdentityStore;

/** One bounded IDP retrieval result. */
export type IdentityRetrieval =
  | { status: 'pending' }
  | { status: 'error';
    /** Permanent failure requires provider-specific semantics authenticated to this key; free-text failures are unconfirmed. */
    failure?: 'key_failed' | 'unconfirmed' }
  | { status: 'done'; identity: Versioned<IdentityObjectV1> };

/** Public identity-provider transport boundary. */
export interface IdentityProviderClient {
  /** Create one issuance context with the canonical CAIP-2 network, without retrying or mutating the SDK request. */
  createIssuanceContext(
    url: string,
    request: Versioned<IdObjectRequestV1>,
    network: string,
  ): Promise<IdentityIssuanceContext>;
  /** Poll one already-derived context retrieval URL exactly once. */
  pollIssuanceContext(url: string): Promise<IdentityRetrieval>;
  recover(url: string, request: Versioned<IdRecoveryRequest>): Promise<Versioned<IdentityObjectV1>>;
  retrieve(url: string): Promise<IdentityRetrieval>;
}

/** SDK operations isolated for deterministic orchestration tests. */
export interface IdentityCrypto {
  request: typeof import('@concordium/web-sdk').createIdentityRequestWithKeys;
  recovery: typeof import('@concordium/web-sdk').createIdentityRecoveryRequestWithKeys;
  credential: typeof import('@concordium/web-sdk').createCredentialPayloadNoSeed;
}

/** A finalized observation of the expected account. */
export type FinalizedAccountSelector = { type: 'address'; address: string } | { type: 'credentialId'; credentialId: string };

/** One finalized account lookup with fixed-block provenance. */
export type FinalizedAccountResult =
  | { exists: false; sourceBlock: AccountCredentialSourceBlock; genesisHash: string }
  | { exists: true; canonicalAddress: string; sourceBlock: AccountCredentialSourceBlock; observation: AccountCredentialObservation; genesisHash: string };

/** Lookup against one captured finalized block. */
export type AccountObserver = (selector: FinalizedAccountSelector) => Promise<FinalizedAccountResult>;

/** Creates an observer pinned to one finalized block. */
export type AccountObserverFactory = (network: string) => Promise<AccountObserver>;

/** Package-local orchestration dependencies. */
export interface IdentityWorkflowDependencies {
  store: IdentityStore;
  /** Resolve one explicit selector to its canonical lower-case `ccd:<32-hex>` namespace. */
  resolveNetwork(selector?: string): string;
  loadContext(selection: IdentityContextSelection): Promise<IdentityContext>;
  provider: IdentityProviderClient;
  sources: IdentitySourceService;
  promptPin?: () => Promise<string>;
  listEnabledProviders(network: string): Promise<number[]>;
  createAccountObserver: AccountObserverFactory;
  crypto?: IdentityCrypto;
  now?: () => number;
  /** CLI-controlled per-network timeout; expiry always requires definitive IDP rechecking. */
  getIdentityRequestTimeoutMs?(network: string): Promise<number>;
}

/** Identity attributes permitted by the current default account-opening disclosure policy. */
export const DEFAULT_REVEALABLE_IDENTITY_ATTRIBUTES = [
  'firstName', 'lastName', 'countryOfResidence', 'nationality',
  'idDocType', 'idDocIssuer', 'idDocIssuedAt', 'idDocExpiresAt',
  'lei', 'legalName', 'legalCountry', 'registrationAuth',
] as const;

/** One identity attribute permitted by the current default account-opening disclosure policy. */
export type DefaultRevealableIdentityAttribute =
  (typeof DEFAULT_REVEALABLE_IDENTITY_ATTRIBUTES)[number];

/** Fixed warning returned with every nonempty account-opening disclosure preview. */
export const ACCOUNT_OPENING_DISCLOSURE_WARNING =
  'These identity attributes will become public on-chain if this account opening is submitted.';

/** Account-opening request using external signer-owned indexed Ed25519 public keys. */
export interface PrepareAccountInput {
  network?: string;
  identityId: string;
  credentialNumber?: number;
  /** At most 255 canonical byte-indexed Ed25519 public keys committed into the credential. */
  publicKeys: Record<string, string>;
  /** Number of credential-key signatures required. */
  credentialThreshold: number;
  expirySeconds: number;
  /** Explicit per-account attributes to reveal publicly; omission discloses none. */
  revealAttributes?: readonly DefaultRevealableIdentityAttribute[];
}

/** Public signer handoff fields shared by private and disclosing account openings. */
export interface PreparedAccountBase {
  network: string;
  /** Target-bound unsigned credential deployment signer handoff. */
  credDeploymentHex: string;
  accountAddress: string;
  credentialNumber: number;
  expirySeconds: number;
}

/** Public signer handoff with an exact decoded disclosure preview when disclosure is nonempty. */
export type PreparedAccount = PreparedAccountBase & (
  | { revealedAttributes?: never; disclosureWarning?: never }
  | {
      revealedAttributes: Record<string, string>;
      disclosureWarning: typeof ACCOUNT_OPENING_DISCLOSURE_WARNING;
    }
);

/** Account-opening reconciliation result. */
export interface AccountOpeningReconciliation {
  network: string;
  identityId: string;
  status: 'pending' | 'confirmed' | 'expired' | 'no_pending';
  credentialNumber?: number;
}

/** Safe result for one bounded discovery stream. */
export interface DiscoveryStreamResult {
  used: number[]; reserved: number[]; unused: number[];
  scannedRange: { start: number; end?: number };
  nextIndex?: number;
  partial: boolean;
  stopReason: 'gap' | 'range' | 'limit' | 'error';
  errorCode?: IdentityWorkflowErrorCode;
}

/** Safe identity-discovery result grouped by provider. */
export interface IdentityDiscoveryResult {
  network: string; sourceId: string; gapLimit: number;
  streams: Array<DiscoveryStreamResult & { identityProviderIndex: number }>;
}

/** Safe credential-discovery result for one identity. */
export interface CredentialDiscoveryResult {
  network: string; identityId: string; gapLimit: number;
  sourceBlock?: AccountCredentialSourceBlock;
  stream: DiscoveryStreamResult;
}

/** Shared CLI/MCP workflow. It never derives account keys, signs, or submits. */
export interface IdentityWorkflow {
  /** Set, change protection for, or remove an identity label with operator authority. */
  setOperatorIdentityLabel(input: IdentityLabelInput): Promise<IdentitySummary>;
  /** Set or remove an agent-modifiable label only when no operator-protected label exists. */
  setAgentIdentityLabel(input: IdentityLabelInput): Promise<IdentitySummary>;
  request(input: IdentityRequestInput): Promise<IdentityRequestResult>;
  recover(input: IdentityRecoveryInput): Promise<IdentitySummary>;
  discoverIdentities(input: DiscoverIdentitiesInput): Promise<IdentityDiscoveryResult>;
  discoverAccountCredentials(input: DiscoverAccountCredentialsInput): Promise<CredentialDiscoveryResult>;
  associateIdentitySource(input: AssociateIdentitySourceInput): Promise<IdentitySummary>;
  status(input: { network?: string; identityId: string; callbackUrl?: string }): Promise<IdentitySummary>;
  list(input: { network?: string }): Promise<IdentitySummary[]>;
  /** Perform one recovery-only check guarded by the durable request-attempt identifier. */
  monitorIdentity(input: { network: string; identityId: string; expectedAttemptId: string }): Promise<IdentitySummary>;
  prepareAccount(input: PrepareAccountInput): Promise<PreparedAccount>;
  reconcileAccountOpening(input: { network?: string; identityId: string }): Promise<AccountOpeningReconciliation>;
}
