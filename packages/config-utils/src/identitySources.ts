import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { validateP256PublicKey } from '@ccd-agent-kit/piv-utils';

import {
  CATALOG_LABEL_PATTERN, assertUniqueCatalogLabels, findCatalogLabel, parseCatalogLabel,
  prepareCatalogLabelMutation, type CatalogLabelError, type CatalogLabelMode, type CatalogLabelOperation,
} from './labels.js';
import { canonicalJson, mergeStable, reorderExact } from './catalogOrder.js';
import { getIdentitySourcesPath } from './paths.js';
import { protectedFileExists, writeProtectedJsonAtomic } from './signer/protectedFile.js';

/** Stable identity-source catalog failure codes. */
export type IdentitySourceErrorCode =
  | 'INVALID_LABEL' | 'INVALID_SOURCE' | 'DUPLICATE_LABEL' | 'DUPLICATE_LOCATOR'
  | 'SOURCE_ID_COLLISION'
  | 'SOURCE_NOT_FOUND' | 'NO_DEFAULT_SOURCE' | 'STORAGE_FAILED' | 'LABEL_PROTECTED'
  | 'LABEL_REQUIRED' | 'CANCELLED';

/** Sanitized identity-source catalog failure. */
export class IdentitySourceError extends Error {
  /** Constructs a source failure from its stable public code. */
  constructor(public readonly code: IdentitySourceErrorCode) { super(code); this.name = 'IdentitySourceError'; }
}

/** One ordered backend reference and its ordered public device locations. */
export interface IdentitySourceBackendReference {
  /** Runtime backend identifier. */
  backend: string;
  /** Public locations at which the pinned root may be found. */
  locations: Array<Record<string, unknown>>;
}

/** Persisted public metadata for one pinned identity root. */
export interface IdentitySourceRecord {
  /** Persisted hard label, or soft label prefixed by `@`. */
  label?: string;
  /** Ordered runtime backends and locations for this root. */
  backends: IdentitySourceBackendReference[];
  rootPublicKey: string;
  rootPublicKeyFingerprint: string;
  recipeVersion: 1;
}

/** Version-1 global identity-source catalog. */
export interface IdentitySourceRegistryDocument {
  version: 1;
  defaultSourceId?: string;
  sources: Record<string, IdentitySourceRecord>;
}

/** Options for one atomic identity-root enrollment. */
export interface IdentitySourceEnrollmentOptions {
  /** Transfers claimed locations from other roots; use only after verified hardware replacement. */
  replaceLocations?: boolean;
}

/** An identity-source record paired with its derived catalog identifier. */
export type IdentitySourceRegistryResult = IdentitySourceRecord & { id: string };

/** Scope of an identity-source catalog forget operation. */
export type IdentitySourceForgetTarget = 'all' | {
  /** Built-in backend owning the public location. */
  backend: 'yubikey-piv';
  /** Exact registered YubiKey identity location. */
  location: { serial: string };
};

/** Operator-authorized identity-source label mutation. */
export interface SetIdentitySourceLabelInput {
  /** New bare label; omission preserves the current label for a set operation. */
  label?: string;
  /** Requested protection mode; omission preserves an existing mode and defaults new labels to hard. */
  mode?: CatalogLabelMode;
  /** Mutation to perform; defaults to `set`. */
  operation?: CatalogLabelOperation;
}

/** Protected persistence and label mutation for identity sources. */
export interface IdentitySourceRegistry {
  read(): Promise<IdentitySourceRegistryDocument>;
  /** Atomically enrolls or merges a root, optionally transferring verified replacement locations. */
  enroll(record: IdentitySourceRecord, options?: IdentitySourceEnrollmentOptions): Promise<IdentitySourceRegistryResult>;
  /** Forgets all public metadata or one registered location without changing identity key material. */
  forgetLocation(source: string, target: IdentitySourceForgetTarget): Promise<IdentitySourceRegistryResult | { id: string }>;
  /** Reorders an exact permutation of existing backend identifiers without enrolling new custody. */
  reorderBackends(source: string, backends: string[]): Promise<IdentitySourceRecord & { id: string }>;
  /** Reorders an exact permutation of a backend's locations without modifying their metadata. */
  reorderLocations(source: string, backend: string, locations: Array<Record<string, unknown>>): Promise<IdentitySourceRecord & { id: string }>;
  setLabel(source: string, input: SetIdentitySourceLabelInput): Promise<IdentitySourceRecord & { id: string }>;
  setSoftLabel(source: string, label?: string): Promise<IdentitySourceRecord & { id: string }>;
  removeLabel(source: string): Promise<IdentitySourceRecord & { id: string }>;
  setDefault(source: string): Promise<IdentitySourceRecord & { id: string }>;
}

/** Canonical identity-source ID: the `ir:` namespace followed by the recipe-v1 75-bit payload. */
export const IDENTITY_SOURCE_ID_PATTERN = /^ir:[a-z2-7]{15}$/;
const DOMAIN = Buffer.from('ccd-id-manager/source-id/v1\0', 'utf8');
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

/** Derives the canonical `ir:` ID from the deterministic 75-bit recipe-v1 payload for a P-256 identity root. */
export function deriveIdentitySourceId(rootPublicKey: string, recipeVersion: 1): string {
  try {
    if (recipeVersion !== 1 || !/^[0-9a-f]{130}$/.test(rootPublicKey)) fail('INVALID_SOURCE');
    const root = validateP256PublicKey(Buffer.from(rootPublicKey, 'hex'));
    const digest = createHash('sha256').update(DOMAIN).update(Buffer.from('1')).update(Buffer.from([0])).update(root).digest();
    let output = '';
    for (let index = 0; index < 15; index += 1) {
      const bit = index * 5; const byte = Math.floor(bit / 8); const shift = 11 - (bit % 8);
      output += ALPHABET[(((digest[byte]! << 8) | digest[byte + 1]!) >> shift) & 31];
    }
    return `ir:${output}`;
  } catch (error) { if (error instanceof IdentitySourceError) throw error; return fail('INVALID_SOURCE'); }
}

/** Resolves an exact source ID or bare hard/soft label. */
export function resolveIdentitySource(document: IdentitySourceRegistryDocument, selector?: string): [string, IdentitySourceRecord] {
  if (selector === undefined) {
    if (document.defaultSourceId === undefined) fail('NO_DEFAULT_SOURCE');
    return [document.defaultSourceId, document.sources[document.defaultSourceId]!];
  }
  if (Object.hasOwn(document.sources, selector)) return [selector, document.sources[selector]!];
  const entries = Object.entries(document.sources) as Array<[string, IdentitySourceRecord]>;
  const label = CATALOG_LABEL_PATTERN.test(selector.trim())
    ? findCatalogLabel(entries, selector, ([, record]) => record.label)
    : undefined;
  if (label === undefined) fail('SOURCE_NOT_FOUND');
  return [label[0], label[1]];
}

/** Creates the global protected identity-source catalog. */
export function createIdentitySourceRegistry(): IdentitySourceRegistry {
  const load = (): IdentitySourceRegistryDocument => {
    try { return structuredClone(loadDocument()); } catch { throw new IdentitySourceError('STORAGE_FAILED'); }
  };
  const read = async (): Promise<IdentitySourceRegistryDocument> => load();
  const mutate = async <T>(operation: (document: IdentitySourceRegistryDocument) => T): Promise<T> => {
    const document = load();
    let result: T;
    try { result = operation(document); }
    catch (error) { throw error instanceof IdentitySourceError ? error : new IdentitySourceError('INVALID_SOURCE'); }
    try { saveDocument(document); }
    catch { throw new IdentitySourceError('STORAGE_FAILED'); }
    return result;
  };
  const setLabel = (source: string, input: SetIdentitySourceLabelInput, softOnly: boolean) => {
    return mutate((document) => {
      const [id, record] = resolveIdentitySource(document, source);
      let stored: string | undefined;
      try {
        stored = prepareCatalogLabelMutation({
          ...(record.label === undefined ? {} : { current: record.label }),
          operation: input.operation ?? 'set',
          ...(input.label === undefined ? {} : { label: input.label }),
          ...(input.mode === undefined ? {} : { mode: input.mode }),
          softOnly,
          otherLabels: Object.entries(document.sources)
            .filter(([otherId]) => otherId !== id)
            .map(([, candidate]) => candidate.label),
        });
      } catch (error) { return mapLabelError(error); }
      if (stored !== undefined) assertIdentitySourceLabelAvailable(document, parseCatalogLabel(stored).label, id);
      if (stored === undefined) delete record.label;
      else record.label = stored;
      return { id, ...structuredClone(record) };
    });
  };
  return {
    read,
    enroll(record, options) {
      return mutate(document => enrollRecord(document, parseRecord(structuredClone(record)), options?.replaceLocations === true));
    },
    async forgetLocation(source, target) {
      const parsedTarget = parseForgetTarget(target);
      return await mutate((document) => {
        const [id, record] = resolveIdentitySource(document, source);
        if (parsedTarget === 'all') { forgetSource(document, id); return { id }; }
        const key = canonicalJson(parsedTarget.location);
        const reference = record.backends.find(candidate => candidate.backend === parsedTarget.backend);
        if (reference === undefined || !reference.locations.some(candidate => canonicalJson(candidate) === key)) fail('INVALID_SOURCE');
        const backends = forgetRecordLocations(record, new Set([`${parsedTarget.backend}\0${key}`]));
        if (backends.length === 0) { forgetSource(document, id); return { id }; }
        const candidate = parseRecord({ ...record, backends });
        document.sources[id] = candidate;
        return { id, ...structuredClone(candidate) };
      });
    },
    reorderBackends(source, backends) {
      return mutate((document) => {
        const [id, record] = resolveIdentitySource(document, source);
        record.backends = orderExisting(record.backends, backends, reference => reference.backend);
        return { id, ...structuredClone(record) };
      });
    },
    reorderLocations(source, backend, locations) {
      return mutate((document) => {
        const [id, record] = resolveIdentitySource(document, source);
        const reference = record.backends.find(candidate => candidate.backend === backend);
        if (reference === undefined) fail('INVALID_SOURCE');
        reference.locations = orderExisting(reference.locations, locations.map(canonicalJson), canonicalJson);
        return { id, ...structuredClone(record) };
      });
    },
    setLabel(source, input) { return setLabel(source, input, false); },
    setSoftLabel(source, label) {
      return setLabel(source, {
        operation: label === undefined ? 'remove' : 'set', ...(label === undefined ? {} : { label }),
      }, true);
    },
    removeLabel(source) { return setLabel(source, { operation: 'remove' }, false); },
    setDefault(source) { return mutate((document) => { const [id, record] = resolveIdentitySource(document, source); document.defaultSourceId = id; return { id, ...structuredClone(record) }; }); },
  };
}

function loadDocument(): IdentitySourceRegistryDocument {
  const filename = getIdentitySourcesPath();
  if (!protectedFileExists(filename)) return { version: 1, sources: {} };
  return parseDocument(JSON.parse(readFileSync(filename, 'utf8')) as unknown);
}
function saveDocument(document: IdentitySourceRegistryDocument): void { writeProtectedJsonAtomic(getIdentitySourcesPath(), document, 'sources'); }
function parseDocument(value: unknown): IdentitySourceRegistryDocument {
  if (!object(value)
    || !exact(value, value.defaultSourceId === undefined ? ['version', 'sources'] : ['version', 'defaultSourceId', 'sources'])
    || value.version !== 1 || !object(value.sources)
    || (value.defaultSourceId !== undefined && (typeof value.defaultSourceId !== 'string' || !IDENTITY_SOURCE_ID_PATTERN.test(value.defaultSourceId)))) fail('INVALID_SOURCE');
  const sources: Record<string, IdentitySourceRecord> = {}; const locations = new Set<string>();
  for (const [id, raw] of Object.entries(value.sources)) {
    const record = parseRecord(raw);
    if (!IDENTITY_SOURCE_ID_PATTERN.test(id) || deriveIdentitySourceId(record.rootPublicKey, 1) !== id) fail('INVALID_SOURCE');
    for (const location of recordLocations(record)) { if (locations.has(location)) fail('INVALID_SOURCE'); locations.add(location); }
    sources[id] = record;
  }
  try { assertUniqueCatalogLabels(Object.values(sources).map((record) => record.label)); }
  catch { fail('INVALID_SOURCE'); }
  if (typeof value.defaultSourceId === 'string' && sources[value.defaultSourceId] === undefined) fail('INVALID_SOURCE');
  return { version: 1, ...(typeof value.defaultSourceId === 'string' ? { defaultSourceId: value.defaultSourceId } : {}), sources };
}
function parseRecord(value: unknown): IdentitySourceRecord {
  if (!object(value) || Object.keys(value).some((key) => !['label', 'backends', 'rootPublicKey', 'rootPublicKeyFingerprint', 'recipeVersion'].includes(key))
    || (value.label !== undefined && typeof value.label !== 'string') || !Array.isArray(value.backends)
    || value.backends.length === 0 || typeof value.rootPublicKey !== 'string' || typeof value.rootPublicKeyFingerprint !== 'string'
    || value.recipeVersion !== 1) fail('INVALID_SOURCE');
  if (typeof value.label === 'string') {
    try { parseCatalogLabel(value.label); } catch { fail('INVALID_LABEL'); }
  }
  let root: Buffer;
  try { root = validateP256PublicKey(Buffer.from(value.rootPublicKey, 'hex')); }
  catch { return fail('INVALID_SOURCE'); }
  if (root.toString('hex') !== value.rootPublicKey || createHash('sha256').update(root).digest('hex') !== value.rootPublicKeyFingerprint) fail('INVALID_SOURCE');
  const backends = value.backends.map((raw): IdentitySourceBackendReference => {
    if (!object(raw) || Object.keys(raw).length !== 2 || typeof raw.backend !== 'string' || raw.backend.length === 0
      || !Array.isArray(raw.locations) || raw.locations.length === 0 || !raw.locations.every(jsonObject)) fail('INVALID_SOURCE');
    if (raw.backend === 'yubikey-piv' && !raw.locations.every((location) => Object.keys(location).length === 1 && typeof location.serial === 'string' && /^\d+$/.test(location.serial))) fail('INVALID_SOURCE');
    return { backend: raw.backend, locations: structuredClone(raw.locations) };
  });
  if (new Set(backends.map((backend) => backend.backend)).size !== backends.length) fail('INVALID_SOURCE');
  const locations = recordLocations({
    ...(typeof value.label === 'string' ? { label: value.label } : {}),
    backends,
    rootPublicKey: value.rootPublicKey,
    rootPublicKeyFingerprint: value.rootPublicKeyFingerprint,
    recipeVersion: 1,
  });
  if (new Set(locations).size !== locations.length) fail('INVALID_SOURCE');
  return { ...(typeof value.label === 'string' ? { label: value.label } : {}), backends, rootPublicKey: value.rootPublicKey, rootPublicKeyFingerprint: value.rootPublicKeyFingerprint, recipeVersion: 1 };
}
function enrollRecord(document: IdentitySourceRegistryDocument, parsed: IdentitySourceRecord,
  replaceLocations: boolean): IdentitySourceRegistryResult {
  const label = parsed.label === undefined ? undefined : parseSourceLabel(parsed.label);
  const locations = recordLocations(parsed);
  if (new Set(locations).size !== locations.length) fail('INVALID_SOURCE');
  const id = deriveIdentitySourceId(parsed.rootPublicKey, 1);
  const existing = document.sources[id];
  if (existing !== undefined && existing.rootPublicKey !== parsed.rootPublicKey) fail('SOURCE_ID_COLLISION');
  if (label !== undefined) {
    assertIdentitySourceLabelAvailable(document, label, id);
    parsed.label = prepareEnrollmentLabel(document, id, existing?.label, parsed.label!);
  }

  const owners = new Map<string, string>();
  for (const [ownerId, record] of Object.entries(document.sources)) {
    for (const location of recordLocations(record)) owners.set(location, ownerId);
  }
  const claimed = new Set(locations);
  const transferred = new Set<string>();
  for (const location of claimed) {
    const ownerId = owners.get(location);
    if (ownerId !== undefined && ownerId !== id) {
      if (!replaceLocations) fail('DUPLICATE_LOCATOR');
      transferred.add(location);
    }
  }

  if (transferred.size > 0) {
    for (const [ownerId, owner] of Object.entries(document.sources)) {
      if (ownerId === id) continue;
      const backends = forgetRecordLocations(owner, transferred);
      if (backends.length === 0) {
        forgetSource(document, ownerId);
      } else if (backends.length !== owner.backends.length
        || backends.some((reference, index) => reference.locations.length !== owner.backends[index]?.locations.length)) {
        document.sources[ownerId] = { ...owner, backends };
      }
    }
  }

  const candidate = existing === undefined ? parsed : {
    ...existing,
    ...(parsed.label === undefined ? {} : { label: parsed.label }),
    backends: mergeBackends(existing.backends, parsed.backends),
  };
  document.sources[id] = structuredClone(candidate);
  return { id, ...structuredClone(candidate) };
}
function forgetRecordLocations(record: IdentitySourceRecord, locations: ReadonlySet<string>): IdentitySourceBackendReference[] {
  return record.backends.flatMap(reference => {
    const retained = reference.locations.filter(location => !locations.has(`${reference.backend}\0${canonicalJson(location)}`));
    return retained.length === 0 ? [] : [{ ...reference, locations: retained }];
  });
}
function forgetSource(document: IdentitySourceRegistryDocument, id: string): void {
  delete document.sources[id];
  if (document.defaultSourceId === id) delete document.defaultSourceId;
}
function parseForgetTarget(value: unknown): IdentitySourceForgetTarget {
  if (value === 'all') return value;
  if (!object(value) || !exact(value, ['backend', 'location']) || value.backend !== 'yubikey-piv'
    || !object(value.location) || !exact(value.location, ['serial'])
    || typeof value.location.serial !== 'string' || !/^\d+$/.test(value.location.serial)) fail('INVALID_SOURCE');
  return { backend: 'yubikey-piv', location: { serial: value.location.serial } };
}
function mergeBackends(existing: IdentitySourceBackendReference[], incoming: IdentitySourceBackendReference[]): IdentitySourceBackendReference[] {
  return mergeStable(structuredClone(existing), structuredClone(incoming), reference => reference.backend,
    (current, next) => ({
      ...current,
      locations: mergeStable(current.locations, next.locations, canonicalJson, currentLocation => currentLocation),
    }));
}
/**
 * Verifies that a bare identity-source label does not collide with another label.
 *
 * @param document - Current identity-source registry document.
 * @param label - Candidate bare label.
 * @param ownId - Existing source ID to exclude while relabeling that source.
 * @throws {IdentitySourceError} With `INVALID_LABEL` or `DUPLICATE_LABEL`.
 */
export function assertIdentitySourceLabelAvailable(
  document: IdentitySourceRegistryDocument,
  label: string,
  ownId?: string,
): void {
  try { parseCatalogLabel(label); }
  catch { return fail('INVALID_LABEL'); }
  try {
    assertUniqueCatalogLabels([
      label,
      ...Object.entries(document.sources).filter(([sourceId]) => sourceId !== ownId).map(([, record]) => record.label),
    ]);
  } catch { fail('DUPLICATE_LABEL'); }
}
function prepareEnrollmentLabel(document: IdentitySourceRegistryDocument, id: string,
  current: string | undefined, incoming: string): string {
  const parsed = parseCatalogLabel(incoming);
  return prepareCatalogLabelMutation({
    ...(current === undefined ? {} : { current }), operation: 'set', label: parsed.label, mode: parsed.mode,
    otherLabels: Object.entries(document.sources)
      .filter(([otherId]) => otherId !== id)
      .map(([, record]) => record.label),
  })!;
}
function mapLabelError(error: unknown): never {
  const code = (error as CatalogLabelError).code;
  if (code === 'DUPLICATE_LABEL') fail('DUPLICATE_LABEL');
  if (code === 'LABEL_PROTECTED') fail('LABEL_PROTECTED');
  if (code === 'LABEL_REQUIRED') fail('LABEL_REQUIRED');
  return fail('INVALID_LABEL');
}
function parseSourceLabel(label: string): string { try { return parseCatalogLabel(label).label; } catch { return fail('INVALID_LABEL'); } }
function orderExisting<T>(values: T[], order: string[], key: (value: T) => string): T[] {
  return reorderExact(values, order, key, value => value) ?? fail('INVALID_SOURCE');
}
function recordLocations(record: IdentitySourceRecord): string[] { return record.backends.flatMap((backend) => backend.locations.map((location) => `${backend.backend}\0${canonicalJson(location)}`)); }
function jsonObject(value: unknown): value is Record<string, unknown> { return object(value) && jsonValue(value); }
function jsonValue(value: unknown): boolean { if (value === null || typeof value === 'string' || typeof value === 'boolean') return true; if (typeof value === 'number') return Number.isFinite(value); if (Array.isArray(value)) return value.every(jsonValue); return object(value) && Object.values(value).every(jsonValue); }
function object(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function exact(value: Record<string, unknown>, keys: string[]): boolean { return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key)); }
function fail(code: IdentitySourceErrorCode): never { throw new IdentitySourceError(code); }
