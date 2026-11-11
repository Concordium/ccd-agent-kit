import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { constants } from 'node:fs';
import { access, chmod, lstat, mkdir, open, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  assertUniqueCatalogLabels, CatalogLabelError, getDataDir, IDENTITY_SOURCE_ID_PATTERN,
  getIdentityContextSnapshot, loadAccountCredentials, prepareCatalogLabelMutation, resolveAccountLabel,
  resolveNetwork, setAccountCredentialObservation, parseCatalogLabel,
} from '@ccd-agent-kit/config-utils';
import { caip2Reference, extractAccountCredentials, getBuiltinNetworkName } from '@ccd-agent-kit/sdk-utils';
import { serializeJsonFile } from '@ccd-agent-kit/mcp-utils';
import {
  AccountAddress, BlockHash, CredentialRegistrationId, TransactionHash, TransactionStatusEnum,
  VerificationRequestV1, isRpcError,
} from '@concordium/web-sdk';
import { ConcordiumGRPCNodeClient, credentials } from '@concordium/web-sdk/nodejs';
import { createIdentityWorkflow } from './identityWorkflow.js';
import { createIdentityProofService, type IdentityProofService } from './identityProofs.js';
import { withIdentityMaterial } from './identityMaterialSession.js';
import { parseIdentityLabel } from './identityLabels.js';
import { IdentityWorkflowError, workflowFailure } from './workflowErrors.js';
import { identityIdSchema, parseIdentityObject, parseStoredIdentity, safeHttpUrl } from './workflowValidation.js';
import { decryptIdentityEnvelope, encryptIdentityEnvelope } from './identityStorageCrypto.js';
import { boundedResponseJson } from './providers/http.js';
import { readFinalizedIdentityProviderContext } from './providers/node.js';
import { IdentityProviderError } from './providers/error.js';
import { createDefaultIdentityProviderService, resolveProviderNetwork } from './providers/serviceFactory.js';
import type { IdentityProviderService } from './providers/types.js';
import { deriveIdentitySourceId } from '@ccd-agent-kit/config-utils';
import { createDefaultIdentitySourceService } from './sources/runtime.js';
import type { IdentitySourceService } from './sources/types.js';
import type {
  AccountObserver, CredentialRegistry, EncryptedIdentityStore, IdentityContext, IdentityIndex, IdentityIndexRecord,
  IdentityContextSelection, IdentityNetworkMetadata, IdentityProviderClient, IdentityRetrieval, IdentitySelection, IdentityWorkflow,
  IdentityReservationScope, StoredIdentity,
} from './workflowTypes.js';

const REQUEST_TIMEOUT_MS = 10_000;
const WORKFLOW_KEYS = new Set([
  'status', 'contextHash', 'idCredPub', 'request', 'retrievalUrl', 'requestAttemptId', 'confirmedFailure',
  'authorizationUrl', 'postIssuance',
]);

function stateDirectory(network: string): string {
  return path.join(getDataDir(), 'id-manager', caip2Reference(network).toLowerCase());
}

async function ensureProtectedDirectory(directory: string): Promise<void> {
  for (const protectedDirectory of [getDataDir(), path.join(getDataDir(), 'id-manager'), directory]) {
    await mkdir(protectedDirectory, { recursive: true, mode: 0o700 });
    const details = await lstat(protectedDirectory);
    if (!details.isDirectory()) throw new Error();
  }
  await chmod(directory, 0o700);
}

function recordPath(directory: string, id: string): string {
  return path.join(directory, `${id}.json`);
}

async function assertRegularFile(filename: string): Promise<void> {
  const details = await lstat(filename);
  if (!details.isFile()) throw new Error();
}

function parseNetwork(value: unknown): IdentityNetworkMetadata {
  const candidate = value as Partial<IdentityNetworkMetadata> | undefined;
  if (!candidate || typeof candidate.caip2 !== 'string' || typeof candidate.genesisHash !== 'string'
    || !/^[0-9a-f]{64}$/.test(candidate.genesisHash)
    || candidate.caip2 !== `ccd:${candidate.genesisHash.slice(0, 32)}`) throw new Error();
  const expectedSdkNetwork = getBuiltinNetworkName(candidate.genesisHash) === 'mainnet' ? 'Mainnet' : 'Testnet';
  if (candidate.sdkNetwork !== expectedSdkNetwork) throw new Error();
  return candidate as IdentityNetworkMetadata;
}

function parseIndex(value: unknown): IdentityIndex {
  const index = value as IdentityIndex;
  if (!index || index.version !== 1 || typeof index.identities !== 'object' || index.identities === null || Array.isArray(index.identities)) throw new Error();
  parseNetwork(index.network);
  for (const [id, record] of Object.entries(index.identities)) {
    if (!identityIdSchema.safeParse(id).success || record.file !== `${id}.json` || record.recipeVersion !== 1
      || !/^[0-9a-f]{64}$/.test(record.selection?.rootPublicKeyFingerprint ?? '')
      || record.selection.rootPublicKeyFingerprint !== requireFingerprint(record.selection.rootPublicKey)
      || record.workflow === undefined) throw new Error();
    storedFrom(index.network, id, record);
    if (record.label !== undefined) parseIdentityLabel(record.label);
  }
  assertUniqueCatalogLabels(Object.values(index.identities).map(record => record.label));
  return index;
}

function parseCredentials(value: unknown): CredentialRegistry {
  const registry = value as CredentialRegistry;
  if (!registry || registry.version !== 1 || typeof registry.credentials !== 'object' || registry.credentials === null || Array.isArray(registry.credentials)) throw new Error();
  for (const [id, entry] of Object.entries(registry.credentials)) {
    if (!/^[0-9a-f]{96}$/.test(id) || !identityIdSchema.safeParse(entry.identityId).success
      || !Number.isInteger(entry.credentialNumber) || entry.credentialNumber < 0 || entry.credentialNumber > 255
      || entry.status !== 'pending' && entry.status !== 'confirmed') throw new Error();
    if (entry.status === 'pending' && (typeof entry.expectedAccountAddress !== 'string' || !Number.isSafeInteger(entry.expirySeconds) || entry.expirySeconds < 0)) throw new Error();
    if (entry.status === 'confirmed' && ('expectedAccountAddress' in entry || 'expirySeconds' in entry)) throw new Error();
  }
  return registry;
}

function storedFrom(network: IdentityNetworkMetadata, id: string, record: IdentityIndexRecord): import('./workflowTypes.js').StoredIdentity {
  if (typeof record.workflow !== 'object' || record.workflow === null || Array.isArray(record.workflow)
    || Object.keys(record.workflow).some((key) => !WORKFLOW_KEYS.has(key))) throw new Error();
  const selection = { ...record.selection };
  delete (selection as Partial<typeof selection>).rootPublicKeyFingerprint;
  return parseStoredIdentity({
    version: 1, id, ...(record.sourceId === undefined ? {} : { sourceId: record.sourceId }),
    ...(record.label === undefined ? {} : { label: record.label }),
    selection: { network: network.caip2, sdkNetwork: network.sdkNetwork, ...selection },
    ...record.workflow,
  });
}

function indexRecordFrom(record: import('./workflowTypes.js').StoredIdentity): IdentityIndexRecord {
  const selection = { ...record.selection } as Partial<IdentitySelection>;
  delete selection.network;
  delete selection.sdkNetwork;
  const rootPublicKeyFingerprint = requireFingerprint(record.selection.rootPublicKey);
  const workflow: IdentityIndexRecord['workflow'] = record.status === 'ready'
    ? { status: 'ready', contextHash: record.contextHash, idCredPub: record.idCredPub }
    : {
      status: record.status, contextHash: record.contextHash, idCredPub: record.idCredPub,
      ...(record.request === undefined ? {} : { request: record.request }),
      ...(record.retrievalUrl === undefined ? {} : { retrievalUrl: record.retrievalUrl }),
      ...(record.requestAttemptId === undefined ? {} : { requestAttemptId: record.requestAttemptId }),
      ...(record.confirmedFailure === undefined ? {} : { confirmedFailure: record.confirmedFailure }),
      ...(record.authorizationUrl === undefined ? {} : { authorizationUrl: record.authorizationUrl }),
      ...(record.postIssuance === undefined ? {} : { postIssuance: record.postIssuance }),
    };
  return {
    file: `${record.id}.json`, recipeVersion: 1,
    ...(record.sourceId === undefined ? {} : { sourceId: record.sourceId }),
    ...(record.label === undefined ? {} : { label: record.label }),
    selection: { ...selection as Omit<IdentitySelection, 'network' | 'sdkNetwork'>, rootPublicKeyFingerprint },
    workflow,
  };
}

function assertLabelAvailable(index: IdentityIndex, label: string, ownId?: string): void {
  const parsed = parseCatalogLabel(parseIdentityLabel(label));
  try {
    prepareCatalogLabelMutation({
      operation: 'set', label: parsed.label, mode: parsed.mode,
      otherLabels: Object.entries(index.identities)
        .filter(([id]) => id !== ownId).map(([, record]) => record.label),
    });
  } catch (error) {
    if (error instanceof CatalogLabelError && error.code === 'DUPLICATE_LABEL') {
      throw new IdentityWorkflowError('LABEL_IN_USE');
    }
    throw error;
  }
}

function preserveLabel(current: IdentityIndexRecord, candidate: IdentityIndexRecord): IdentityIndexRecord {
  const next = { ...candidate };
  delete next.label;
  return current.label === undefined ? next : { ...next, label: current.label };
}

function reservationRoot(): string { return path.join(getDataDir(), 'id-manager'); }

type Reservation = IdentityReservationScope & { identityIndex: number };
type ReservationRecord = Reservation & {
  state: 'reserved' | 'used' | 'failed' | 'released';
  reservedAt: number;
};
type LegacyReservationDocument = { version: 1; reservations: Reservation[] };
type ReservationDocument = { version: 2; reservations: ReservationRecord[] };

function parseReservationScope(value: unknown): IdentityReservationScope {
  const scope = value as Partial<IdentityReservationScope> | undefined;
  if (!scope || typeof scope.sourceId !== 'string' || !IDENTITY_SOURCE_ID_PATTERN.test(scope.sourceId)
    || typeof scope.genesisHash !== 'string' || !/^[0-9a-f]{64}$/.test(scope.genesisHash)
    || typeof scope.identityProviderIndex !== 'number' || !Number.isInteger(scope.identityProviderIndex)
    || scope.identityProviderIndex < 0 || scope.identityProviderIndex > 0x7fffffff) throw new Error();
  const network = parseNetwork({
    caip2: `ccd:${scope.genesisHash.slice(0, 32)}`, genesisHash: scope.genesisHash, sdkNetwork: scope.sdkNetwork,
  });
  return {
    genesisHash: network.genesisHash, sourceId: scope.sourceId, sdkNetwork: network.sdkNetwork,
    identityProviderIndex: scope.identityProviderIndex,
  };
}

function reservationKey(value: Reservation): string {
  return `${value.genesisHash}:${value.sourceId}:${value.sdkNetwork}:${String(value.identityProviderIndex).padStart(10, '0')}:${String(value.identityIndex).padStart(10, '0')}`;
}

function reservationOrder(left: Reservation, right: Reservation): number {
  return reservationKey(left) < reservationKey(right) ? -1 : 1;
}

function requireIdentityIndex(value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > 0x7fffffff) throw new Error();
}

function requireReservationTime(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error();
}

function parseReservationDocument(value: unknown): LegacyReservationDocument | ReservationDocument {
  const document = value as LegacyReservationDocument | ReservationDocument;
  if (!document || typeof document !== 'object' || Array.isArray(document)
    || Object.keys(document).length !== 2 || document.version !== 1 && document.version !== 2
    || !Array.isArray(document.reservations)) throw new Error();
  let previous = '';
  for (const reservation of document.reservations) {
    if (!reservation || Object.keys(reservation).length !== (document.version === 1 ? 5 : 7)) throw new Error();
    parseReservationScope(reservation);
    requireIdentityIndex(reservation.identityIndex);
    if (document.version === 2) {
      const record = reservation as ReservationRecord;
      if (record.state !== 'reserved' && record.state !== 'used' && record.state !== 'failed' && record.state !== 'released') throw new Error();
      requireReservationTime(record.reservedAt);
    }
    const key = reservationKey(reservation);
    if (key <= previous) throw new Error();
    previous = key;
  }
  return document;
}

async function readReservationDocument(): Promise<LegacyReservationDocument | ReservationDocument> {
  const filename = path.join(reservationRoot(), 'identity-reservations.json');
  try {
    for (const directory of [getDataDir(), reservationRoot()]) {
      if (!(await lstat(directory)).isDirectory()) throw new Error();
    }
    const details = await lstat(filename);
    if (!details.isFile() || (details.mode & 0o777) !== 0o600) throw new Error();
    return parseReservationDocument(JSON.parse(await readFile(filename, 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 2, reservations: [] };
    throw error;
  }
}

async function occupiedFromIndex(scope: IdentityReservationScope): Promise<Array<{
  id: string; identityIndex: number; workflow: IdentityIndexRecord['workflow'];
}>> {
  const directory = path.join(reservationRoot(), scope.genesisHash.slice(0, 32));
  let details;
  try { details = await lstat(directory); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  if (!details.isDirectory()) throw new Error();
  const filename = path.join(directory, 'index.json');
  await assertRegularFile(filename);
  const index = parseIndex(JSON.parse(await readFile(filename, 'utf8')));
  if (index.network.genesisHash !== scope.genesisHash) throw new Error();
  const occupied: Array<{ id: string; identityIndex: number; workflow: IdentityIndexRecord['workflow'] }> = [];
  for (const [id, record] of Object.entries(index.identities)) {
    const sourceId = record.sourceId ?? deriveIdentitySourceId(record.selection.rootPublicKey, 1);
    if (sourceId === scope.sourceId && record.selection.identityProviderIndex === scope.identityProviderIndex) {
      occupied.push({ id, identityIndex: record.selection.identityIndex, workflow: record.workflow });
    }
  }
  return occupied;
}

function currentReservationDocument(
  document: LegacyReservationDocument | ReservationDocument,
  now: number,
): ReservationDocument {
  if (document.version === 2) return document;
  return {
    version: 2,
    reservations: document.reservations.map((reservation) => ({
      ...reservation, state: 'reserved', reservedAt: now,
    })),
  };
}

function setReservationState(
  document: ReservationDocument,
  reservation: Reservation,
  state: 'reserved' | 'used' | 'failed',
  now: number,
): boolean {
  const key = reservationKey(reservation);
  const existing = document.reservations.find((row) => reservationKey(row) === key);
  if (!existing) {
    document.reservations.push({ ...reservation, state, reservedAt: now });
  } else if (existing.state === 'released') {
    Object.assign(existing, { state, reservedAt: now });
  } else if (state === 'used' && existing.state !== 'used') {
    existing.state = 'used';
  } else if (state === 'failed' && existing.state === 'reserved') {
    existing.state = 'failed';
  } else {
    return false;
  }
  return true;
}

async function withReservationMutation<T>(operation: () => Promise<T>): Promise<T> {
  try {
    await ensureProtectedDirectory(reservationRoot());
    const lockPath = path.join(reservationRoot(), '.identity-reservations.mutation.lock');
    const handle = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try { return await operation(); }
    finally {
      try { await handle.close(); } catch { /* Continue lock cleanup. */ }
      await removeBestEffort(lockPath);
    }
  } catch (error) { throw workflowFailure(error, 'STORAGE_FAILED'); }
}

async function writeReservationState(
  reservation: Reservation,
  state: 'used' | 'failed',
): Promise<void> {
  const persisted = await readReservationDocument();
  const document = currentReservationDocument(persisted, Date.now());
  const changed = setReservationState(document, reservation, state, Date.now()) || persisted.version === 1;
  if (changed) {
    document.reservations.sort(reservationOrder);
    await atomicJson(path.join(reservationRoot(), 'identity-reservations.json'), document);
  }
}

function sameReservationScope(left: IdentityReservationScope, right: IdentityReservationScope): boolean {
  return left.genesisHash === right.genesisHash && left.sourceId === right.sourceId
    && left.sdkNetwork === right.sdkNetwork && left.identityProviderIndex === right.identityProviderIndex;
}

function requireFingerprint(publicKey: string): string {
  return createHash('sha256').update(Buffer.from(publicKey, 'hex')).digest('hex');
}

function validAccountObservation(observation: ReturnType<typeof extractAccountCredentials>, accountThreshold: string): boolean {
  if (!/^[0-9]+$/.test(accountThreshold)) return false;
  return Object.entries(observation).every(([credentialIndex, credential]) =>
    /^[0-9]+$/.test(credentialIndex)
    && /^[0-9a-f]{96}$/.test(credential.credentialId)
    && /^[0-9]+$/.test(credential.threshold)
    && Object.entries(credential.keys).every(([keyIndex, key]) =>
      /^[0-9]+$/.test(keyIndex) && /^[0-9a-f]{64}$/.test(key.publicKey) && key.scheme === 'Ed25519'));
}

async function atomicJson(filename: string, value: unknown): Promise<void> {
  const temporary = path.join(path.dirname(filename), `.${path.basename(filename)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, serializeJsonFile(value), { flag: 'wx', mode: 0o600 });
    await rename(temporary, filename);
  } finally { await removeBestEffort(temporary); }
}

async function removeBestEffort(filename: string): Promise<void> {
  try { await rm(filename, { force: true }); } catch { /* Preserve the primary operation result. */ }
}

async function writeIdentityAndIndex(
  directory: string,
  index: IdentityIndex,
  id: string,
  record: IdentityIndexRecord,
  identity: Parameters<typeof encryptIdentityEnvelope>[0],
  key: Uint8Array,
): Promise<void> {
  const filename = recordPath(directory, id);
  let created = false;
  try {
    try {
      const handle = await open(filename, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      created = true;
      try { await handle.writeFile(serializeJsonFile(encryptIdentityEnvelope(identity, key))); } finally { await handle.close(); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      await assertRegularFile(filename);
      const existing = decryptIdentityEnvelope(JSON.parse(await readFile(filename, 'utf8')), key);
      if (!isDeepStrictEqual(existing, identity)) throw new Error('Existing identity ciphertext does not match.', { cause: error });
    }
    index.identities[id] = record;
    await atomicJson(path.join(directory, 'index.json'), index);
    created = false;
  } finally { if (created) await removeBestEffort(filename); }
}

/** Create the version-1 network-scoped encrypted identity store. */
export function createEncryptedIdentityStore(): EncryptedIdentityStore {
  const requireIndexFile = async (network: string): Promise<void> => {
    try { await access(path.join(stateDirectory(network), 'index.json')); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new IdentityWorkflowError('IDENTITY_NOT_FOUND');
      throw workflowFailure(error, 'STORAGE_FAILED');
    }
  };
  const readIndex = async (network: string, missingIdentity = false): Promise<IdentityIndex> => {
    try {
      const directory = stateDirectory(network);
      await ensureProtectedDirectory(directory);
      await assertRegularFile(path.join(directory, 'index.json'));
      const index = parseIndex(JSON.parse(await readFile(path.join(directory, 'index.json'), 'utf8')));
      if (index.network.caip2 !== `ccd:${caip2Reference(network).toLowerCase()}`) throw new Error();
      return index;
    } catch (error) {
      if (missingIdentity && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new IdentityWorkflowError('IDENTITY_NOT_FOUND');
      }
      throw workflowFailure(error, 'STORAGE_FAILED');
    }
  };
  const withMutation = async <T>(network: string, operation: () => Promise<T>): Promise<T> => {
    try {
      const directory = stateDirectory(network);
      await ensureProtectedDirectory(directory);
      const handle = await open(path.join(directory, '.mutation.lock'), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      try { return await operation(); }
      finally {
        try { await handle.close(); } catch { /* Continue lock cleanup. */ }
        await removeBestEffort(path.join(directory, '.mutation.lock'));
      }
    } catch (error) { throw workflowFailure(error, 'STORAGE_FAILED'); }
  };
  const withIdentityMutation = <T>(network: string, operation: () => Promise<T>): Promise<T> =>
    withReservationMutation(() => withMutation(network, operation));
  return {
    async bootstrapNetwork(network) {
      try {
        const parsed = parseNetwork(network);
        const directory = stateDirectory(parsed.caip2);
        await ensureProtectedDirectory(directory);
        const indexPath = path.join(directory, 'index.json');
        const credentialsPath = path.join(directory, 'credentials.json');
        const indexExists = await access(indexPath).then(() => true, () => false);
        const credentialsExist = await access(credentialsPath).then(() => true, () => false);
        if (!indexExists && !credentialsExist) {
          if ((await readdir(directory)).some(name => /^[0-9a-f]{64}\.json$/.test(name))) throw new Error();
          let indexCreated = false;
          try {
            await writeFile(indexPath, serializeJsonFile({ version: 1, network: parsed, identities: {} }), { flag: 'wx', mode: 0o600 });
            indexCreated = true;
            await writeFile(credentialsPath, serializeJsonFile({ version: 1, credentials: {} }), { flag: 'wx', mode: 0o600 });
          } catch (error) {
            await removeBestEffort(credentialsPath);
            if (indexCreated) await removeBestEffort(indexPath);
            throw error;
          }
        } else {
          if (!indexExists || !credentialsExist) throw new Error();
          const existing = await readIndex(parsed.caip2);
          if (!isDeepStrictEqual(existing.network, parsed)) throw new Error();
          await assertRegularFile(credentialsPath);
          parseCredentials(JSON.parse(await readFile(credentialsPath, 'utf8')));
        }
      } catch (error) { throw workflowFailure(error, 'STORAGE_FAILED'); }
    },
    async create(record) {
      if (record.label !== undefined) parseIdentityLabel(record.label);
      return withIdentityMutation(record.selection.network, async () => {
        const value = parseStoredIdentity(record);
        const index = await readIndex(value.selection.network);
        if (index.identities[value.id]) throw new Error();
        if (value.label !== undefined) assertLabelAvailable(index, value.label);
        index.identities[value.id] = indexRecordFrom(value);
        await atomicJson(path.join(stateDirectory(value.selection.network), 'index.json'), index);
      });
    },
    async load(network, id) {
      if (!identityIdSchema.safeParse(id).success) throw new IdentityWorkflowError('STORAGE_FAILED');
      const index = await readIndex(network, true);
      if (!index.identities[id]) throw new IdentityWorkflowError('IDENTITY_NOT_FOUND');
      return storedFrom(index.network, id, index.identities[id]);
    },
    async save(
      record: StoredIdentity,
      expectedWorkflow: IdentityIndexRecord['workflow'],
      reservationState?: 'failed',
    ) {
      return withIdentityMutation(record.selection.network, async () => {
        const value = parseStoredIdentity(record);
        const index = await readIndex(value.selection.network);
        const current = index.identities[value.id];
        const candidate = indexRecordFrom(value);
        if (!current) throw new Error();
        if (!isDeepStrictEqual(current.workflow, expectedWorkflow)) {
          throw new IdentityWorkflowError('INDEX_UNAVAILABLE');
        }
        if (!isDeepStrictEqual(current.selection, candidate.selection)
          || current.workflow.idCredPub !== value.idCredPub || current.workflow.contextHash !== value.contextHash
          || current.sourceId !== undefined && current.sourceId !== candidate.sourceId
          || current.workflow.status === 'ready' && value.status !== 'ready') throw new Error();
        const next = preserveLabel(current, candidate);
        if (reservationState === 'failed') {
          if (value.confirmedFailure === undefined
            || value.confirmedFailure.requestAttemptId !== value.requestAttemptId) throw new Error();
          await writeReservationState({
            genesisHash: index.network.genesisHash,
            sourceId: next.sourceId ?? deriveIdentitySourceId(next.selection.rootPublicKey, 1),
            sdkNetwork: index.network.sdkNetwork,
            identityProviderIndex: next.selection.identityProviderIndex,
            identityIndex: next.selection.identityIndex,
          }, 'failed');
        }
        index.identities[value.id] = next;
        await atomicJson(path.join(stateDirectory(value.selection.network), 'index.json'), index);
      });
    },
    async list(network) {
      try {
        const indexPath = path.join(stateDirectory(network), 'index.json');
        try { await access(indexPath); } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
          throw error;
        }
        const index = await readIndex(network);
        return Object.entries(index.identities).map(([id, record]) => storedFrom(index.network, id, record));
      } catch (error) { throw workflowFailure(error, 'STORAGE_FAILED'); }
    },
    async setIdentityLabel(input) {
      if (!identityIdSchema.safeParse(input.identityId).success) throw new IdentityWorkflowError('INVALID_INPUT');
      await requireIndexFile(input.network);
      return withIdentityMutation(input.network, async () => {
        const index = await readIndex(input.network);
        const id = input.identityId;
        const current = index.identities[id];
        if (!current) throw new IdentityWorkflowError('IDENTITY_NOT_FOUND');
        let label: string | undefined;
        try {
          const requested = 'label' in input ? parseCatalogLabel(parseIdentityLabel(input.label)) : undefined;
          label = prepareCatalogLabelMutation({
            ...(current.label === undefined ? {} : { current: current.label }),
            operation: input.operation ?? 'set',
            ...(requested === undefined
              ? {}
              : { label: requested.label, mode: requested.mode }),
            softOnly: input.authority === 'agent',
            otherLabels: Object.entries(index.identities)
              .filter(([otherId]) => otherId !== id).map(([, record]) => record.label),
          })!;
        } catch (error) {
          if (error instanceof CatalogLabelError && error.code === 'LABEL_PROTECTED') {
            throw new IdentityWorkflowError('LABEL_PROTECTED');
          }
          if (error instanceof CatalogLabelError && error.code === 'DUPLICATE_LABEL') {
            throw new IdentityWorkflowError('LABEL_IN_USE');
          }
          throw error;
        }
        const updated = { ...current };
        if (label === undefined) delete updated.label;
        else updated.label = label;
        index.identities[id] = updated;
        await atomicJson(path.join(stateDirectory(input.network), 'index.json'), index);
        return storedFrom(index.network, id, updated);
      });
    },
    readIndex,
    withMutation,
    async createIdentity(network, id, record, identity, key, expectedWorkflow) {
      if (record.label !== undefined) parseIdentityLabel(record.label);
      return withIdentityMutation(network.caip2, async () => {
        storedFrom(parseNetwork(network), id, record);
        const index = await readIndex(network.caip2);
        const existing = index.identities[id];
        if (expectedWorkflow === null ? existing !== undefined
          : existing === undefined || !isDeepStrictEqual(existing.workflow, expectedWorkflow)) {
          throw new IdentityWorkflowError('INDEX_UNAVAILABLE');
        }
        if (!isDeepStrictEqual(index.network, network)
          || existing && (existing.workflow.idCredPub !== record.workflow.idCredPub
            || existing.workflow.contextHash !== record.workflow.contextHash
            || !isDeepStrictEqual(existing.selection, record.selection))) throw new Error();
        const next = existing === undefined ? record : preserveLabel(existing, record);
        if (existing === undefined && next.label !== undefined) assertLabelAvailable(index, next.label);
        await writeReservationState({
          genesisHash: index.network.genesisHash,
          sourceId: next.sourceId ?? deriveIdentitySourceId(next.selection.rootPublicKey, 1),
          sdkNetwork: index.network.sdkNetwork,
          identityProviderIndex: next.selection.identityProviderIndex,
          identityIndex: next.selection.identityIndex,
        }, 'used');
        await writeIdentityAndIndex(stateDirectory(network.caip2), index, id, next, identity, key);
      });
    },
    async restoreIdentity(network, id, record, identity, key, expectedWorkflow) {
      if (record.label !== undefined) parseIdentityLabel(record.label);
      return withIdentityMutation(network.caip2, async () => {
        storedFrom(parseNetwork(network), id, record);
        const index = await readIndex(network.caip2);
        const existing = index.identities[id];
        if (!isDeepStrictEqual(index.network, network) || !existing || record.workflow.status !== 'ready') throw new Error();
        if (!isDeepStrictEqual(existing.workflow, expectedWorkflow)) {
          throw new IdentityWorkflowError('INDEX_UNAVAILABLE');
        }
        const next = preserveLabel(existing, record);
        if (existing.file !== next.file || existing.recipeVersion !== next.recipeVersion
          || existing.sourceId !== next.sourceId || !isDeepStrictEqual(existing.selection, next.selection)
          || existing.workflow.idCredPub !== next.workflow.idCredPub
          || existing.workflow.contextHash !== next.workflow.contextHash) throw new Error();
        await writeIdentityAndIndex(stateDirectory(network.caip2), index, id, next, identity, key);
      });
    },
    async loadIdentity(network, id, key) {
      try {
        const index = await readIndex(network);
        if (!index.identities[id]) throw new Error();
        const filename = recordPath(stateDirectory(network), id);
        try { await assertRegularFile(filename); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new IdentityWorkflowError('IDENTITY_FILE_MISSING'); throw error; }
        return decryptIdentityEnvelope(JSON.parse(await readFile(filename, 'utf8')), key);
      } catch (error) { throw error instanceof IdentityWorkflowError ? error : workflowFailure(error, 'STORAGE_FAILED'); }
    },
    async loadCredentials(network) {
      try {
        await ensureProtectedDirectory(stateDirectory(network));
        const filename = path.join(stateDirectory(network), 'credentials.json');
        await assertRegularFile(filename);
        return parseCredentials(JSON.parse(await readFile(filename, 'utf8')));
      } catch (error) { throw workflowFailure(error, 'STORAGE_FAILED'); }
    },
    async saveCredentials(network, registry) {
      try { await atomicJson(path.join(stateDirectory(network), 'credentials.json'), parseCredentials(registry)); }
      catch (error) { throw workflowFailure(error, 'STORAGE_FAILED'); }
    },
    async listIdentityReservations(scope) {
      try {
        const parsed = parseReservationScope(scope);
        const document = await readReservationDocument();
        const records = await occupiedFromIndex(parsed);
        const occupied: number[] = [];
        const scopedRows = new Map<number, ReservationRecord>();
        for (const reservation of document.reservations) {
          if (!sameReservationScope(reservation, parsed)) continue;
          if (document.version === 1) occupied.push(reservation.identityIndex);
          else {
            const record = reservation as ReservationRecord;
            scopedRows.set(record.identityIndex, record);
            if (record.state !== 'released') occupied.push(record.identityIndex);
          }
        }
        for (const record of records) {
          if (record.workflow.status === 'ready' || scopedRows.get(record.identityIndex)?.state !== 'released') occupied.push(record.identityIndex);
        }
        return [...new Set(occupied)].sort((left, right) => left - right);
      } catch (error) { throw workflowFailure(error, 'STORAGE_FAILED'); }
    },
    async readIdentityRequestReservation(input) {
      try {
        const scope = parseReservationScope(input);
        requireIdentityIndex(input.identityIndex);
        const document = await readReservationDocument();
        const key = reservationKey({ ...scope, identityIndex: input.identityIndex });
        const row = document.reservations.find((reservation) => reservationKey(reservation) === key);
        if (row === undefined || document.version === 1) return undefined;
        const current = row as ReservationRecord;
        return { state: current.state, reservedAt: current.reservedAt };
      } catch (error) { throw workflowFailure(error, 'STORAGE_FAILED'); }
    },
    async listIdentityMonitorCandidates(now) {
      try {
        requireReservationTime(now);
        const document = await readReservationDocument();
        if (document.version === 1) return [];
        let entries;
        try { entries = await readdir(reservationRoot(), { withFileTypes: true }); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
          throw error;
        }
        const candidates: import('./workflowTypes.js').IdentityMonitorCandidate[] = [];
        for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
          if (!/^[0-9a-f]{32}$/.test(entry.name)) continue;
          if (!entry.isDirectory()) throw new Error();
          const filename = path.join(reservationRoot(), entry.name, 'index.json');
          const indexExists = await access(filename).then(() => true, (error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') return false;
            throw error;
          });
          if (!indexExists) {
            const names = await readdir(path.join(reservationRoot(), entry.name));
            if (names.includes('credentials.json') || names.some((name) => /^[0-9a-f]{64}\.json$/.test(name))) {
              throw new Error();
            }
            continue;
          }
          await assertRegularFile(filename);
          const index = parseIndex(JSON.parse(await readFile(filename, 'utf8')));
          if (index.network.genesisHash.slice(0, 32) !== entry.name) throw new Error();
          for (const [id, indexed] of Object.entries(index.identities)) {
            const record = storedFrom(index.network, id, indexed);
            if (record.status === 'ready' || record.status === 'expired' || record.requestAttemptId === undefined
              || record.confirmedFailure !== undefined) continue;
            const reservation = {
              genesisHash: index.network.genesisHash,
              sourceId: record.sourceId ?? deriveIdentitySourceId(record.selection.rootPublicKey, 1),
              sdkNetwork: index.network.sdkNetwork,
              identityProviderIndex: record.selection.identityProviderIndex,
              identityIndex: record.selection.identityIndex,
            };
            const row = document.reservations.find((candidate) => reservationKey(candidate) === reservationKey(reservation));
            const active = row?.state === 'reserved' || row?.state === 'used';
            if (active && row !== undefined && row.reservedAt <= now) candidates.push({ record, reservedAt: row.reservedAt });
          }
        }
        return candidates;
      } catch (error) { throw workflowFailure(error, 'STORAGE_FAILED'); }
    },
    async listExpiredIdentityReservations(scope, now, timeoutMs) {
      try {
        const parsed = parseReservationScope(scope);
        requireReservationTime(now);
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error();
        return await withReservationMutation(async () => {
          const persisted = await readReservationDocument();
          const document = currentReservationDocument(persisted, now);
          let changed = persisted.version === 1;
          const scopedRows = new Map<number, ReservationRecord>();
          for (const reservation of document.reservations) {
            if (sameReservationScope(reservation, parsed)) scopedRows.set(reservation.identityIndex, reservation);
          }
          for (const record of await occupiedFromIndex(parsed)) {
            if (record.workflow.status !== 'ready' && !scopedRows.has(record.identityIndex)) {
              const reservation = {
                ...parsed, identityIndex: record.identityIndex, state: 'reserved' as const, reservedAt: now,
              };
              document.reservations.push(reservation);
              scopedRows.set(record.identityIndex, reservation);
              changed = true;
            }
          }
          if (changed) {
            document.reservations.sort(reservationOrder);
            await atomicJson(path.join(reservationRoot(), 'identity-reservations.json'), document);
          }
          return document.reservations
            .filter((reservation) => sameReservationScope(reservation, parsed) && reservation.state === 'reserved'
              && now - reservation.reservedAt >= timeoutMs)
            .map(({ identityIndex, reservedAt }) => ({ identityIndex, reservedAt }));
        });
      } catch (error) { throw workflowFailure(error, 'STORAGE_FAILED'); }
    },
    async reserveIdentityIndex(input) {
      try {
        const scope = parseReservationScope(input);
        requireIdentityIndex(input.identityIndex);
        await withReservationMutation(async () => {
          const persisted = await readReservationDocument();
          const document = currentReservationDocument(persisted, Date.now());
          let changed = persisted.version === 1;
          const indexed = await occupiedFromIndex(scope);
          const scopedRows = new Map<number, ReservationRecord>();
          const occupied: number[] = [];
          for (const reservation of document.reservations) {
            if (!sameReservationScope(reservation, scope)) continue;
            scopedRows.set(reservation.identityIndex, reservation);
            if (reservation.state !== 'released') occupied.push(reservation.identityIndex);
          }
          for (const record of indexed) {
            if (record.workflow.status === 'ready' || scopedRows.get(record.identityIndex)?.state !== 'released') occupied.push(record.identityIndex);
          }
          const indexes = new Set(occupied);
          const alreadyOccupied = indexes.has(input.identityIndex);
          if (input.mode === 'explicit' && alreadyOccupied) throw new IdentityWorkflowError('INDEX_UNAVAILABLE');
          if (input.mode === 'next') {
            const highWater = occupied.length === 0 ? -1 : Math.max(...occupied);
            if (input.expectedHighWater !== highWater || input.identityIndex !== highWater + 1 || alreadyOccupied) {
              throw new IdentityWorkflowError('INDEX_UNAVAILABLE');
            }
          }
          const state = input.mode === 'used' ? 'used' : input.mode === 'failed' ? 'failed' : 'reserved';
          changed = setReservationState(document, { ...scope, identityIndex: input.identityIndex }, state, Date.now()) || changed;
          if (changed) {
            document.reservations.sort(reservationOrder);
            await atomicJson(path.join(reservationRoot(), 'identity-reservations.json'), document);
          }
        });
      } catch (error) { throw workflowFailure(error, 'STORAGE_FAILED'); }
    },
    async resolveIdentityReservation(input) {
      try {
        const scope = parseReservationScope(input);
        requireIdentityIndex(input.identityIndex);
        requireReservationTime(input.reservedAt);
        await withReservationMutation(async () => {
          const document = currentReservationDocument(await readReservationDocument(), Date.now());
          const row = document.reservations.find((reservation) => reservationKey(reservation) === reservationKey(input));
          if (!row || row.state !== 'reserved' || row.reservedAt !== input.reservedAt) {
            throw new IdentityWorkflowError('INDEX_UNAVAILABLE');
          }
          if (input.state === 'released') {
            const indexed = await occupiedFromIndex(scope);
            const current = indexed.find((record) => record.identityIndex === input.identityIndex);
            const currentWorkflow = current?.workflow ?? null;
            if (!isDeepStrictEqual(currentWorkflow, input.expectedWorkflow)) {
              throw new IdentityWorkflowError('INDEX_UNAVAILABLE');
            }
            row.state = currentWorkflow?.status === 'ready' ? 'used' : 'released';
            if (current && current.workflow.status !== 'ready') {
              const network = `ccd:${scope.genesisHash.slice(0, 32)}`;
              const index = await readIndex(network);
              index.identities[current.id]!.workflow.status = 'expired';
              await atomicJson(path.join(stateDirectory(network), 'index.json'), index);
            }
          } else {
            row.state = 'failed';
          }
          await atomicJson(path.join(reservationRoot(), 'identity-reservations.json'), document);
        });
      } catch (error) { throw workflowFailure(error, 'STORAGE_FAILED'); }
    },
  };
}

/** Create the bounded, no-redirect identity-provider HTTP client. */
export function createIdentityProviderClient(fetcher: typeof fetch = fetch): IdentityProviderClient {
  const postRetrieval = async (urlValue: string): Promise<IdentityRetrieval> => {
    const body = await boundedResponseJson(fetcher, urlValue);
    if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new Error();
    const response = body as Record<string, unknown>;
    if (response.status === 'pending') return { status: 'pending' };
    if (response.status === 'error') {
      return {
        status: 'error',
        ...(response.failure === 'key_failed' ? { failure: 'key_failed' as const } : {}),
      };
    }
    if (response.status !== 'done' || typeof response.identityObject !== 'string') throw new Error();
    return { status: 'done', identity: parseIdentityObject(JSON.parse(response.identityObject) as unknown) };
  };
  return {
    async createIssuanceContext(urlValue, request, network) {
      try {
        const issuanceUrl = safeHttpUrl(urlValue);
        const body = await boundedResponseJson(fetcher, issuanceUrl.href, {
          method: 'POST', requiredStatus: 200,
          body: JSON.stringify({ network, state: JSON.stringify({ idObjectRequest: request }) }),
        });
        if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new Error();
        const context = body as Record<string, unknown>;
        if (typeof context.url !== 'string') throw new Error();
        const url = safeHttpUrl(context.url).href;
        if (typeof context.ctxId !== 'string' || context.ctxId.length === 0 || context.ctxId.length > 2048
          || context.ctxId === '.' || context.ctxId === '..'
          || [...context.ctxId].some(character => character.charCodeAt(0) <= 0x1f || character.charCodeAt(0) === 0x7f)) throw new Error();
        const statusUrl = new URL(`/agent-id/${encodeURIComponent(context.ctxId)}/identity-object`, issuanceUrl.origin);
        if (statusUrl.href.length > 8192) throw new Error();
        return { url, statusUrl: statusUrl.href };
      } catch { throw new IdentityWorkflowError('PROVIDER_FAILED'); }
    },
    async pollIssuanceContext(urlValue) {
      try { return await postRetrieval(urlValue); }
      catch { throw new IdentityWorkflowError('PROVIDER_FAILED'); }
    },
    async recover(urlValue, request) {
      const url = safeHttpUrl(urlValue);
      url.searchParams.set('state', JSON.stringify({ idRecoveryRequest: request }));
      try { return parseIdentityObject(await boundedResponseJson(fetcher, url.href, { recovery: true })); }
      catch (error) {
        if (error instanceof IdentityWorkflowError && error.code === 'IDENTITY_NOT_FOUND') throw error;
        throw new IdentityWorkflowError('PROVIDER_FAILED');
      }
    },
    async retrieve(urlValue): Promise<IdentityRetrieval> {
      try {
        const body = await boundedResponseJson(fetcher, urlValue);
        if (typeof body !== 'object' || body === null) throw new Error();
        const status = (body as { status?: unknown }).status;
        if (status === 'pending') return { status };
        if (status === 'error') return { status,
          ...((body as { detail?: unknown }).detail === 'Identity object has failed' ? { failure: 'unconfirmed' as const } : {}),
        };
        if (status !== 'done') throw new Error();
        const token = (body as { token?: unknown }).token;
        if (typeof token !== 'object' || token === null || !('identityObject' in token)) throw new Error();
        return { status: 'done', identity: parseIdentityObject((token as { identityObject: unknown }).identityObject) };
      } catch { throw new IdentityWorkflowError('PROVIDER_FAILED'); }
    },
  };
}

/** Resolve configured endpoints and assemble them with fresh finalized node issuer context. */
export async function loadIdentityContext(
  selection: IdentityContextSelection,
  options: {
    providers: IdentityProviderService;
    readNodeContext?: typeof readFinalizedIdentityProviderContext;
    requireEnabled?: boolean;
  },
): Promise<IdentityContext> {
  try {
    const network = resolveProviderNetwork(selection.network);
    const provider = await options.providers.resolve({
      network, selector: selection.identityProviderIndex, requireEnabled: options.requireEnabled ?? true,
    });
    if (provider.index !== selection.identityProviderIndex) throw new IdentityProviderError('CONTEXT_MISMATCH');
    const node = await (options.readNodeContext ?? readFinalizedIdentityProviderContext)(network);
    if (!isDeepStrictEqual(node.network, network)) throw new IdentityProviderError('CONTEXT_MISMATCH');
    const authoritativeIp = node.identityProviders.find(({ ipIdentity }) => ipIdentity === selection.identityProviderIndex);
    const arIndexes = node.anonymityRevokers.map(({ arIdentity }) => arIdentity);
    if (!authoritativeIp || arIndexes.length < 1 || new Set(arIndexes).size !== arIndexes.length) {
      throw new IdentityProviderError('CONTEXT_MISMATCH');
    }
    const arsInfos = Object.fromEntries(node.anonymityRevokers.map((ar) => [String(ar.arIdentity), ar]));
    const issuanceUrl = safeHttpUrl(provider.issuanceUrl).href;
    const recoveryUrl = safeHttpUrl(provider.recoveryUrl).href;
    return {
      network: network.caip2, genesisHash: network.genesisHash, sdkNetwork: node.sdkNetwork,
      ipInfo: authoritativeIp, arsInfos, globalContext: node.globalContext, issuanceUrl, recoveryUrl,
      ...(provider.issuanceMethod === 'POST' ? {
        issuance: {
          method: 'POST' as const,
        },
      } : {}),
      ...(provider.anonymityRevokers === undefined && provider.anonymityRevokerThreshold === undefined ? {} : {
        anonymityRevocation: {
          ...(provider.anonymityRevokers === undefined ? {} : {
            anonymityRevokers: [...provider.anonymityRevokers],
          }),
          ...(provider.anonymityRevokerThreshold === undefined ? {} : {
            anonymityRevokerThreshold: provider.anonymityRevokerThreshold,
          }),
        },
      }),
    };
  } catch (error) {
    if (error instanceof IdentityProviderError) throw new IdentityProviderError(error.code);
    throw workflowFailure(error, 'CONTEXT_MISMATCH');
  }
}

/** Create an account observer pinned to one node client and one verified finalized block. */
export async function createFinalizedAccountObserver(network: string): Promise<AccountObserver> {
  try {
    const resolved = resolveNetwork(network);
    const genesisHash = resolved.config.genesisHash;
    const reference = caip2Reference(resolved.config.caip2);
    const channelCredentials = resolved.config.grpc.ssl ? credentials.createSsl() : credentials.createInsecure();
    const client = new ConcordiumGRPCNodeClient(
      resolved.config.grpc.host, resolved.config.grpc.port, channelCredentials, { timeout: REQUEST_TIMEOUT_MS },
    );
    const status = await client.getConsensusStatus();
    const genesis = BlockHash.toHexString(status.genesisBlock).toLowerCase();
    if (genesis !== genesisHash) throw new Error();
    const finalized = status.lastFinalizedBlock;
    const finalizedHash = BlockHash.toHexString(finalized).toLowerCase();
    const block = await client.getBlockInfo(finalized);
    const sourceBlock = {
      hash: BlockHash.toHexString(block.blockHash).toLowerCase(),
      height: block.blockHeight.toString(),
      time: block.blockSlotTime.toISOString(),
    };
    if (sourceBlock.hash !== finalizedHash || !/^[0-9]+$/.test(sourceBlock.height)
      || !Number.isFinite(Date.parse(sourceBlock.time))) throw new Error();
    return async (selector) => {
      try {
        let accountSelector;
        if (selector.type === 'address' && typeof selector.address === 'string') {
          accountSelector = AccountAddress.fromBase58(selector.address);
        } else if (selector.type === 'credentialId' && typeof selector.credentialId === 'string'
          && /^[0-9a-f]{96}$/.test(selector.credentialId)) {
          accountSelector = CredentialRegistrationId.fromHexString(selector.credentialId);
        } else throw new Error();
        let info;
        try { info = await client.getAccountInfo(accountSelector, finalized); }
        catch (error) {
          if (isRpcError(error) && error.code === 'NOT_FOUND') return { exists: false, sourceBlock, genesisHash: genesis };
          throw error;
        }
        const canonicalAddress = (info.accountAddress as { address?: unknown }).address;
        if (typeof canonicalAddress !== 'string'
          || AccountAddress.fromBase58(canonicalAddress).toString() !== canonicalAddress) throw new Error();
        const accountThreshold = info.accountThreshold.toString();
        const publicCredentials = extractAccountCredentials(info);
        if (!validAccountObservation(publicCredentials, accountThreshold)) throw new Error();
        const observation = {
          accountThreshold,
          credentials: publicCredentials,
          sourceBlock,
        };
        setAccountCredentialObservation(canonicalAddress, observation, reference);
        return { exists: true, canonicalAddress, sourceBlock, observation, genesisHash: genesis };
      } catch (error) { throw workflowFailure(error, 'NETWORK_FAILED'); }
    };
  } catch (error) { throw workflowFailure(error, 'NETWORK_FAILED'); }
}

/** Create the default identity workflow; PIN prompting is an explicit CLI-only capability. */
export function createDefaultIdentityWorkflow(
  { promptPin, providerPolicy = 'mcp', providers = createDefaultIdentityProviderService(), sources, store }: {
    promptPin?: () => Promise<string>;
    providerPolicy?: 'cli' | 'mcp';
    providers?: IdentityProviderService;
    sources?: IdentitySourceService;
    /** Optional shared store used by the MCP monitor and workflow composition. */
    store?: EncryptedIdentityStore;
  } = {},
): IdentityWorkflow {
  const sourceService = sources ?? createDefaultIdentitySourceService();
  return createIdentityWorkflow({
    store: store ?? createEncryptedIdentityStore(),
    sources: sourceService,
    getIdentityRequestTimeoutMs: (network) => providers.getIdentityRequestTimeoutMs({ network: resolveProviderNetwork(network) }),
    ...(promptPin === undefined ? {} : { promptPin }),
    listEnabledProviders: async (network) => {
      const resolved = resolveProviderNetwork(network);
      return (await providers.inventory({ network: resolved })).providers
        .filter(({ enabled }) => enabled).map(({ index }) => index);
    },
    resolveNetwork: (selector) => resolveNetwork(selector).config.caip2.toLowerCase(),
    loadContext: (selection) => loadIdentityContext(selection, {
      providers, requireEnabled: providerPolicy === 'mcp',
    }),
    provider: createIdentityProviderClient(),
    createAccountObserver: createFinalizedAccountObserver,
  });
}

/** Verify one proof-request anchor while keeping transport/genesis failures distinct from invalid anchors. */
export async function verifyFinalizedProofRequestAnchor(input: {
  request: VerificationRequestV1.Type;
  expectedGenesisHash: string;
  client: Pick<ConcordiumGRPCNodeClient, 'getConsensusStatus' | 'getBlockItemStatus'>;
}): Promise<import('./identityProofs.js').IdentityProofAnchor> {
  const status = await input.client.getConsensusStatus();
  if (BlockHash.toHexString(status.genesisBlock).toLowerCase() !== input.expectedGenesisHash) {
    throw new Error('network context mismatch');
  }
  let transaction: Awaited<ReturnType<typeof input.client.getBlockItemStatus>>;
  try {
    transaction = await input.client.getBlockItemStatus(input.request.transactionRef);
  } catch (error) {
    if (isRpcError(error) && error.code === 'NOT_FOUND') {
      return { status: 'invalid', reason: 'The request anchor transaction was not found.' };
    }
    throw error;
  }
  if (transaction.status !== TransactionStatusEnum.Finalized) {
    return { status: 'invalid', reason: 'The request anchor transaction is not finalized.' };
  }
  try {
    const outcome = await VerificationRequestV1.verifyAnchor(input.request, {
      getBlockItemStatus: async () => transaction,
    } as never, TransactionStatusEnum.Finalized);
    const summary = outcome.summary;
    if (summary === null || !('sender' in summary)) throw new Error('Unexpected transaction type found for request anchor transaction');
    return {
      status: 'valid', transactionHash: TransactionHash.toHexString(input.request.transactionRef).toLowerCase(),
      blockHash: BlockHash.toHexString(outcome.blockHash).toLowerCase(), account: summary.sender.toString(),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (message !== 'Unexpected transaction type found for request anchor transaction'
      && message !== 'Request anchor hash verification failed.') {
      throw error;
    }
    return { status: 'invalid', reason: 'The finalized transaction is not a matching request anchor.' };
  }
}

/**
 * Create the default identity-proof service over shared encrypted state and enrolled sources.
 * Identity material remains inside the shared serialized and zeroizing material scope.
 */
export function createDefaultIdentityProofService({
  sources = createDefaultIdentitySourceService(), store = createEncryptedIdentityStore(),
  readNodeContext, loadCachedCredentials,
}: {
  sources?: IdentitySourceService;
  store?: EncryptedIdentityStore;
  /** Injectable fresh finalized context reader; local candidate discovery never calls it. */
  readNodeContext?: (selection: IdentitySelection, blockHash: string) => Promise<{
    network: string; genesisHash: string; sdkNetwork: IdentitySelection['sdkNetwork'];
    ipInfo: IdentityContext['ipInfo']; arsInfos: IdentityContext['arsInfos']; globalContext: IdentityContext['globalContext'];
    sourceBlock: { hash: string; time: string };
  }>;
  /** Injectable local account-cache projection for deterministic composition tests. */
  loadCachedCredentials?: (network: string) => Array<{
    account: string; credentialIndex: number; credentialId: string;
  }>;
} = {}): IdentityProofService {
  const resolveProofNetwork = (selector?: string) => {
    const resolved = resolveNetwork(selector);
    const genesisHash = resolved.config.genesisHash;
    return {
      caip2: resolved.config.caip2, genesisHash,
      sdkNetwork: getBuiltinNetworkName(genesisHash) === 'mainnet' ? 'Mainnet' as const : 'Testnet' as const,
      config: resolved.config,
    };
  };
  const readProofContext = readNodeContext ?? (async (selection: IdentitySelection, blockHash: string) => {
    const resolved = resolveProofNetwork(selection.network);
    const channelCredentials = resolved.config.grpc.ssl ? credentials.createSsl() : credentials.createInsecure();
    const client = new ConcordiumGRPCNodeClient(
      resolved.config.grpc.host, resolved.config.grpc.port, channelCredentials, { timeout: REQUEST_TIMEOUT_MS },
    );
    const status = await client.getConsensusStatus();
    if (BlockHash.toHexString(status.genesisBlock).toLowerCase() !== resolved.genesisHash) throw new Error();
    const block = BlockHash.fromHexString(blockHash);
    const abort = new AbortController();
    const collect = async <T>(values: AsyncIterable<T>): Promise<T[]> => {
      const result: T[] = [];
      for await (const value of values) result.push(value);
      return result;
    };
    try {
      const [info, globalContext, identityProviders, anonymityRevokers] = await Promise.all([
        client.getBlockInfo(block), client.getCryptographicParameters(block),
        collect(client.getIdentityProviders(block, abort.signal)),
        collect(client.getAnonymityRevokers(block, abort.signal)),
      ]);
      if (BlockHash.toHexString(info.blockHash).toLowerCase() !== blockHash) throw new Error();
      const ipInfo = identityProviders.find(candidate => candidate.ipIdentity === selection.identityProviderIndex);
      if (ipInfo === undefined || anonymityRevokers.length < 1) throw new Error();
      return { network: resolved.caip2, genesisHash: resolved.genesisHash, sdkNetwork: resolved.sdkNetwork,
        sourceBlock: { hash: blockHash, time: info.blockSlotTime.toISOString() }, ipInfo,
        arsInfos: Object.fromEntries(anonymityRevokers.map(ar => [String(ar.arIdentity), ar])), globalContext };
    } finally { abort.abort(); }
  });
  return createIdentityProofService({
    resolveNetwork(selector) {
      const { caip2, sdkNetwork } = resolveProofNetwork(selector);
      return { caip2, sdkNetwork };
    },
    listRecords: network => store.list(network),
    loadIdentity: (record, storageKey) => store.loadIdentity(record.selection.network, record.id, storageKey),
    loadCredentialRegistry: network => store.loadCredentials(network),
    async listCachedCredentials(network) {
      if (loadCachedCredentials !== undefined) return loadCachedCredentials(network);
      const reference = caip2Reference(network).toLowerCase();
      return Object.entries(loadAccountCredentials(reference)).flatMap(([account, observation]) =>
        Object.entries(observation.credentials).flatMap(([credentialIndex, credential]) =>
          credential.credentialId === undefined ? [] : [{
            account, credentialIndex: Number(credentialIndex), credentialId: credential.credentialId.toLowerCase(),
          }]));
    },
    async loadLocalContext(record) {
      try {
        const resolved = resolveProofNetwork(record.selection.network);
        const snapshot = getIdentityContextSnapshot(caip2Reference(record.selection.network).toLowerCase());
        if (snapshot === undefined || snapshot.network.caip2 !== record.selection.network
          || snapshot.network.genesisHash !== resolved.genesisHash || snapshot.network.caip2 !== resolved.caip2
          || record.selection.sdkNetwork !== resolved.sdkNetwork
        ) return undefined;
        const ipInfo = snapshot.identityProviders.find(candidate =>
          candidate.ipIdentity === record.selection.identityProviderIndex);
        if (ipInfo === undefined || snapshot.anonymityRevokers.length < 1) return undefined;
        return {
          network: snapshot.network.caip2, genesisHash: snapshot.network.genesisHash,
          sdkNetwork: record.selection.sdkNetwork, ipInfo,
          arsInfos: Object.fromEntries(snapshot.anonymityRevokers.map(ar => [String(ar.arIdentity), ar])),
          globalContext: snapshot.globalContext,
        };
      } catch { return undefined; }
    },
    async loadGenerationContext(selection, blockHash) {
      const resolved = resolveProofNetwork(selection.network);
      const context = await readProofContext(selection, blockHash);
      if (context.network !== selection.network || context.genesisHash !== resolved.genesisHash
        || context.sdkNetwork !== selection.sdkNetwork || context.ipInfo.ipIdentity !== selection.identityProviderIndex
        || Object.keys(context.arsInfos).length < 1) throw new Error();
      return context;
    },
    withMaterial(record, callback) {
      if (record.sourceId === undefined) throw new IdentityWorkflowError('SOURCE_NOT_ASSOCIATED');
      return withIdentityMaterial({ selection: record.selection, sourceId: record.sourceId, sources },
        (seed, material, storage) => callback({ seed, material, storageKey: storage.encryptionKey }));
    },
    async loadFinalizedCredentials(network, account, blockHash) {
      const resolved = resolveProofNetwork(network);
      const address = resolveAccountLabel(account, caip2Reference(network))?.address ?? account;
      const parsedAddress = AccountAddress.fromBase58(address);
      const channelCredentials = resolved.config.grpc.ssl ? credentials.createSsl() : credentials.createInsecure();
      const client = new ConcordiumGRPCNodeClient(
        resolved.config.grpc.host, resolved.config.grpc.port, channelCredentials, { timeout: REQUEST_TIMEOUT_MS },
      );
      const status = await client.getConsensusStatus();
      if (BlockHash.toHexString(status.genesisBlock).toLowerCase() !== resolved.genesisHash) throw new Error();
      const anchorBlock = BlockHash.fromHexString(blockHash);
      const [block, info, current] = await Promise.all([
        client.getBlockInfo(anchorBlock), client.getAccountInfo(parsedAddress, anchorBlock),
        client.getAccountInfo(parsedAddress, status.lastFinalizedBlock),
      ]);
      const sourceHash = BlockHash.toHexString(block.blockHash).toLowerCase();
      if (sourceHash !== blockHash) throw new Error();
      const canonical = info.accountAddress.toString();
      if (current.accountAddress.toString() !== canonical) throw new Error();
      const credentialsAt = (accountCredentials: typeof info.accountCredentials, includePolicy: boolean) =>
        Object.entries(accountCredentials).flatMap(([index, versioned]) => {
        if (!/^(?:0|[1-9]\d*)$/.test(index)) throw new Error();
        const credentialIndex = Number(index);
        if (!Number.isInteger(credentialIndex) || credentialIndex < 0 || credentialIndex > 255) throw new Error();
        const credential = versioned.value;
        if (credential.type !== 'normal') return [];
        const value = credential.contents;
        if (!/^[0-9a-f]{96}$/.test(value.credId)
          || !Number.isInteger(value.ipIdentity) || value.ipIdentity < 0) throw new Error();
        return [includePolicy ? {
          account: canonical, credentialIndex, credentialId: value.credId,
          issuer: value.ipIdentity, commitments: value.commitments.cmmAttributes,
          policy: value.policy,
        } : { credentialIndex, credentialId: value.credId }];
      });
      return {
        account: canonical,
        sourceBlock: { hash: sourceHash, time: block.blockSlotTime.toISOString() },
        credentials: credentialsAt(info.accountCredentials, true),
        currentCredentials: credentialsAt(current.accountCredentials, false),
      } as Awaited<ReturnType<Parameters<typeof createIdentityProofService>[0]['loadFinalizedCredentials']>>;
    },
    async verifyAnchor(network, request) {
      const resolved = resolveProofNetwork(network);
      const channelCredentials = resolved.config.grpc.ssl ? credentials.createSsl() : credentials.createInsecure();
      const client = new ConcordiumGRPCNodeClient(
        resolved.config.grpc.host, resolved.config.grpc.port, channelCredentials, { timeout: REQUEST_TIMEOUT_MS },
      );
      return verifyFinalizedProofRequestAnchor({ request, expectedGenesisHash: resolved.genesisHash, client });
    },
  });
}
