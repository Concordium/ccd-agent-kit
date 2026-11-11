import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  AccountAddress, AttributesKeys, TransactionExpiry, createCredentialPayloadNoSeed,
  createIdentityRequestWithKeys, createIdentityRecoveryRequestWithKeys, getAccountAddress,
  type CredentialInputNoSeed, type IdentityObjectV1, type Versioned,
} from '@concordium/web-sdk';
import {
  buildAccountOpeningCredentialDeploymentHandoff, ed25519PublicKey, hexString,
  summarizeCredentialDeploymentSigningHandoff,
} from '@ccd-agent-kit/sdk-utils';
import { getDiscoveryStopReason, getNextIdentityIndex, MAX_IDENTITY_INDEX as MAX_INDEX } from './discoveryPolicy.js';
import { deriveAttributeRandomness, deriveCredentialRegistrationId, type IdentityMaterial } from './identityMaterial.js';
import { withIdentityMaterial } from './identityMaterialSession.js';
import { IdentityProviderError } from './providers/error.js';
import { resolveAnonymityRevocationPolicy } from './providers/anonymityRevocation.js';
import { IdentityWorkflowError, workflowFailure, type IdentityWorkflowErrorCode } from './workflowErrors.js';
import {
  accountOpeningInputSchema, credentialDiscoveryInputSchema, identityDiscoveryInputSchema, identityIdSchema,
  identityLabelInputSchema, identityRecoveryInputSchema, identityRequestInputSchema,
  identitySelectorSchema, identitySourceAssociationInputSchema,
  parseIdentityObject, safeHttpUrl,
} from './workflowValidation.js';
import {
  CatalogLabelError, findCatalogLabel, prepareCatalogLabelMutation, IdentitySourceError,
} from '@ccd-agent-kit/config-utils';
import { defaultIdentityLabel, identityLabelValue } from './identityLabels.js';
import type { ResolvedIdentitySource } from './sources/types.js';
import type {
  AssociateIdentitySourceInput, CredentialDiscoveryResult, CredentialRegistryEntry,
  DiscoverAccountCredentialsInput, DiscoverIdentitiesInput, DiscoveryStreamResult, IdentityContext, IdentityCrypto,
  IdentityDiscoveryResult, IdentityIndexRecord, IdentityLabelInput, IdentityNetworkMetadata, IdentityRecoveryInput, IdentityRequestInput,
  DefaultRevealableIdentityAttribute, IdentitySelection, IdentitySummary, IdentityWorkflow, IdentityWorkflowDependencies,
  PrepareAccountInput, StoredIdentity, StoredIssuedIdentity,
} from './workflowTypes.js';
import {
  ACCOUNT_OPENING_DISCLOSURE_WARNING,
} from './workflowTypes.js';

/** Stable sanitized workflow failure, shared by CLI and MCP adapters. */
export { IdentityWorkflowError } from './workflowErrors.js';

const DEFAULT_GAP = 3;
const numericOrder = (left: number, right: number) => left - right;
const defaultCrypto: IdentityCrypto = {
  request: createIdentityRequestWithKeys,
  recovery: createIdentityRecoveryRequestWithKeys,
  credential: createCredentialPayloadNoSeed,
};

function canonicalRevealAttributes(
  selected: readonly DefaultRevealableIdentityAttribute[] | undefined,
): DefaultRevealableIdentityAttribute[] {
  return [...new Set(selected ?? [])]
    .sort((left, right) => AttributesKeys[left] - AttributesKeys[right]);
}

function sameRevealedAttributes(
  expected: Record<string, string>,
  actual: Record<string, string>,
): boolean {
  const expectedEntries = Object.entries(expected);
  const actualEntries = Object.entries(actual);
  return expectedEntries.length === actualEntries.length
    && expectedEntries.every(([name, value]) => Object.hasOwn(actual, name) && actual[name] === value);
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  }
  return value;
}

/** Compute the canonical pin for public identity-provider and network context. */
export function identityContextHash(context: IdentityContext): string {
  const pinned = { ...context };
  delete pinned.issuance;
  delete pinned.anonymityRevocation;
  return createHash('sha256').update(JSON.stringify(canonical(pinned))).digest('hex');
}

function summary(record: StoredIdentity): IdentitySummary {
  const status = record.confirmedFailure !== undefined && record.confirmedFailure.requestAttemptId === record.requestAttemptId
    ? 'failed' as const
    : record.status === 'ready' ? 'issued' as const
      : record.status === 'awaiting_verification' || record.status === 'pending' ? 'pending' as const : 'unknown' as const;
  return {
    identityId: record.id, network: record.selection.network,
    identityProviderIndex: record.selection.identityProviderIndex,
    identityIndex: record.selection.identityIndex, status,
    ...(record.sourceId === undefined ? {} : { sourceId: record.sourceId }),
    ...(record.label === undefined ? {} : { label: identityLabelValue(record.label) }),
  };
}

async function boundary<T>(code: IdentityWorkflowErrorCode, callback: () => T | Promise<T>): Promise<T> {
  try { return await callback(); } catch (error) { throw workflowFailure(error, code); }
}

function bindIdentity(record: Pick<StoredIdentity, 'idCredPub' | 'request'>, value: unknown): Versioned<IdentityObjectV1> {
  const identity = parseIdentityObject(value);
  const pre = identity.value.preIdentityObject;
  if (pre.idCredPub !== record.idCredPub || record.request && !isDeepStrictEqual(pre, record.request.value)) {
    throw new IdentityWorkflowError('IDENTITY_MISMATCH');
  }
  return identity;
}

/** Project a validated workflow onto the durable issued shape. */
function issuedIdentity(record: StoredIdentity, identity?: Versioned<IdentityObjectV1>): StoredIssuedIdentity {
  return {
    version: record.version,
    id: record.id,
    ...(record.sourceId === undefined ? {} : { sourceId: record.sourceId }),
    ...(record.label === undefined ? {} : { label: record.label }),
    selection: record.selection,
    contextHash: record.contextHash,
    idCredPub: record.idCredPub,
    status: 'ready',
    ...(identity === undefined ? {} : { identity }),
  };
}

function callbackRetrieval(callback: string, id: string, issuer: string): string {
  try {
    const url = new URL(callback);
    if (url.protocol !== 'ccd-id-manager:' || url.hostname !== 'identity' || url.pathname !== `/${id}`
      || url.username || url.password || url.port || url.search) throw new Error();
    const fragment = new URLSearchParams(url.hash.slice(1));
    if ([...fragment.keys()].length !== 1 || !fragment.has('code_uri')) throw new Error();
    const retrieval = safeHttpUrl(fragment.get('code_uri')!);
    if (retrieval.origin !== safeHttpUrl(issuer).origin) throw new Error();
    return retrieval.href;
  } catch { throw new IdentityWorkflowError('INVALID_INPUT'); }
}

function networkMetadata(context: IdentityContext): IdentityNetworkMetadata {
  return { caip2: context.network, genesisHash: context.genesisHash, sdkNetwork: context.sdkNetwork };
}

function reservationScope(context: IdentityContext, sourceId: string) {
  return { genesisHash: context.genesisHash, sourceId, sdkNetwork: context.sdkNetwork,
    identityProviderIndex: context.ipInfo.ipIdentity };
}

function postIssuanceStatusUrl(record: StoredIdentity, context: IdentityContext): string | undefined {
  const post = record.postIssuance;
  if (post?.status !== 'created' || post.statusUrl === undefined) return undefined;
  const endpoint = safeHttpUrl(post.statusUrl);
  if (endpoint.origin !== safeHttpUrl(context.issuanceUrl).origin
    || !/^\/agent-id\/[^/]+\/identity-object$/.test(endpoint.pathname)
    || endpoint.search !== '') throw new IdentityWorkflowError('INVALID_INPUT');
  return endpoint.href;
}

const WORKFLOW_METADATA_KEYS = new Set([
  'status', 'contextHash', 'idCredPub', 'request', 'retrievalUrl', 'requestAttemptId', 'confirmedFailure',
  'authorizationUrl', 'postIssuance',
]);

function workflowMetadata(record: StoredIdentity): IdentityIndexRecord['workflow'] {
  return Object.fromEntries(Object.entries(record).filter(([key]) => WORKFLOW_METADATA_KEYS.has(key))) as IdentityIndexRecord['workflow'];
}

function indexRecord(record: StoredIdentity, sourceId: string): IdentityIndexRecord {
  const publicSelection = { ...record.selection } as Partial<IdentitySelection>;
  delete publicSelection.network;
  delete publicSelection.sdkNetwork;
  return {
    file: `${record.id}.json`, recipeVersion: 1,
    sourceId,
    ...(record.label === undefined ? {} : { label: record.label }),
    selection: {
      ...publicSelection as Omit<IdentitySelection, 'network' | 'sdkNetwork'>,
      rootPublicKeyFingerprint: createHash('sha256').update(Buffer.from(record.selection.rootPublicKey, 'hex')).digest('hex'),
    },
    workflow: workflowMetadata(record),
  };
}

function streamError(error: unknown, fallback: IdentityWorkflowErrorCode): IdentityWorkflowErrorCode {
  if (error instanceof IdentityWorkflowError) return error.code;
  if (error instanceof IdentityProviderError && error.code === 'CONTEXT_MISMATCH') return 'CONTEXT_MISMATCH';
  return fallback;
}

function sameBlock(left: { hash: string; height: string; time: string }, right: { hash: string; height: string; time: string }): boolean {
  return left.hash === right.hash && left.height === right.height && left.time === right.time;
}

/** Construct encrypted identity orchestration shared by CLI and stdio MCP. */
export function createIdentityWorkflow(deps: IdentityWorkflowDependencies): IdentityWorkflow {
  const crypto = deps.crypto ?? defaultCrypto;
  const now = deps.now ?? Date.now;
  let persistenceTail = Promise.resolve();
  const queued = async <T>(operation: () => Promise<T>): Promise<T> => {
    const prior = persistenceTail;
    let release!: () => void;
    const next = new Promise<void>((resolve) => { release = resolve; });
    persistenceTail = next;
    await prior;
    try { return await operation(); } finally { release(); }
  };

  const loadContext = async (selection: Omit<IdentitySelection, 'sdkNetwork'>): Promise<IdentityContext> => {
    try {
      const context = await deps.loadContext(selection);
      if (context.ipInfo.ipIdentity !== selection.identityProviderIndex || selection.network !== context.network) {
        throw new IdentityWorkflowError('CONTEXT_MISMATCH');
      }
      return context;
    } catch (error) {
      if (error instanceof IdentityProviderError) throw new IdentityProviderError(error.code);
      throw workflowFailure(error, 'CONTEXT_MISMATCH');
    }
  };

  const resolveSource = (selector?: string): Promise<ResolvedIdentitySource> => deps.sources.resolve(selector);

  const withMaterial = async <T>(selection: IdentitySelection, sourceId: string, callback: Parameters<typeof withIdentityMaterial<T>>[1]) =>
    withIdentityMaterial({ selection, sourceId, sources: deps.sources,
      ...(deps.promptPin === undefined ? {} : { promptPin: deps.promptPin }) }, callback);

  const resolveNetwork = (selector?: string): Promise<string> => boundary('INVALID_INPUT', () => deps.resolveNetwork(selector));
  const listRecords = async (network: string): Promise<StoredIdentity[]> => boundary('STORAGE_FAILED', async () => {
    const records = await deps.store.list(network);
    if (records.some(record => record.selection.network !== network)) throw new Error();
    return records;
  });
  const resolveIdentityId = async (network: string, selector: string): Promise<string> => {
    if (!identitySelectorSchema.safeParse(selector).success) throw new IdentityWorkflowError('INVALID_INPUT');
    if (identityIdSchema.safeParse(selector).success) return selector;
    let record: StoredIdentity | undefined;
    try { record = findCatalogLabel(await listRecords(network), selector, candidate => candidate.label); }
    catch { throw new IdentityWorkflowError('INVALID_INPUT'); }
    if (!record) throw new IdentityWorkflowError('IDENTITY_NOT_FOUND');
    return record.id;
  };
  const loadRecord = async (network: string, selector: string): Promise<StoredIdentity> => boundary('STORAGE_FAILED', async () => {
    const parsedId = await resolveIdentityId(network, selector);
    const record = await deps.store.load(network, parsedId);
    if (record.id !== parsedId || record.selection.network !== network) throw new Error();
    return record;
  });
  const maybeLoadRecord = async (network: string, id: string): Promise<StoredIdentity | undefined> => {
    try { return await loadRecord(network, id); }
    catch (error) { if (error instanceof IdentityWorkflowError && error.code === 'IDENTITY_NOT_FOUND') return undefined; throw error; }
  };
  const createRecord = async (record: StoredIdentity) => boundary('STORAGE_FAILED', () => deps.store.create(record));
  const saveRecord = async (record: StoredIdentity, previous: StoredIdentity) => boundary('STORAGE_FAILED', () =>
    deps.store.save(record, workflowMetadata(previous)));
  const saveFailedRecord = async (record: StoredIdentity, previous: StoredIdentity): Promise<StoredIdentity> => {
    if (record.status === 'ready') throw new IdentityWorkflowError('INDEX_UNAVAILABLE');
    const requestAttemptId = record.requestAttemptId;
    if (requestAttemptId === undefined) {
      const updated: StoredIdentity = { ...record, status: 'error' };
      await saveRecord(updated, previous);
      return updated;
    }
    const updated: StoredIdentity & { status: 'error' } = {
      ...record, status: 'error',
      confirmedFailure: { kind: 'authenticated_key_failure', requestAttemptId },
    };
    await boundary('STORAGE_FAILED', () => deps.store.save(updated, workflowMetadata(previous), 'failed'));
    return updated;
  };
  const publicSummary = async (record: StoredIdentity): Promise<IdentitySummary> => {
    const base = summary(record);
    if (base.status === 'failed' || base.status === 'issued' || record.status === 'expired') return base;
    let status = base.status;
    if (record.requestAttemptId !== undefined && record.sourceId !== undefined) {
      const sourceId = record.sourceId;
      const index = await boundary('STORAGE_FAILED', () => deps.store.readIndex(record.selection.network));
      const reservation = await boundary('STORAGE_FAILED', () => deps.store.readIdentityRequestReservation({
        genesisHash: index.network.genesisHash, sourceId, sdkNetwork: index.network.sdkNetwork,
        identityProviderIndex: record.selection.identityProviderIndex,
        identityIndex: record.selection.identityIndex,
      }));
      const active = reservation?.state === 'reserved' || reservation?.state === 'used';
      if (active && reservation !== undefined) {
        const timeout = await boundary('STORAGE_FAILED', () => deps.getIdentityRequestTimeoutMs?.(record.selection.network) ?? 86_400_000);
        status = now() - reservation.reservedAt >= timeout ? 'unknown' : 'pending';
      } else if (record.status === 'error') status = 'unknown';
    }
    const url = record.authorizationUrl ?? (record.postIssuance?.status === 'created' ? record.postIssuance.url : undefined);
    return { ...base, status, ...(status === 'pending' && url !== undefined ? { authorizationUrl: url } : {}) };
  };
  const setLabel = async (input: IdentityLabelInput, authority: 'operator' | 'agent'): Promise<IdentitySummary> => {
    const parsed = identityLabelInputSchema.safeParse(input);
    if (!parsed.success) throw new IdentityWorkflowError('INVALID_INPUT');
    const operation = parsed.data.operation ?? 'set';
    if (parsed.data.mode !== undefined && authority === 'agent'
      || operation === 'remove' && (parsed.data.label !== undefined || parsed.data.mode !== undefined)
      || authority === 'agent' && operation === 'set' && parsed.data.label === undefined) {
      throw new IdentityWorkflowError('INVALID_INPUT');
    }
    const network = await resolveNetwork(parsed.data.network);
    const identityId = await resolveIdentityId(network, parsed.data.identityId);
    const current = await loadRecord(network, identityId);
    let label: string | undefined;
    try {
      label = prepareCatalogLabelMutation({
        ...(current.label === undefined ? {} : { current: current.label }), operation,
        ...(parsed.data.label === undefined ? {} : { label: parsed.data.label }),
        ...(parsed.data.mode === undefined ? {} : { mode: parsed.data.mode }),
        softOnly: authority === 'agent',
      })!;
    } catch (error) {
      if (error instanceof CatalogLabelError && error.code === 'LABEL_PROTECTED') {
        throw new IdentityWorkflowError('LABEL_PROTECTED');
      }
      if (error instanceof CatalogLabelError && error.code === 'LABEL_REQUIRED') {
        throw new IdentityWorkflowError('LABEL_REQUIRED');
      }
      throw new IdentityWorkflowError('INVALID_INPUT');
    }
    if (label === current.label) return publicSummary(current);
    const assignment = operation === 'remove'
      ? { authority, operation } as const
      : { authority, label: label! } as const;
    const updated = await boundary('STORAGE_FAILED', () => deps.store.setIdentityLabel({ network, identityId, ...assignment }));
    return publicSummary(updated);
  };
  const bootstrap = async (context: IdentityContext) => boundary('STORAGE_FAILED', () => deps.store.bootstrapNetwork(networkMetadata(context)));
  const requireAssociated = (record: StoredIdentity): string => {
    if (!record.sourceId) throw new IdentityWorkflowError('SOURCE_NOT_ASSOCIATED');
    return record.sourceId;
  };
  const verifyRecordContext = (record: StoredIdentity, context: IdentityContext): void => {
    if (context.sdkNetwork !== record.selection.sdkNetwork || identityContextHash(context) !== record.contextHash) {
      throw new IdentityWorkflowError('CONTEXT_MISMATCH');
    }
  };
  const recoveryRequest = (context: IdentityContext, material: IdentityMaterial) => {
    const request = crypto.recovery({
      ipInfo: context.ipInfo, globalContext: context.globalContext, timestamp: Math.floor(now() / 1000),
      idCredSec: material.idCredSec.toString('hex'),
    });
    if (request.v !== 0 || hexString.from(request.value.idCredPub)?.length !== 96) {
      throw new IdentityWorkflowError('CRYPTO_FAILED');
    }
    return request;
  };
  const probeIdentity = async (context: IdentityContext, source: ResolvedIdentitySource, selection: IdentitySelection,
    options: { publicRecovery?: boolean; useLocalIdentity?: boolean; recoveredIdentity?: Versioned<IdentityObjectV1>; initialLabel?: string },
  ): Promise<{ used: false } | { used: true; record: StoredIdentity & { status: 'ready' } }> => {
    return withMaterial(selection, source.id, async (_seed, material, storage) => {
      const id = storage.fileId;
      const existing = await maybeLoadRecord(context.network, id);
      let decrypted: StoredIdentity | undefined;
      if (existing) {
        if (!existing.sourceId) throw new IdentityWorkflowError('SOURCE_NOT_ASSOCIATED');
        if (existing.sourceId !== source.id || existing.selection.rootPublicKey !== source.rootPublicKey
          || existing.selection.identityProviderIndex !== selection.identityProviderIndex
          || existing.selection.identityIndex !== selection.identityIndex || existing.contextHash !== identityContextHash(context)) {
          throw new IdentityWorkflowError('CONTEXT_MISMATCH');
        }
        try {
          bindIdentity(existing, await deps.store.loadIdentity(context.network, id, storage.encryptionKey));
          decrypted = existing;
        } catch (error) {
          if ((error as { code?: unknown })?.code !== 'IDENTITY_FILE_MISSING') throw error;
        }
        if (decrypted && options.publicRecovery) throw new IdentityWorkflowError('IDENTITY_ALREADY_EXISTS');
        if (decrypted && options.useLocalIdentity && existing.status === 'ready') {
          const issued = issuedIdentity(existing, existing.identity);
          if (!isDeepStrictEqual(workflowMetadata(issued), workflowMetadata(existing))) await saveRecord(issued, existing);
          return { used: true, record: issued };
        }
      }
      const request = recoveryRequest(context, material);
      if (existing && existing.idCredPub !== request.value.idCredPub) throw new IdentityWorkflowError('CONTEXT_MISMATCH');
      let recovered: Versioned<IdentityObjectV1>;
      try { recovered = options.recoveredIdentity ?? await deps.provider.recover(context.recoveryUrl, request); }
      catch (error) {
        if (error instanceof IdentityWorkflowError && error.code === 'IDENTITY_NOT_FOUND') return { used: false };
        throw workflowFailure(error, 'PROVIDER_FAILED');
      }
      const identity = bindIdentity({ idCredPub: request.value.idCredPub }, recovered);
      if (existing) bindIdentity(existing, identity);
      const record = issuedIdentity(existing ?? {
        version: 1, id, sourceId: source.id, selection, contextHash: identityContextHash(context),
        label: options.initialLabel ?? defaultIdentityLabel(source.id, selection.identityProviderIndex, selection.identityIndex),
        idCredPub: request.value.idCredPub, status: 'awaiting_verification',
      }, identity);
      await queued(async () => {
        await boundary('STORAGE_FAILED', () => deps.store.reserveIdentityIndex({ ...reservationScope(context, source.id),
          identityIndex: selection.identityIndex, mode: 'used' }));
        if (!decrypted) {
          await bootstrap(context);
          await boundary('STORAGE_FAILED', () => existing
            ? deps.store.restoreIdentity(networkMetadata(context), id, indexRecord(record, source.id), identity,
              storage.encryptionKey, workflowMetadata(existing))
            : deps.store.createIdentity(networkMetadata(context), id, indexRecord(record, source.id), identity, storage.encryptionKey, null));
        } else if (decrypted.status !== 'ready') await saveRecord(record, decrypted);
      });
      return { used: true, record };
    });
  };
  const knownRecords = async (context: IdentityContext, source: ResolvedIdentitySource) =>
    (await listRecords(context.network)).filter(record => record.selection.rootPublicKey === source.rootPublicKey
      && record.selection.identityProviderIndex === context.ipInfo.ipIdentity);
  const reconcileIdentityReservations = async (context: IdentityContext, source: ResolvedIdentitySource) => {
    const scope = reservationScope(context, source.id);
    const timeout = await boundary('STORAGE_FAILED', () => deps.getIdentityRequestTimeoutMs?.(context.network) ?? 86_400_000);
    const expired = await boundary('STORAGE_FAILED', () => deps.store.listExpiredIdentityReservations(scope, now(), timeout));
    if (expired.length === 0) return;
    const records = await knownRecords(context, source);
    for (const reservation of expired) {
      try {
        const record = records.find(value => value.selection.identityIndex === reservation.identityIndex);
        let recoveredIdentity: Versioned<IdentityObjectV1> | undefined;
        const statusUrl = record === undefined ? undefined : postIssuanceStatusUrl(record, context);
        if (record !== undefined && statusUrl !== undefined && record.status !== 'ready') {
          verifyRecordContext(record, context);
          const polled = await boundary('PROVIDER_FAILED', () => deps.provider.pollIssuanceContext(statusUrl));
          if (polled.status === 'pending') continue;
          if (polled.status === 'error') throw new IdentityWorkflowError('DISCOVERY_INCOMPLETE');
          recoveredIdentity = polled.identity;
        } else if (record?.retrievalUrl) {
          verifyRecordContext(record, context);
          if (safeHttpUrl(record.retrievalUrl).origin !== safeHttpUrl(context.issuanceUrl).origin) {
            throw new IdentityWorkflowError('INVALID_INPUT');
          }
          const retrieved = await boundary('PROVIDER_FAILED', () => deps.provider.retrieve(record.retrievalUrl!));
          if (retrieved.status === 'pending') continue;
          if (retrieved.status === 'error' && retrieved.failure === 'unconfirmed') throw new IdentityWorkflowError('DISCOVERY_INCOMPLETE');
          if (retrieved.status === 'error' && retrieved.failure === 'key_failed') {
            await saveFailedRecord(record, record);
            continue;
          }
          if (retrieved.status === 'done') recoveredIdentity = retrieved.identity;
        }
        const result = await probeIdentity(context, source, {
          network: context.network, sdkNetwork: context.sdkNetwork, rootPublicKey: source.rootPublicKey,
          identityProviderIndex: scope.identityProviderIndex, identityIndex: reservation.identityIndex,
        }, { useLocalIdentity: true, ...(recoveredIdentity === undefined ? {} : { recoveredIdentity }) });
        if (!result.used) await deps.store.resolveIdentityReservation({ ...scope, ...reservation, state: 'released',
          expectedWorkflow: record ? workflowMetadata(record) : null });
      } catch (error) {
        if (error instanceof IdentitySourceError || error instanceof IdentityWorkflowError
          && ['STORAGE_FAILED', 'AUTHORIZATION_REQUIRED', 'CRYPTO_FAILED'].includes(error.code)) throw error;
        if (error instanceof IdentityWorkflowError && error.code === 'INDEX_UNAVAILABLE') continue;
        // No definitive absence: preserve the reservation and report the incomplete check.
        throw new IdentityWorkflowError('DISCOVERY_INCOMPLETE');
      }
    }
  };
  const discoverIdentityStream = async (network: string, source: ResolvedIdentitySource, providerIndex: number,
    gapLimit: number, endIndex?: number, prepared?: { context: IdentityContext; reservations: number[] }, startIndex?: number,
  ): Promise<DiscoveryStreamResult & { identityProviderIndex: number }> => {
    const base = { network, rootPublicKey: source.rootPublicKey, identityProviderIndex: providerIndex };
    let context: IdentityContext;
    try { context = prepared?.context ?? await loadContext({ ...base, identityIndex: 0 }); }
    catch (error) {
      return { identityProviderIndex: providerIndex, used: [], reserved: [], unused: [], scannedRange: { start: startIndex ?? 0 },
        partial: true, stopReason: 'error', errorCode: streamError(error, 'PROVIDER_FAILED') };
    }
    if (!prepared) {
      try { await bootstrap(context); }
      catch (error) {
        return { identityProviderIndex: providerIndex, used: [], reserved: [], unused: [], scannedRange: { start: startIndex ?? 0 },
          partial: true, stopReason: 'error', errorCode: streamError(error, 'STORAGE_FAILED') };
      }
    }
    const scope = reservationScope(context, source.id);
    let reservations: number[];
    let records: StoredIdentity[];
    try { reservations = prepared?.reservations ?? await boundary('STORAGE_FAILED', () => deps.store.listIdentityReservations(scope)); }
    catch (error) {
      return { identityProviderIndex: providerIndex, used: [], reserved: [], unused: [], scannedRange: { start: startIndex ?? 0 },
        partial: true, stopReason: 'error', errorCode: streamError(error, 'STORAGE_FAILED') };
    }
    try {
      if (!prepared) {
        await reconcileIdentityReservations(context, source);
        reservations = await deps.store.listIdentityReservations(scope);
      }
      records = await knownRecords(context, source);
    } catch (error) {
      return { identityProviderIndex: providerIndex, used: [], reserved: reservations, unused: [], scannedRange: { start: startIndex ?? 0 },
        partial: true, stopReason: 'error', errorCode: streamError(error, 'STORAGE_FAILED') };
    }
    const occupied = new Set(reservations);
    const highWater = reservations.length === 0 ? -1 : Math.max(...reservations);
    const lower = startIndex ?? 0;
    const bound: { end: number; stopReason: 'range' | 'limit' } = endIndex === undefined
      ? { end: MAX_INDEX, stopReason: 'limit' } : { end: endIndex, stopReason: 'range' };
    const { end } = bound;
    const skipKnown = startIndex === undefined;
    const ready = new Set(records.filter(record => record.status === 'ready').map(record => record.selection.identityIndex));
    const known = reservations.filter(index => index >= lower && index <= end);
    const used = skipKnown ? known.filter(index => ready.has(index)) : [];
    const reserved = skipKnown ? known.filter(index => !ready.has(index)) : [];
    const unused: number[] = [];
    let start = lower;
    if (skipKnown) while (start <= end && occupied.has(start)) start += 1;
    let misses = 0;
    let last: number | undefined;
    for (let identityIndex = start; identityIndex <= end; identityIndex += 1) {
      if (skipKnown && occupied.has(identityIndex)) { misses = 0; continue; }
      try {
        const found = await probeIdentity(context, source, { ...base, sdkNetwork: context.sdkNetwork, identityIndex }, {});
        last = identityIndex;
        if (found.used) { used.push(identityIndex); misses = 0; }
        else if (occupied.delete(identityIndex)) { reserved.push(identityIndex); misses = 0; }
        else { unused.push(identityIndex); misses += 1; }
      } catch (error) {
        return { identityProviderIndex: providerIndex, used: used.sort(numericOrder),
          reserved: [...new Set([...reserved, ...known.filter(index => !used.includes(index))])].sort(numericOrder), unused,
          scannedRange: last === undefined ? { start } : { start, end: last }, partial: true,
          stopReason: 'error', errorCode: streamError(error, 'PROVIDER_FAILED') };
      }
      const stopReason = getDiscoveryStopReason({
        index: identityIndex, upperBound: MAX_INDEX, ...(endIndex === undefined ? {} : { endIndex }),
        highWater, misses, gapLimit,
      });
      if (stopReason) {
        return { identityProviderIndex: providerIndex, used: used.sort(numericOrder), reserved: reserved.sort(numericOrder), unused,
          scannedRange: { start, end: identityIndex }, ...(stopReason === 'gap' ? { nextIndex: identityIndex + 1 } : {}),
          partial: false, stopReason };
      }
    }
    return { identityProviderIndex: providerIndex, used, reserved, unused,
      scannedRange: last === undefined ? { start } : { start, end: last }, partial: false,
      stopReason: bound.stopReason };
  };
  const discoverIdentities = async (input: DiscoverIdentitiesInput): Promise<IdentityDiscoveryResult> => {
    const parsed = identityDiscoveryInputSchema.safeParse(input);
    if (!parsed.success) throw new IdentityWorkflowError('INVALID_INPUT');
    const network = await resolveNetwork(parsed.data.network);
    const source = await resolveSource(parsed.data.source);
    const enabled = [...new Set(await deps.listEnabledProviders(network))].sort(numericOrder);
    const providers = parsed.data.identityProviderIndex === undefined ? enabled : [parsed.data.identityProviderIndex];
    if (providers.some((provider) => !enabled.includes(provider))) throw new IdentityProviderError('PROVIDER_DISABLED');
    const gapLimit = parsed.data.gapLimit ?? DEFAULT_GAP;
    const streams: IdentityDiscoveryResult['streams'] = [];
    for (let offset = 0; offset < providers.length; offset += 4) {
      streams.push(...await Promise.all(providers.slice(offset, offset + 4)
        .map((provider) => discoverIdentityStream(network, source, provider, gapLimit, parsed.data.endIndex, undefined, parsed.data.startIndex))));
    }
    streams.sort((a, b) => a.identityProviderIndex - b.identityProviderIndex);
    return { network, sourceId: source.id, gapLimit, streams };
  };

  const recoverAttempt = async (
    record: StoredIdentity,
    expectedAttemptId: string,
    stopAtDeadline: boolean,
  ): Promise<IdentitySummary> => {
    if (record.status === 'ready' || record.requestAttemptId !== expectedAttemptId
      || record.status === 'expired' || record.confirmedFailure !== undefined) {
      throw new IdentityWorkflowError('INDEX_UNAVAILABLE');
    }
    if (stopAtDeadline) {
      const projected = await publicSummary(record);
      if (projected.status === 'unknown') return projected;
    }
    const sourceId = requireAssociated(record);
    const context = await loadContext(record.selection);
    verifyRecordContext(record, context);
    return withMaterial(record.selection, sourceId, async (_seed, material, storage) => {
      if (storage.fileId !== record.id) throw new IdentityWorkflowError('IDENTITY_MISMATCH');
      let recovered: Versioned<IdentityObjectV1>;
      try {
        const statusUrl = postIssuanceStatusUrl(record, context);
        if (statusUrl !== undefined) {
          const polled = await deps.provider.pollIssuanceContext(statusUrl);
          if (polled.status === 'pending') return publicSummary(record);
          if (polled.status === 'error') throw new IdentityWorkflowError('PROVIDER_FAILED');
          recovered = polled.identity;
        } else {
          recovered = await deps.provider.recover(context.recoveryUrl, recoveryRequest(context, material));
        }
      }
      catch (error) {
        if (error instanceof IdentityWorkflowError && error.code === 'IDENTITY_NOT_FOUND') return publicSummary(record);
        throw workflowFailure(error, 'PROVIDER_FAILED');
      }
      const identity = bindIdentity(record, recovered);
      const latest = await loadRecord(record.selection.network, record.id);
      if (latest.requestAttemptId !== expectedAttemptId || !isDeepStrictEqual(workflowMetadata(latest), workflowMetadata(record))) {
        throw new IdentityWorkflowError('INDEX_UNAVAILABLE');
      }
      const updated = issuedIdentity(latest);
      await boundary('STORAGE_FAILED', () => deps.store.createIdentity(
        networkMetadata(context), record.id, indexRecord(updated, sourceId), identity,
        storage.encryptionKey, workflowMetadata(record),
      ));
      return summary(updated);
    });
  };

  const withCredentialMaterial = async <T>(record: StoredIdentity, context: IdentityContext, callback: (
    maximum: number, credentialId: (credentialIndex: number) => string,
  ) => Promise<T>): Promise<T> => {
    const sourceId = requireAssociated(record);
    return withMaterial(record.selection, sourceId, async (seed, _material, storage) => {
      if (storage.fileId !== record.id) throw new IdentityWorkflowError('IDENTITY_MISMATCH');
      const identity = bindIdentity(record, await deps.store.loadIdentity(context.network, record.id, storage.encryptionKey));
      const maximum = Math.min(identity.value.attributeList.maxAccounts, 256);
      return callback(maximum, (credentialIndex) => deriveCredentialRegistrationId({
        seed, network: record.selection.sdkNetwork, identityProviderIndex: record.selection.identityProviderIndex,
        identityIndex: record.selection.identityIndex, credentialIndex,
        onChainCommitmentKey: context.globalContext.onChainCommitmentKey,
      }));
    });
  };

  const discoverCredentials = async (
    input: DiscoverAccountCredentialsInput, only?: number,
    prepared?: { network: string; record: StoredIdentity; context: IdentityContext },
  ): Promise<CredentialDiscoveryResult> => {
    const parsed = credentialDiscoveryInputSchema.safeParse(input);
    if (!parsed.success) throw new IdentityWorkflowError('INVALID_INPUT');
    const network = prepared?.network ?? await resolveNetwork(parsed.data.network);
    const record = prepared?.record ?? await loadRecord(network, parsed.data.identityId);
    requireAssociated(record);
    if (record.status !== 'ready') throw new IdentityWorkflowError('IDENTITY_NOT_READY');
    const context = prepared?.context ?? await loadContext(record.selection);
    verifyRecordContext(record, context);
    return withCredentialMaterial(record, context, async (maximum, credentialId) => {
      const start = only ?? (parsed.data.full === true ? 0 : (parsed.data.startCredentialNumber ?? 0));
      const requestedEnd = only ?? (parsed.data.full === true ? maximum - 1 : parsed.data.endCredentialNumber);
      if (start >= maximum || (requestedEnd !== undefined && requestedEnd >= maximum)) {
        throw new IdentityWorkflowError('CREDENTIAL_LIMIT');
      }
      const end = requestedEnd ?? maximum - 1;
      const exhaustive = requestedEnd !== undefined;
      const skipKnown = only === undefined && parsed.data.full !== true && parsed.data.startCredentialNumber === undefined;
      const registry = await boundary('STORAGE_FAILED', () => deps.store.loadCredentials(network));
      const local = new Map(Object.values(registry.credentials).filter((entry) => entry.identityId === record.id)
        .map((entry) => [entry.credentialNumber, entry]));
      const selectedKnown = [...local.entries()].filter(([value]) => value >= start && value <= end);
      const highWater = selectedKnown.length === 0 ? start - 1 : Math.max(...selectedKnown.map(([value]) => value));
      const gapLimit = parsed.data.gapLimit ?? DEFAULT_GAP;
      const used = new Set<number>();
      const reserved = new Set<number>();
      for (const [credentialNumber, entry] of selectedKnown) {
        (entry.status === 'confirmed' ? used : reserved).add(credentialNumber);
      }
      const unused: number[] = [];
      let sourceBlock: CredentialDiscoveryResult['sourceBlock'];
      let misses = 0;
      let last: number | undefined;
      let cursor = start;
      let firstQueried: number | undefined;
      let observer: Awaited<ReturnType<IdentityWorkflowDependencies['createAccountObserver']>> | undefined;
      const sorted = (values: Set<number>): number[] => [...values].sort(numericOrder);
      const scannedRange = (): { start: number; end?: number } => ({
        start: firstQueried ?? Math.min(end + 1, maximum),
        ...(last === undefined ? {} : { end: last }),
      });
      const result = (stopReason: 'gap' | 'range' | 'limit', nextIndex?: number): CredentialDiscoveryResult => ({
        network, identityId: record.id, gapLimit, ...(sourceBlock === undefined ? {} : { sourceBlock }), stream: {
          used: sorted(used), reserved: sorted(reserved), unused, scannedRange: scannedRange(),
          ...(nextIndex === undefined ? {} : { nextIndex }), partial: false, stopReason,
        },
      });
      const failed = (error: unknown): CredentialDiscoveryResult => ({
        network, identityId: record.id, gapLimit, ...(sourceBlock === undefined ? {} : { sourceBlock }), stream: {
          used: sorted(used), reserved: sorted(reserved), unused, scannedRange: scannedRange(),
          partial: true, stopReason: 'error', errorCode: streamError(error, 'NETWORK_FAILED'),
        },
      });
      while (true) {
        if (cursor > end) return result(exhaustive ? 'range' : 'limit');
        if (skipKnown && local.has(cursor)) {
          misses = 0;
          cursor += 1;
          continue;
        }
        const numbers: number[] = [];
        let candidate = cursor;
        let worstCaseMisses = misses;
        while (candidate <= end && numbers.length < 4) {
          if (skipKnown && local.has(candidate)) break;
          numbers.push(candidate);
          if (!exhaustive && candidate >= highWater) {
            worstCaseMisses += 1;
            if (worstCaseMisses >= gapLimit) break;
          }
          candidate += 1;
        }
        firstQueried ??= numbers[0];
        if (observer === undefined) {
          try { observer = await deps.createAccountObserver(network); }
          catch (error) { return failed(error); }
        }
        const activeObserver = observer;
        const credentialIds = numbers.map(credentialId);
        const observations = await Promise.allSettled(numbers.map((credentialNumber, offset) =>
          activeObserver({ type: 'credentialId', credentialId: credentialIds[offset]! })));
        for (let offset = 0; offset < numbers.length; offset += 1) {
          const credentialNumber = numbers[offset]!;
          const selectedCredentialId = credentialIds[offset]!;
          try {
            const settled = observations[offset]!;
            if (settled.status === 'rejected') throw settled.reason;
            const observed = settled.value;
            if (observed.genesisHash !== context.genesisHash || sourceBlock && !sameBlock(sourceBlock, observed.sourceBlock)) {
              throw new IdentityWorkflowError('NETWORK_FAILED');
            }
            sourceBlock ??= observed.sourceBlock;
            if (observed.exists) {
              AccountAddress.fromBase58(observed.canonicalAddress);
              if (!sameBlock(observed.sourceBlock, observed.observation.sourceBlock)) throw new IdentityWorkflowError('NETWORK_FAILED');
              reserved.delete(credentialNumber);
              used.add(credentialNumber);
              misses = 0;
              await boundary('STORAGE_FAILED', () => deps.store.withMutation(network, async () => {
                const latest = await deps.store.loadCredentials(network);
                latest.credentials[selectedCredentialId] = { identityId: record.id, credentialNumber, status: 'confirmed' };
                await boundary('STORAGE_FAILED', () => deps.store.saveCredentials(network, latest));
              }));
            } else if (local.has(credentialNumber)) {
              used.delete(credentialNumber);
              reserved.add(credentialNumber);
              misses = 0;
            } else {
              unused.push(credentialNumber);
              misses += 1;
            }
            last = credentialNumber;
          } catch (error) { return failed(error); }
          if (exhaustive && credentialNumber >= end) return result('range');
          if (!exhaustive && credentialNumber >= maximum - 1) return result('limit');
          if (!exhaustive && credentialNumber >= highWater && misses >= gapLimit) {
            return result('gap', credentialNumber + 1);
          }
        }
        cursor = numbers[numbers.length - 1]! + 1;
      }
    });
  };

  return {
    setOperatorIdentityLabel: input => setLabel(input, 'operator'),
    setAgentIdentityLabel: input => setLabel(input, 'agent'),
    async request(input: IdentityRequestInput) {
      const parsed = identityRequestInputSchema.safeParse(input);
      if (!parsed.success) throw new IdentityWorkflowError('INVALID_INPUT');
      if (parsed.data.mode !== undefined && parsed.data.label === undefined) {
        throw new IdentityWorkflowError('INVALID_INPUT');
      }
      let requestedLabel: string | undefined;
      if (parsed.data.label !== undefined) {
        requestedLabel = prepareCatalogLabelMutation({
          operation: 'set', label: parsed.data.label, ...(parsed.data.mode === undefined ? {} : { mode: parsed.data.mode }),
        });
      }
      const network = await resolveNetwork(parsed.data.network);
      const source = await resolveSource(parsed.data.source);
      if (parsed.data.identityIndex === undefined) {
        const enabled = await deps.listEnabledProviders(network);
        if (!enabled.includes(parsed.data.identityProviderIndex)) throw new IdentityProviderError('PROVIDER_DISABLED');
      }
      const provisional = { network, rootPublicKey: source.rootPublicKey, identityProviderIndex: parsed.data.identityProviderIndex,
        identityIndex: parsed.data.identityIndex ?? 0 };
      let context: IdentityContext;
      try { context = await loadContext(provisional); }
      catch { throw new IdentityWorkflowError('DISCOVERY_INCOMPLETE'); }
      await bootstrap(context);
      const scope = reservationScope(context, source.id);
      await reconcileIdentityReservations(context, source);
      let identityIndex: number;
      let allocation: { mode: 'next'; expectedHighWater: number } | { mode: 'explicit' };
      if (parsed.data.identityIndex === undefined) {
        const reservations = await boundary('STORAGE_FAILED', () => deps.store.listIdentityReservations(scope));
        getNextIdentityIndex(reservations);
        const stream = await discoverIdentityStream(network, source, parsed.data.identityProviderIndex, DEFAULT_GAP,
          undefined, { context, reservations });
        if (stream.partial) throw new IdentityWorkflowError('DISCOVERY_INCOMPLETE');
        identityIndex = getNextIdentityIndex([...stream.used, ...stream.reserved]);
        // A complete implicit scan proves the index after its occupied high-water mark unused.
        allocation = { mode: 'next', expectedHighWater: identityIndex - 1 };
      } else {
        identityIndex = parsed.data.identityIndex;
        allocation = { mode: 'explicit' };
      }
      const initial = { network, rootPublicKey: source.rootPublicKey, identityProviderIndex: parsed.data.identityProviderIndex, identityIndex };
      const selection: IdentitySelection = { ...initial, sdkNetwork: context.sdkNetwork };
      if (allocation.mode === 'explicit') {
        const occupied = await deps.store.listIdentityReservations(scope);
        const localReady = (await knownRecords(context, source)).some(record => record.selection.identityIndex === identityIndex && record.status === 'ready');
        if (occupied.includes(identityIndex) && !localReady) throw new IdentityWorkflowError('INDEX_UNAVAILABLE');
        let found;
        try { found = await probeIdentity(context, source, selection, { useLocalIdentity: true,
          ...(requestedLabel === undefined ? {} : { initialLabel: requestedLabel }) }); }
        catch (error) {
          if (error instanceof IdentitySourceError) throw error;
          if (error instanceof IdentityWorkflowError
            && (error.code === 'AUTHORIZATION_REQUIRED' || error.code === 'CRYPTO_FAILED')) throw error;
          throw new IdentityWorkflowError('DISCOVERY_INCOMPLETE');
        }
        if (found.used) return { ...summary(found.record), outcome: 'identity_already_exists', status: 'issued' };
      }
      const anonymityRevocation = resolveAnonymityRevocationPolicy(
        context.anonymityRevocation ?? {}, context.arsInfos,
      );
      await boundary('STORAGE_FAILED', () => deps.store.reserveIdentityIndex({ ...scope, identityIndex, ...allocation }));
      return withMaterial(selection, source.id, async (_seed, material, storage) => {
        const result = crypto.request({
          ipInfo: context.ipInfo, globalContext: context.globalContext,
          arsInfos: anonymityRevocation.arsInfos, arThreshold: anonymityRevocation.arThreshold,
          idCredSec: material.idCredSec.toString('hex'), prfKey: material.prfKey.toString('hex'),
          blindingRandomness: material.signatureBlindingRandomness.toString('hex'),
        });
        const id = storage.fileId;
        const previous = await maybeLoadRecord(network, id);
        const label = previous ? previous.label
          : requestedLabel ?? defaultIdentityLabel(source.id, selection.identityProviderIndex, selection.identityIndex);
        let authorizationUrl: string | undefined;
        if (context.issuance?.method !== 'POST') {
          const url = safeHttpUrl(context.issuanceUrl);
          url.searchParams.set('state', JSON.stringify({ idObjectRequest: result }));
          url.searchParams.set('redirect_uri', `ccd-id-manager://identity/${id}`);
          authorizationUrl = url.href;
        }
        const record: StoredIdentity = {
          version: 1, id, sourceId: source.id, selection, contextHash: identityContextHash(context),
          ...(label === undefined ? {} : { label }),
          idCredPub: result.value.idCredPub, status: 'awaiting_verification', request: result,
          requestAttemptId: randomUUID(),
          ...(authorizationUrl === undefined ? {} : { authorizationUrl }),
          ...(context.issuance?.method === 'POST' ? { postIssuance: { status: 'unconfirmed' as const } } : {}),
        };
        if (previous) {
          verifyRecordContext(previous, context);
          if (previous.status === 'ready' || previous.sourceId !== source.id || previous.idCredPub !== record.idCredPub
            || previous.selection.rootPublicKey !== selection.rootPublicKey
            || previous.selection.identityProviderIndex !== selection.identityProviderIndex
            || previous.selection.identityIndex !== selection.identityIndex) throw new IdentityWorkflowError('CONTEXT_MISMATCH');
          await saveRecord({ ...record, selection: previous.selection }, previous);
        } else await createRecord(record);
        if (context.issuance?.method === 'POST') {
          let created;
          try {
            const issuance = await deps.provider.createIssuanceContext(
              context.issuanceUrl, result, context.network,
            );
            created = { status: 'created' as const, url: issuance.url, statusUrl: issuance.statusUrl };
          } catch (error) { throw workflowFailure(error, 'PROVIDER_FAILED'); }
          const updated: StoredIdentity = { ...record, postIssuance: created };
          await saveRecord(updated, record);
          return { ...summary(updated), authorizationUrl: created.url, outcome: 'requested', status: 'pending' };
        }
        return {
          ...summary(record), authorizationUrl: authorizationUrl!,
          outcome: 'requested', status: 'pending',
        };
      });
    },

    async recover(input: IdentityRecoveryInput) {
      const parsed = identityRecoveryInputSchema.safeParse(input);
      if (!parsed.success) throw new IdentityWorkflowError('INVALID_INPUT');
      const network = await resolveNetwork(parsed.data.network);
      const source = await resolveSource(parsed.data.source);
      const initial = { network, rootPublicKey: source.rootPublicKey, identityProviderIndex: parsed.data.identityProviderIndex,
        identityIndex: parsed.data.identityIndex };
      const context = await loadContext(initial);
      await bootstrap(context);
      const selection: IdentitySelection = { ...initial, sdkNetwork: context.sdkNetwork };
      const scope = reservationScope(context, source.id);
      const reservations = await boundary('STORAGE_FAILED', () => deps.store.listIdentityReservations(scope));
      const result = await probeIdentity(context, source, selection, { publicRecovery: true });
      if (!result.used) throw new IdentityWorkflowError(reservations.includes(selection.identityIndex) ? 'DISCOVERY_INCOMPLETE' : 'IDENTITY_NOT_FOUND');
      return summary(result.record);
    },

    discoverIdentities,

    async monitorIdentity({ network, identityId, expectedAttemptId }) {
      const canonicalNetwork = await resolveNetwork(network);
      if (!identityIdSchema.safeParse(identityId).success) throw new IdentityWorkflowError('INVALID_INPUT');
      const record = await loadRecord(canonicalNetwork, identityId);
      return recoverAttempt(record, expectedAttemptId, true);
    },

    async discoverAccountCredentials(input: DiscoverAccountCredentialsInput) {
      return discoverCredentials(input);
    },

    async associateIdentitySource(input: AssociateIdentitySourceInput) {
      const parsed = identitySourceAssociationInputSchema.safeParse(input);
      if (!parsed.success) throw new IdentityWorkflowError('INVALID_INPUT');
      const network = await resolveNetwork(parsed.data.network);
      const record = await loadRecord(network, parsed.data.identityId);
      if (record.sourceId) throw new IdentityWorkflowError('ASSOCIATION_MISMATCH');
      let source: ResolvedIdentitySource;
      try { source = await resolveSource(parsed.data.source); }
      catch { throw new IdentityWorkflowError('ASSOCIATION_MISMATCH'); }
      if (source.rootPublicKey !== record.selection.rootPublicKey
        || record.selection.device !== undefined
          && !source.backends.some(reference => reference.backend === 'yubikey-piv'
            && reference.locations.some(location => location.serial === record.selection.device))) {
        throw new IdentityWorkflowError('ASSOCIATION_MISMATCH');
      }
      let context: IdentityContext;
      try {
        context = await loadContext(record.selection);
        verifyRecordContext(record, context);
      } catch { throw new IdentityWorkflowError('ASSOCIATION_MISMATCH'); }
      try {
        await withMaterial(record.selection, source.id, async (_seed, _material, storage) => {
          if (storage.fileId !== record.id) throw new IdentityWorkflowError('ASSOCIATION_MISMATCH');
          const request = recoveryRequest(context, _material);
          if (request.value.idCredPub !== record.idCredPub
            || record.request && request.value.idCredPub !== record.request.value.idCredPub) {
            throw new IdentityWorkflowError('ASSOCIATION_MISMATCH');
          }
          try { bindIdentity(record, await deps.store.loadIdentity(network, record.id, storage.encryptionKey)); }
          catch (error) {
            if (!(error instanceof IdentityWorkflowError && error.code === 'IDENTITY_FILE_MISSING')) throw error;
          }
        });
      } catch (error) {
        if (error instanceof IdentityWorkflowError && error.code === 'AUTHORIZATION_REQUIRED') throw error;
        throw new IdentityWorkflowError('ASSOCIATION_MISMATCH');
      }
      if (record.status === 'ready') {
        await boundary('STORAGE_FAILED', () => deps.store.reserveIdentityIndex({ ...reservationScope(context, source.id),
          identityIndex: record.selection.identityIndex, mode: 'used' }));
      }
      const updated = { ...record, sourceId: source.id };
      await saveRecord(updated, record);
      return summary(updated);
    },

    async status({ network, identityId, callbackUrl }) {
      const canonicalNetwork = await resolveNetwork(network);
      const record = await loadRecord(canonicalNetwork, identityId);
      const id = record.id;
      if (record.status === 'ready' || record.status === 'expired') return publicSummary(record);
      if (record.confirmedFailure !== undefined) return publicSummary(record);
      if (record.postIssuance?.status === 'unconfirmed') throw new IdentityWorkflowError('PROVIDER_FAILED');
      if (callbackUrl === undefined && record.retrievalUrl === undefined) {
        if (record.requestAttemptId !== undefined) return recoverAttempt(record, record.requestAttemptId, false);
        return publicSummary(record);
      }
      const sourceId = requireAssociated(record);
      const context = await loadContext(record.selection);
      verifyRecordContext(record, context);
      if (record.postIssuance?.status === 'created') return publicSummary(record);
      const retrievalUrl = callbackUrl === undefined ? record.retrievalUrl! : callbackRetrieval(callbackUrl, id, context.issuanceUrl);
      if (safeHttpUrl(retrievalUrl).origin !== safeHttpUrl(context.issuanceUrl).origin) throw new IdentityWorkflowError('INVALID_INPUT');
      const retrieved = await boundary('PROVIDER_FAILED', () => deps.provider.retrieve(retrievalUrl));
      if (retrieved.status === 'done') {
        const identity = bindIdentity(record, retrieved.identity);
        return withMaterial(record.selection, sourceId, async (_seed, _material, storage) => {
          if (storage.fileId !== id) throw new IdentityWorkflowError('IDENTITY_MISMATCH');
          const updated = issuedIdentity(record);
          await boundary('STORAGE_FAILED', () => deps.store.createIdentity(networkMetadata(context), id, indexRecord(updated, sourceId), identity, storage.encryptionKey,
            workflowMetadata(record)));
          return summary(updated);
        });
      }
      const updated: StoredIdentity = { ...record, retrievalUrl, status: retrieved.status };
      const persisted = retrieved.status === 'error' && retrieved.failure === 'key_failed'
        ? await saveFailedRecord(updated, record)
        : (await saveRecord(updated, record), updated);
      return publicSummary(persisted);
    },

    async list({ network }) {
      const canonicalNetwork = await resolveNetwork(network);
      return Promise.all((await listRecords(canonicalNetwork)).map(publicSummary));
    },

    async prepareAccount(input: PrepareAccountInput) {
      const parsed = accountOpeningInputSchema.safeParse(input);
      if (!parsed.success || input.expirySeconds <= Math.floor(now() / 1000)) throw new IdentityWorkflowError('INVALID_INPUT');
      const revealAttributes = canonicalRevealAttributes(parsed.data.revealAttributes);
      const publicKeys = Object.fromEntries(Object.entries(parsed.data.publicKeys).map(([keyIndex, publicKey]) => [
        Number(keyIndex), { schemeId: 'Ed25519' as const, verifyKey: ed25519PublicKey.require(publicKey) },
      ]));
      const network = await resolveNetwork(parsed.data.network);
      const record = await loadRecord(network, input.identityId);
      requireAssociated(record);
      if (record.status !== 'ready') throw new IdentityWorkflowError('IDENTITY_NOT_READY');
      const preRegistry = await boundary('STORAGE_FAILED', () => deps.store.loadCredentials(network));
      const entries = Object.values(preRegistry.credentials).filter((entry) => entry.identityId === record.id);
      if (entries.some((entry) => entry.status === 'pending')) throw new IdentityWorkflowError('ACCOUNT_OPENING_PENDING');
      if (input.credentialNumber !== undefined && entries.some((entry) => entry.credentialNumber === input.credentialNumber)) {
        throw new IdentityWorkflowError('CREDENTIAL_NUMBER_USED');
      }
      const context = await loadContext(record.selection);
      verifyRecordContext(record, context);
      const discovery = await discoverCredentials({ network, identityId: record.id,
        ...(input.credentialNumber === undefined ? {} : { endCredentialNumber: input.credentialNumber }) }, input.credentialNumber,
      { network, record, context });
      if (discovery.stream.partial) throw new IdentityWorkflowError('DISCOVERY_INCOMPLETE');
      if (input.credentialNumber !== undefined && discovery.stream.used.includes(input.credentialNumber)) {
        throw new IdentityWorkflowError('CREDENTIAL_NUMBER_USED');
      }
      const credentialNumber = input.credentialNumber ?? discovery.stream.unused[0];
      if (credentialNumber === undefined) throw new IdentityWorkflowError('CREDENTIAL_LIMIT');
      return boundary('STORAGE_FAILED', () => deps.store.withMutation(context.network, async () => {
        const registry = await deps.store.loadCredentials(context.network);
        const latest = Object.values(registry.credentials).filter((entry) => entry.identityId === record.id);
        if (latest.some((entry) => entry.status === 'pending')) throw new IdentityWorkflowError('ACCOUNT_OPENING_PENDING');
        if (latest.some((entry) => entry.credentialNumber === credentialNumber)) throw new IdentityWorkflowError('CREDENTIAL_NUMBER_USED');
        return withMaterial(record.selection, record.sourceId!, async (seed, material, storage) => {
          const identity = bindIdentity(record, await deps.store.loadIdentity(context.network, record.id, storage.encryptionKey));
          const currentMonth = new Date(now()).toISOString().slice(0, 7).replace('-', '');
          if (identity.value.attributeList.validTo < currentMonth) throw new IdentityWorkflowError('IDENTITY_NOT_READY');
          const maximum = Math.min(identity.value.attributeList.maxAccounts, 256);
          if (credentialNumber >= maximum) throw new IdentityWorkflowError('CREDENTIAL_LIMIT');
          const expectedRevealedAttributes: Record<string, string> = {};
          for (const name of revealAttributes) {
            const chosenAttributes = identity.value.attributeList.chosenAttributes as Record<string, unknown>;
            if (!Object.hasOwn(chosenAttributes, name) || typeof chosenAttributes[name] !== 'string') {
              throw new IdentityWorkflowError('INVALID_INPUT');
            }
            expectedRevealedAttributes[name] = chosenAttributes[name];
          }
          const expiry = TransactionExpiry.fromEpochSeconds(BigInt(input.expirySeconds));
          const openings: Buffer[] = [];
          try {
            const attributeRandomness: Record<string, string> = {};
            for (const [name, attribute] of Object.entries(AttributesKeys)) {
              if (typeof attribute !== 'number') continue;
              const opening = deriveAttributeRandomness({ seed, network: record.selection.sdkNetwork,
                identityProviderIndex: record.selection.identityProviderIndex, identityIndex: record.selection.identityIndex,
                credentialIndex: credentialNumber, attribute });
              openings.push(opening);
              attributeRandomness[name] = opening.toString('hex');
            }
            const result = crypto.credential({
              ipInfo: context.ipInfo, globalContext: context.globalContext, arsInfos: context.arsInfos,
              idObject: identity.value, credNumber: credentialNumber, revealedAttributes: revealAttributes,
              idCredSec: material.idCredSec.toString('hex'), prfKey: material.prfKey.toString('hex'),
              sigRetrievelRandomness: material.signatureBlindingRandomness.toString('hex'),
              credentialPublicKeys: { keys: publicKeys, threshold: parsed.data.credentialThreshold },
              attributeRandomness: attributeRandomness as CredentialInputNoSeed['attributeRandomness'],
            }, expiry);
            const credentialId = result.unsignedCdi.credId;
            if (!/^[0-9a-f]{96}$/.test(credentialId) || registry.credentials[credentialId]) throw new IdentityWorkflowError('CRYPTO_FAILED');
            const accountAddress = getAccountAddress(credentialId).toString();
            const handoff = buildAccountOpeningCredentialDeploymentHandoff({ messageExpiry: BigInt(input.expirySeconds), unsignedCdi: result.unsignedCdi });
            const preview = summarizeCredentialDeploymentSigningHandoff(handoff.credDeploymentHex);
            const revealedAttributes = preview.credential.revealedAttributes;
            if (!sameRevealedAttributes(expectedRevealedAttributes, revealedAttributes)) {
              throw new IdentityWorkflowError('CRYPTO_FAILED');
            }
            registry.credentials[credentialId] = { identityId: record.id, credentialNumber, status: 'pending',
              expectedAccountAddress: accountAddress, expirySeconds: input.expirySeconds };
            await boundary('STORAGE_FAILED', () => deps.store.saveCredentials(context.network, registry));
            return { network: context.network, credDeploymentHex: handoff.credDeploymentHex, accountAddress, credentialNumber,
              expirySeconds: input.expirySeconds,
              ...(Object.keys(revealedAttributes).length === 0 ? {} : {
                revealedAttributes,
                disclosureWarning: ACCOUNT_OPENING_DISCLOSURE_WARNING,
              }),
            };
          } finally { for (const opening of openings) opening.fill(0); }
        });
      }));
    },

    async reconcileAccountOpening({ network, identityId: selector }) {
      const canonicalNetwork = await resolveNetwork(network);
      const identityId = await resolveIdentityId(canonicalNetwork, selector);
      return deps.store.withMutation(canonicalNetwork, async () => {
        const index = await boundary('STORAGE_FAILED', () => deps.store.readIndex(canonicalNetwork));
        if (!index.identities[identityId]) throw new IdentityWorkflowError('STORAGE_FAILED');
        const registry = await boundary('STORAGE_FAILED', () => deps.store.loadCredentials(canonicalNetwork));
        const pending = Object.entries(registry.credentials).find(
          (candidate): candidate is [string, Extract<CredentialRegistryEntry, { status: 'pending' }>] =>
            candidate[1].identityId === identityId && candidate[1].status === 'pending',
        );
        if (!pending) return { network: canonicalNetwork, identityId, status: 'no_pending' as const };
        const [credentialId, entry] = pending;
        const observer = await boundary('NETWORK_FAILED', () => deps.createAccountObserver(canonicalNetwork));
        const observed = await boundary('NETWORK_FAILED', () => observer({ type: 'address', address: entry.expectedAccountAddress }));
        if (observed.genesisHash !== index.network.genesisHash) throw new IdentityWorkflowError('NETWORK_FAILED');
        if (observed.exists) {
          if (observed.canonicalAddress !== entry.expectedAccountAddress || !sameBlock(observed.sourceBlock, observed.observation.sourceBlock)) {
            throw new IdentityWorkflowError('NETWORK_FAILED');
          }
          const credentialMatches = Object.values(observed.observation.credentials).some((credential) => credential.credentialId === credentialId);
          if (!credentialMatches) throw new IdentityWorkflowError('NETWORK_FAILED');
          registry.credentials[credentialId] = { identityId, credentialNumber: entry.credentialNumber, status: 'confirmed' };
          await boundary('STORAGE_FAILED', () => deps.store.saveCredentials(canonicalNetwork, registry));
          return { network: canonicalNetwork, identityId, status: 'confirmed' as const, credentialNumber: entry.credentialNumber };
        }
        const sourceSeconds = Date.parse(observed.sourceBlock.time) / 1000;
        if (!Number.isFinite(sourceSeconds)) throw new IdentityWorkflowError('NETWORK_FAILED');
        if (sourceSeconds <= entry.expirySeconds) return { network: canonicalNetwork, identityId, status: 'pending' as const, credentialNumber: entry.credentialNumber };
        delete registry.credentials[credentialId];
        await boundary('STORAGE_FAILED', () => deps.store.saveCredentials(canonicalNetwork, registry));
        return { network: canonicalNetwork, identityId, status: 'expired' as const, credentialNumber: entry.credentialNumber };
      });
    },
  };
}
