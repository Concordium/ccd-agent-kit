import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import type {
  CredentialDeploymentPayload,
  CdiRandomness,
  IdentityObjectV1,
  IdObjectRequestV1,
  IdRecoveryRequest,
  Versioned,
} from '@concordium/web-sdk';
import { vi } from 'vitest';

import type {
  IdentityContext,
  CredentialRegistry,
  IdentityCrypto,
  IdentityIndexRecord,
  IdentityNetworkMetadata,
  IdentityProviderClient,
  IdentitySelection,
  IdentityStore,
  IdentityWorkflowDependencies,
  StoredIdentity,
  StoredIdentityLifecycle,
  StoredIssuedIdentity,
} from '../src/core/workflowTypes.js';
import type { IdentitySourceService, ResolvedIdentitySource } from '../src/core/sources/types.js';
import { deriveIdentitySourceId } from '@ccd-agent-kit/config-utils';
import { IdentityWorkflowError } from '../src/core/workflowErrors.js';
import { identityLabelValue, parseIdentityLabel } from '../src/core/identityLabels.js';
import { softwareDevice } from './helpers.js';

export const IDENTITY_ID = '7878765ef277a62e892c8b4e477b27edbbee48236dce9db4290db3c5360108f5';
export const ID_CRED_PUB = '11'.repeat(48);
export const PUBLIC_KEY = 'e6e387ecae9f68f3547da5546bf02d1ee071a7efb95a2e53781c9b482ef3d8e1';
export const NOW_MS = 1_800_000_000_000;
export const GENESIS_HASH = '12'.repeat(32);
export const NETWORK = `ccd:${GENESIS_HASH.slice(0, 32)}`;
export const ROOT_PUBLIC_KEY = softwareDevice().publicKey.toString('hex');
export const SOURCE_ID = deriveIdentitySourceId(ROOT_PUBLIC_KEY, 1);
export const SOURCE_NAME = 'primary';
export const ON_CHAIN_COMMITMENT_KEY = `${'97f1d3a73197d7942695638c4fa9ac0fc3688c4f9774b905a14e3a3f171bac586c55e83ff97a1aeffb3af00adb22c6bb'.repeat(2)}`;
export const SOURCE_BLOCK = {
  hash: 'ab'.repeat(32), height: '7', time: new Date(NOW_MS).toISOString(),
};

export function selection(): IdentitySelection {
  return {
    network: NETWORK,
    sdkNetwork: 'Testnet',
    rootPublicKey: ROOT_PUBLIC_KEY,
    identityProviderIndex: 7,
    identityIndex: 2,
  } as IdentitySelection;
}

export function startSelection() {
  const value = selection();
  return {
    network: value.network, device: value.device, rootPublicKey: value.rootPublicKey,
    identityProviderIndex: value.identityProviderIndex, identityIndex: value.identityIndex,
  };
}

/** Canonical stage-7 request input: source trust replaces raw device/root selectors. */
export function requestInput(identityIndex: number | undefined = selection().identityIndex) {
  return {
    network: NETWORK, source: SOURCE_ID, identityProviderIndex: selection().identityProviderIndex,
    ...(identityIndex === undefined ? {} : { identityIndex }),
  };
}

/** Canonical stage-7 recovery input always identifies the existing deterministic index. */
export function recoveryInput() {
  return { ...requestInput(selection().identityIndex), identityIndex: selection().identityIndex };
}

export function sourceRecord(): ResolvedIdentitySource {
  return {
    id: SOURCE_ID,
    label: SOURCE_NAME,
    backends: [{ backend: 'yubikey-piv', locations: [{ serial: '12345678' }] }],
    rootPublicKey: ROOT_PUBLIC_KEY,
    rootPublicKeyFingerprint: createHash('sha256').update(Buffer.from(ROOT_PUBLIC_KEY, 'hex')).digest('hex'),
    recipeVersion: 1,
  };
}

export function sourceService(
  device = softwareDevice(),
  overrides: Partial<IdentitySourceService> = {},
): IdentitySourceService {
  const record = { ...sourceRecord(), rootPublicKey: device.publicKey.toString('hex') };
  return {
    enroll: vi.fn(),
    list: vi.fn(async () => [{ id: record.id, label: record.label, isDefault: true, availability: 'unlocked' as const }]),
    records: vi.fn(async () => [structuredClone(record)]),
    refresh: vi.fn(async () => undefined),
    inspect: vi.fn(),
    rename: vi.fn(),
    setDefault: vi.fn(),
    resolve: vi.fn(async (source?: string) => {
      if (source !== undefined && source !== record.id && source !== record.label) throw new Error('unknown source');
      return structuredClone(record);
    }),
    createAgreement: vi.fn(async (source: string) => {
      if (source !== record.id) throw new Error('agreement requires canonical source id');
      return { agree: device.agree };
    }),
    ...overrides,
  } as IdentitySourceService;
}

export function historicalSelection(): IdentitySelection {
  return { ...selection(), device: '12345678', walletProxyUrl: 'https://wallet.example.test/v1/' };
}

export function context(overrides: Partial<IdentityContext> = {}): IdentityContext {
  return {
    network: NETWORK,
    genesisHash: GENESIS_HASH,
    sdkNetwork: 'Testnet',
    ipInfo: {
      ipIdentity: 7,
      ipDescription: { name: 'Test issuer', url: 'https://issuer.example.test', description: 'test' },
      ipVerifyKey: '22'.repeat(32),
      ipCdiVerifyKey: '33'.repeat(96),
    },
    arsInfos: {
      1: {
        arIdentity: 1,
        arDescription: { name: 'AR one', url: 'https://ar1.example.test', description: 'test' },
        arPublicKey: '44'.repeat(96),
      },
      2: {
        arIdentity: 2,
        arDescription: { name: 'AR two', url: 'https://ar2.example.test', description: 'test' },
        arPublicKey: '55'.repeat(96),
      },
      3: {
        arIdentity: 3,
        arDescription: { name: 'AR three', url: 'https://ar3.example.test', description: 'test' },
        arPublicKey: '56'.repeat(96),
      },
    },
    globalContext: {
      onChainCommitmentKey: ON_CHAIN_COMMITMENT_KEY,
      bulletproofGenerators: '77'.repeat(64),
      genesisString: 'local-testnet-genesis',
    },
    issuanceUrl: 'https://issuer.example.test/v1/identity',
    recoveryUrl: 'https://issuer.example.test/v1/recover',
    ...overrides,
  } as IdentityContext;
}

export function requestObject(idCredPub = ID_CRED_PUB): Versioned<IdObjectRequestV1> {
  return {
    v: 0,
    value: {
      idCredPub,
      choiceArData: { arIdentities: [1, 2], threshold: 2 },
      ipArData: {
        1: { encPrfKeyShare: 'ab'.repeat(96), proofComEncEq: 'bc'.repeat(64) },
        2: { encPrfKeyShare: 'cd'.repeat(96), proofComEncEq: 'de'.repeat(64) },
      },
      idCredSecCommitment: '88'.repeat(48),
      prfKeyCommitmentWithIP: '99'.repeat(48),
      prfKeySharingCoeffCommitments: ['ef'.repeat(48)],
      proofsOfKnowledge: 'aa'.repeat(64),
    },
  };
}

export function recoveryObject(idCredPub = ID_CRED_PUB): Versioned<IdRecoveryRequest> {
  return { v: 0, value: { idCredPub, timestamp: 1_800_000_000 as never, proof: 'bb'.repeat(64) } };
}

export function identityObject(
  preIdentityObject: IdObjectRequestV1 = requestObject().value,
): Versioned<IdentityObjectV1> {
  return {
    v: 0,
    value: {
      preIdentityObject: structuredClone(preIdentityObject),
      attributeList: {
        validTo: '203012',
        createdAt: '202610',
        maxAccounts: 3,
        chosenAttributes: { firstName: 'Ada', lastName: 'Lovelace' },
      },
      signature: 'cc'.repeat(96),
    },
  };
}

export function credentialPayload(): CredentialDeploymentPayload & CdiRandomness {
  return {
    expiry: { expiryEpochSeconds: BigInt(NOW_MS / 1000 + 600) } as never,
    unsignedCdi: {
      arData: {},
      credId: 'aa'.repeat(48),
      credentialPublicKeys: {
        keys: { 0: { schemeId: 'Ed25519', verifyKey: PUBLIC_KEY } },
        threshold: 1,
      },
      ipIdentity: 7,
      policy: { createdAt: '202610', revealedAttributes: {}, validTo: '203012' },
      proofs: {
        challenge: 'cc'.repeat(32),
        commitments: 'dd'.repeat(64),
        credCounterLessThanMaxAccounts: 'ee'.repeat(740),
        proofIdCredPub: { 1: '12'.repeat(96), 2: '34'.repeat(96) },
        proofIpSig: '56'.repeat(96),
        proofRegId: '78'.repeat(160),
        sig: '9a'.repeat(96),
      },
      revocationThreshold: 2,
    },
    randomness: {
      idCredSecRand: '01'.repeat(32),
      prfRand: '02'.repeat(32),
      credCounterRand: '03'.repeat(32),
      maxAccountsRand: '04'.repeat(32),
      attributesRand: {} as never,
    },
  };
}

class NetworkRecords {
  private readonly networks = new Map<string, Map<string, StoredIdentity>>();

  get size() { return [...this.networks.values()].reduce((count, records) => count + records.size, 0); }
  get(id: string, network = NETWORK) { return this.networks.get(network)?.get(id); }
  has(id: string, network = NETWORK) { return this.networks.get(network)?.has(id) ?? false; }
  set(id: string, record: StoredIdentity) {
    const records = this.networks.get(record.selection.network) ?? new Map<string, StoredIdentity>();
    records.set(id, record);
    this.networks.set(record.selection.network, records);
    return this;
  }
  values(network = NETWORK) { return this.networks.get(network)?.values() ?? [][Symbol.iterator](); }
  entries(network = NETWORK) { return this.networks.get(network)?.entries() ?? [][Symbol.iterator](); }
  allValues() { return [...this.networks.values()].flatMap((records) => [...records.values()]); }
}

class NetworkCredentials {
  private readonly networks = new Map<string, Map<string, CredentialRegistry['credentials'][string]>>();

  private for(network: string) {
    const credentials = this.networks.get(network) ?? new Map<string, CredentialRegistry['credentials'][string]>();
    this.networks.set(network, credentials);
    return credentials;
  }
  set(id: string, value: CredentialRegistry['credentials'][string], network = NETWORK) {
    this.for(network).set(id, value);
    return this;
  }
  entries(network = NETWORK) { return this.for(network).entries(); }
  replace(network: string, registry: CredentialRegistry) {
    const credentials = this.for(network);
    credentials.clear();
    for (const [id, value] of Object.entries(registry.credentials)) credentials.set(id, structuredClone(value));
  }
  [Symbol.iterator]() { return this.entries(); }
}

class MemoryIdentityStore implements IdentityStore {
  now: () => number = Date.now;
  readonly records = new NetworkRecords();
  readonly credentials = new NetworkCredentials();
  readonly reservations = new Map<string, Map<number, {
    state: 'reserved' | 'used' | 'failed' | 'released'; reservedAt: number;
  }>>();
  readonly networkMetadata = new Map<string, IdentityNetworkMetadata>([[NETWORK, {
    caip2: NETWORK, genesisHash: GENESIS_HASH, sdkNetwork: 'Testnet',
  }]]);
  readonly bootstrapNetwork = vi.fn(async (network: IdentityNetworkMetadata) => {
    this.networkMetadata.set(network.caip2, structuredClone(network));
  });
  readonly create = vi.fn(async (record: StoredIdentity) => {
    if (this.records.has(record.id, record.selection.network)) throw new Error('duplicate');
    if (record.label !== undefined) this.assertLabelAvailable(record.selection.network, record.label);
    this.records.set(record.id, structuredClone(record));
  });
  readonly load = vi.fn(async (network: string, id: string) => {
    const record = this.records.get(id, network);
    if (record === undefined) throw new IdentityWorkflowError('IDENTITY_NOT_FOUND');
    return structuredClone(record);
  });
  readonly save = vi.fn(async (
    record: StoredIdentity, expectedWorkflow: IdentityIndexRecord['workflow'], reservationState?: 'failed',
  ) => {
    if (reservationState !== undefined && (reservationState !== 'failed' || record.status !== 'error')) throw new Error();
    const current = this.records.get(record.id, record.selection.network);
    if (!current) throw new Error('missing');
    if (!isDeepStrictEqual(this.workflowFrom(current), expectedWorkflow)) {
      throw new IdentityWorkflowError('INDEX_UNAVAILABLE');
    }
    if (reservationState === 'failed') this.writeReservationState(record, 'failed');
    const next = structuredClone(record);
    delete next.label;
    if (current.label !== undefined) next.label = current.label;
    this.records.set(record.id, next);
  });
  readonly list = vi.fn(async (network: string) => [...this.records.values(network)].map((record) => structuredClone(record)));
  readonly listIdentityMonitorCandidates = vi.fn(async (_now: number) => []);
  readonly readIdentityRequestReservation = vi.fn(async (_input: {
    genesisHash: string; sourceId: string; sdkNetwork: string; identityProviderIndex: number; identityIndex: number;
  }) => undefined as { state: 'reserved' | 'used' | 'failed' | 'released'; reservedAt: number } | undefined);
  readonly setIdentityLabel = vi.fn(async (input: Parameters<IdentityStore['setIdentityLabel']>[0]) => {
    if (!/^[0-9a-f]{64}$/.test(input.identityId)) throw new IdentityWorkflowError('INVALID_INPUT');
    const id = input.identityId;
    const current = this.records.get(id, input.network);
    if (!current) throw new IdentityWorkflowError('IDENTITY_NOT_FOUND');
    if (input.authority === 'agent' && current.label !== undefined && !current.label.startsWith('@')) {
      throw new IdentityWorkflowError('LABEL_PROTECTED');
    }
    const next = structuredClone(current);
    if (!('label' in input) || input.label === undefined) delete next.label;
    else {
      const label = parseIdentityLabel(input.label);
      this.assertLabelAvailable(input.network, label, id);
      next.label = label;
    }
    this.records.set(id, next);
    return structuredClone(next);
  });
  readonly createIdentity = vi.fn(async (
    network: IdentityNetworkMetadata, id: string, record: IdentityIndexRecord, identity: NonNullable<StoredIdentity['identity']>, _key: Uint8Array,
    expectedWorkflow: IdentityIndexRecord['workflow'] | null,
  ) => {
    this.networkMetadata.set(network.caip2, structuredClone(network));
    const current = this.records.get(id, network.caip2);
    if (expectedWorkflow === null ? current !== undefined
      : current === undefined || !isDeepStrictEqual(this.workflowFrom(current), expectedWorkflow)) {
      throw new IdentityWorkflowError('INDEX_UNAVAILABLE');
    }
    if (current === undefined && record.label !== undefined) this.assertLabelAvailable(network.caip2, record.label);
    this.writeReservationState({
      version: 1, id,
      ...(record.sourceId === undefined ? {} : { sourceId: record.sourceId }),
      selection: { network: network.caip2, sdkNetwork: network.sdkNetwork, ...record.selection },
      ...record.workflow,
    } as StoredIdentity, 'used');
    const stored = this.fromIndexRecord(network, id, record, current?.label) as StoredIssuedIdentity;
    this.records.set(id, { ...structuredClone(stored), identity: structuredClone(identity) });
  });
  readonly restoreIdentity = vi.fn(async (
    network: IdentityNetworkMetadata, id: string, record: IdentityIndexRecord,
    identity: NonNullable<StoredIdentity['identity']>, _key: Uint8Array,
    expectedWorkflow?: IdentityIndexRecord['workflow'],
  ) => {
    this.networkMetadata.set(network.caip2, structuredClone(network));
    const current = this.records.get(id, network.caip2);
    if (current === undefined || expectedWorkflow === undefined
      || !isDeepStrictEqual(this.workflowFrom(current), expectedWorkflow)) {
      throw new IdentityWorkflowError('INDEX_UNAVAILABLE');
    }
    const stored = this.fromIndexRecord(network, id, record, current?.label) as StoredIssuedIdentity;
    this.records.set(id, { ...stored, identity: structuredClone(identity) });
  });
  readonly loadIdentity = vi.fn(async (network: string, id: string) => {
    const identity = this.records.get(id, network)?.identity;
    if (!identity) throw Object.assign(new Error('missing'), { code: 'IDENTITY_FILE_MISSING' });
    return structuredClone(identity);
  });
  readonly readIndex = vi.fn(async (network: string) => ({
    version: 1 as const,
    network: structuredClone(this.networkMetadata.get(network) ?? {
      caip2: network, genesisHash: GENESIS_HASH, sdkNetwork: 'Testnet' as const,
    }),
    identities: Object.fromEntries([...this.records.entries(network)].map(([id, stored]) => [id, {
      file: `${id}.json`, recipeVersion: 1 as const,
      ...((stored as StoredIdentity & { sourceId?: string }).sourceId === undefined
        ? {} : { sourceId: (stored as StoredIdentity & { sourceId?: string }).sourceId }),
      ...(stored.label === undefined ? {} : { label: stored.label }),
      selection: {
        ...(stored.selection.device === undefined ? {} : { device: stored.selection.device }),
        rootPublicKey: stored.selection.rootPublicKey,
         rootPublicKeyFingerprint: createHash('sha256').update(Buffer.from(stored.selection.rootPublicKey, 'hex')).digest('hex'),
         identityProviderIndex: stored.selection.identityProviderIndex, identityIndex: stored.selection.identityIndex,
         ...(stored.selection.walletProxyUrl === undefined ? {} : { walletProxyUrl: stored.selection.walletProxyUrl }),
      },
       workflow: this.workflowFrom(stored),
    }])),
  }));
  readonly withMutation = (async <T>(_network: string, operation: () => Promise<T>) => operation()) as NonNullable<IdentityStore['withMutation']>;
  readonly loadCredentials = vi.fn(async (network: string) => ({
    version: 1 as const, credentials: Object.fromEntries(this.credentials.entries(network)),
  }));
  readonly saveCredentials = vi.fn(async (network: string, registry: CredentialRegistry) => {
    this.credentials.replace(network, registry);
  });
  readonly listIdentityReservations = vi.fn(async (scope: {
    genesisHash: string; sourceId: string; sdkNetwork: string; identityProviderIndex: number;
  }) => [...this.occupied(scope)].sort((a, b) => a - b));
  readonly listExpiredIdentityReservations = vi.fn(async (scope: {
    genesisHash: string; sourceId: string; sdkNetwork: string; identityProviderIndex: number;
  }, now: number, timeoutMs: number) => {
    if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error();
    const key = this.reservationKey(scope);
    const rows = this.reservations.get(key) ?? new Map<number, {
      state: 'reserved' | 'used' | 'failed' | 'released'; reservedAt: number;
    }>();
    for (const record of this.matchingRecords(scope)) {
      if (record.status !== 'ready' && !rows.has(record.selection.identityIndex)) {
        rows.set(record.selection.identityIndex, { state: 'reserved', reservedAt: now });
      }
    }
    this.reservations.set(key, rows);
    return [...rows.entries()]
      .filter(([, row]) => row.state === 'reserved' && now - row.reservedAt >= timeoutMs)
      .map(([identityIndex, { reservedAt }]) => ({ identityIndex, reservedAt }))
      .sort((left, right) => left.identityIndex - right.identityIndex);
  });
  readonly reserveIdentityIndex = vi.fn(async (input: Parameters<IdentityStore['reserveIdentityIndex']>[0]) => {
    const key = this.reservationKey(input);
    const reserved = this.reservations.get(key) ?? new Map<number, {
      state: 'reserved' | 'used' | 'failed' | 'released'; reservedAt: number;
    }>();
    const occupied = this.occupied(input);
    if (input.mode === 'explicit' && occupied.has(input.identityIndex)) {
      throw new IdentityWorkflowError('INDEX_UNAVAILABLE');
    }
    if (input.mode === 'next') {
      const highWater = occupied.size === 0 ? -1 : Math.max(...occupied);
      if (input.expectedHighWater !== highWater || input.identityIndex !== highWater + 1) {
        throw new IdentityWorkflowError('INDEX_UNAVAILABLE');
      }
    }
    const existing = reserved.get(input.identityIndex);
    const state = input.mode === 'used' ? 'used' : input.mode === 'failed' ? 'failed' : 'reserved';
    if (!existing || existing.state === 'released') reserved.set(input.identityIndex, { state, reservedAt: this.now() });
    else if (input.mode === 'used') existing.state = 'used';
    else if (input.mode === 'failed' && existing.state === 'reserved') existing.state = 'failed';
    this.reservations.set(key, reserved);
  });
  readonly resolveIdentityReservation = vi.fn(async (input: Parameters<IdentityStore['resolveIdentityReservation']>[0]) => {
    const rows = this.reservations.get(this.reservationKey(input));
    const row = rows?.get(input.identityIndex);
    if (!row || row.state !== 'reserved' || row.reservedAt !== input.reservedAt) {
      throw new IdentityWorkflowError('INDEX_UNAVAILABLE');
    }
    if (input.state === 'released') {
      const current = this.matchingRecords(input).find((record) => record.selection.identityIndex === input.identityIndex);
      const workflow = current === undefined ? null : this.workflowFrom(current);
      if (!isDeepStrictEqual(workflow, input.expectedWorkflow)) throw new IdentityWorkflowError('INDEX_UNAVAILABLE');
      row.state = current?.status === 'ready' ? 'used' : 'released';
      if (current && current.status !== 'ready') this.records.set(current.id, { ...current, status: 'expired' });
    } else row.state = 'failed';
  });

  private reservationKey(scope: {
    genesisHash: string; sourceId: string; sdkNetwork: string; identityProviderIndex: number;
  }) {
    return `${scope.genesisHash}\0${scope.sourceId}\0${scope.sdkNetwork}\0${scope.identityProviderIndex}`;
  }

  private fromIndexRecord(
    network: IdentityNetworkMetadata, id: string, record: IdentityIndexRecord, label = record.label,
  ): StoredIdentity {
    const storedSelection = { ...record.selection };
    delete (storedSelection as Partial<typeof storedSelection>).rootPublicKeyFingerprint;
    const sourceId = (record as IdentityIndexRecord & { sourceId?: string }).sourceId;
    return {
      version: 1, id, ...(sourceId === undefined ? {} : { sourceId }),
      ...(label === undefined ? {} : { label }),
      selection: { network: network.caip2, sdkNetwork: network.sdkNetwork, ...storedSelection },
      ...structuredClone(record.workflow),
    } as StoredIdentity;
  }

  private assertLabelAvailable(network: string, label: string, ownId?: string) {
    const value = identityLabelValue(parseIdentityLabel(label));
    for (const [id, record] of this.records.entries(network)) {
      if (id !== ownId && record.label !== undefined && identityLabelValue(record.label) === value) {
        throw new IdentityWorkflowError('LABEL_IN_USE');
      }
    }
  }

  private occupied(scope: {
    genesisHash: string; sourceId: string; sdkNetwork: string; identityProviderIndex: number;
  }) {
    const rows = this.reservations.get(this.reservationKey(scope)) ?? new Map();
    const occupied = new Set([...rows.entries()].filter(([, row]) => row.state !== 'released').map(([index]) => index));
    for (const record of this.matchingRecords(scope)) {
      if (record.status === 'ready' || rows.get(record.selection.identityIndex)?.state !== 'released') {
        occupied.add(record.selection.identityIndex);
      }
    }
    return occupied;
  }

  private matchingRecords(scope: {
    genesisHash: string; sourceId: string; sdkNetwork: string; identityProviderIndex: number;
  }) {
    const network = `ccd:${scope.genesisHash.slice(0, 32)}`;
    const metadata = this.networkMetadata.get(network);
    if (metadata?.genesisHash !== scope.genesisHash || metadata.sdkNetwork !== scope.sdkNetwork) return [];
    return [...this.records.values(network)].filter((record) => record.selection.identityProviderIndex === scope.identityProviderIndex
      && (record.sourceId ?? deriveIdentitySourceId(record.selection.rootPublicKey, 1)) === scope.sourceId);
  }

  private workflowFrom(record: StoredIdentity): IdentityIndexRecord['workflow'] {
    return {
      status: record.status, contextHash: record.contextHash,
      idCredPub: record.idCredPub,
      ...(record.request === undefined ? {} : { request: structuredClone(record.request) }),
      ...(record.retrievalUrl === undefined ? {} : { retrievalUrl: record.retrievalUrl }),
      ...(record.requestAttemptId === undefined ? {} : { requestAttemptId: record.requestAttemptId }),
      ...((record as StoredIdentity & { authorizationUrl?: string }).authorizationUrl === undefined
        ? {} : { authorizationUrl: (record as StoredIdentity & { authorizationUrl: string }).authorizationUrl }),
      ...((record as StoredIdentity & { confirmedFailure?: unknown }).confirmedFailure === undefined
        ? {} : { confirmedFailure: structuredClone((record as StoredIdentity & { confirmedFailure: unknown }).confirmedFailure) }),
      ...((record as StoredIdentity & { postIssuance?: unknown }).postIssuance === undefined
        ? {} : { postIssuance: structuredClone((record as StoredIdentity & { postIssuance: unknown }).postIssuance) }),
    };
  }

  private writeReservationState(record: StoredIdentity, state: 'used' | 'failed') {
    const metadata = this.networkMetadata.get(record.selection.network);
    if (!metadata) throw new Error('missing network metadata');
    const scope = {
      genesisHash: metadata.genesisHash,
      sourceId: record.sourceId ?? deriveIdentitySourceId(record.selection.rootPublicKey, 1),
      sdkNetwork: metadata.sdkNetwork,
      identityProviderIndex: record.selection.identityProviderIndex,
    };
    const key = this.reservationKey(scope);
    const rows = this.reservations.get(key) ?? new Map<number, {
      state: 'reserved' | 'used' | 'failed' | 'released'; reservedAt: number;
    }>();
    const existing = rows.get(record.selection.identityIndex);
    if (!existing || existing.state === 'released') {
      rows.set(record.selection.identityIndex, { state, reservedAt: this.now() });
    } else if (state === 'used' && existing.state !== 'used') existing.state = 'used';
    else if (state === 'failed' && existing.state === 'reserved') existing.state = 'failed';
    this.reservations.set(key, rows);
  }
}

export function readyRecord(overrides: Partial<StoredIssuedIdentity> = {}): StoredIssuedIdentity {
  const request = requestObject();
  return {
    version: 1,
    id: IDENTITY_ID,
    selection: selection(),
    contextHash: contextFingerprint(context()),
    idCredPub: ID_CRED_PUB,
    status: 'ready',
    sourceId: SOURCE_ID,
    identity: identityObject(request.value),
    ...overrides,
  };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Independent test oracle for the SHA-256 fingerprint of the complete canonical public context. */
export function contextFingerprint(value: IdentityContext): string {
  const pinned = { ...value } as IdentityContext & { issuance?: unknown; anonymityRevocation?: unknown };
  delete pinned.issuance;
  delete pinned.anonymityRevocation;
  return createHash('sha256').update(canonicalJson(pinned), 'utf8').digest('hex');
}

export function awaitingRecord(): StoredIdentityLifecycle & {
  status: 'awaiting_verification'; request: Versioned<IdObjectRequestV1>;
} {
  const ready = readyRecord();
  return {
    version: ready.version, id: ready.id,
    ...(ready.sourceId === undefined ? {} : { sourceId: ready.sourceId }),
    ...(ready.label === undefined ? {} : { label: ready.label }),
    selection: ready.selection, contextHash: ready.contextHash, idCredPub: ready.idCredPub,
    status: 'awaiting_verification', request: requestObject(),
  };
}

export function setup(overrides: Partial<IdentityWorkflowDependencies> = {}) {
  const store = new MemoryIdentityStore();
  store.now = overrides.now ?? (() => NOW_MS);
  const device = softwareDevice();
  const request = requestObject();
  const recovery = recoveryObject();
  const payload = credentialPayload();
  const crypto = {
    request: vi.fn(() => structuredClone(request)),
    recovery: vi.fn(() => structuredClone(recovery)),
    credential: vi.fn(() => structuredClone(payload)),
  } as unknown as IdentityCrypto;
  const provider: IdentityProviderClient = {
    createIssuanceContext: vi.fn(async () => ({
      url: 'https://issuer.example.test/verify',
      statusUrl: 'https://issuer.example.test/agent-id/ctx-default/identity-object',
    })),
    pollIssuanceContext: vi.fn(async () => ({ status: 'pending' as const })),
    recover: vi.fn<IdentityProviderClient['recover']>(async () => { throw new IdentityWorkflowError('IDENTITY_NOT_FOUND'); }),
    retrieve: vi.fn<IdentityProviderClient['retrieve']>(async () => ({ status: 'pending' as const })),
  };
  const sources = sourceService(device);
  const createAccountObserver = vi.fn(async () => vi.fn(async () => ({
    exists: false as const, sourceBlock: SOURCE_BLOCK, genesisHash: GENESIS_HASH,
  })));
  const deps: IdentityWorkflowDependencies = {
    store,
    resolveNetwork: vi.fn((selector?: string) => {
      if (selector === undefined) return NETWORK;
      if (selector === 'localnet' || selector === GENESIS_HASH.slice(0, 32) || selector === NETWORK) return NETWORK;
      return selector;
    }),
    loadContext: vi.fn(async () => context()),
    provider,
    crypto,
    now: () => NOW_MS,
    sources,
    listEnabledProviders: vi.fn(async () => [selection().identityProviderIndex]),
    createAccountObserver,
    ...overrides,
  } as IdentityWorkflowDependencies;
  return { deps, store, device, sources, createAccountObserver, crypto, provider, request, recovery, payload };
}
