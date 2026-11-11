import { readFileSync } from 'node:fs';
import {
  ed25519PublicKey, publicKeyScheme, type Ed25519PublicKeyHex, type PublicKeyScheme,
} from '@ccd-agent-kit/sdk-utils';
import type { YubiKeySigningSlot, PivPinPolicy, PivTouchPolicy } from '@ccd-agent-kit/piv-utils';
import { z } from 'zod';

export type { YubiKeySigningSlot } from '@ccd-agent-kit/piv-utils';

import {
  assertUniqueCatalogLabels, findCatalogLabel, normalizeCatalogLabel, parseCatalogLabel,
  prepareCatalogLabelMutation, storedCatalogLabel, type CatalogLabelMode, type CatalogLabelOperation,
  type ParsedCatalogLabel,
} from '../labels.js';
import { canonicalJson, reorderExact } from '../catalogOrder.js';
import { getSignerInventoryPath } from '../paths.js';
import {
  mergeBuiltInSignerBackend, parseSoftwareBackend, parseYubiKeyPivBackend, type SoftwareSignerBackend,
} from './backends.js';
import { pivDeviceLocatorIdentity } from './pivDeviceLocator.js';
import { protectedFileExists, writeProtectedJsonAtomic } from './protectedFile.js';

/** Current signing-material catalog format version. */
export const SIGNER_INVENTORY_VERSION = 1;
/** Ed25519 public-key-backed signing-material reference. */
export type SignerKeyRef = `ed25519:${Ed25519PublicKeyHex}`;
/** Supported signing-material key schemes. */
export type SignerInventoryKeyScheme = PublicKeyScheme;

/** YubiKey device locator for a PIV signing key. */
export interface YubiKeyPivDeviceLocator {
  kind: 'yubikey'; serial: string; slot: YubiKeySigningSlot;
  pinPolicy?: PivPinPolicy; touchPolicy?: PivTouchPolicy; lastSeenAt?: string;
}
/** Generic PIV device locator for a signing key. */
export interface GenericPivDeviceLocator {
  kind: 'generic_piv'; slot: YubiKeySigningSlot;
  certificateFingerprint?: string; chuid?: string; lastSeenAt?: string;
}
/** Device locations for PIV-backed signing material. */
export type PivDeviceLocator = YubiKeyPivDeviceLocator | GenericPivDeviceLocator;
/** Built-in YubiKey backend payload. */
export interface YubiKeyPivSignerBackend { devices: PivDeviceLocator[]; }

const storedCatalogLabelSchema = z.string().transform((value, context) => {
  const parsed = storedCatalogLabel.from(value);
  if (parsed !== undefined) return parsed;
  context.addIssue({ code: 'custom', message: 'Invalid stored catalog label.' });
  return z.NEVER;
});
const signerKeyRefSchema = z.string().transform((value, context) => {
  const publicKey = publicKeyFromEd25519SignerKeyRef(value);
  if (publicKey !== undefined) return ed25519SignerKeyRef(publicKey);
  context.addIssue({ code: 'custom', message: 'Invalid signer key reference.' });
  return z.NEVER;
});
const signerInventoryBackendEntrySchema = z.looseObject({
  signingModule: z.string(), backend: z.unknown(), createdAt: z.string(), updatedAt: z.string(),
}).refine((entry) => Object.hasOwn(entry, 'backend'));
const signerInventoryKeySchemeSchema = z.unknown().transform((value, context) => {
  try { return publicKeyScheme.require(value); }
  catch {
    context.addIssue({ code: 'custom', message: 'Unsupported public key scheme.' });
    return z.NEVER;
  }
});
const signerInventoryKeyEntrySchema = z.looseObject({
  scheme: signerInventoryKeySchemeSchema,
  backends: z.array(signerInventoryBackendEntrySchema),
  label: storedCatalogLabelSchema.optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
const signerInventorySchema = z.looseObject({
  version: z.literal(SIGNER_INVENTORY_VERSION),
  updatedAt: z.string(),
  keys: z.record(signerKeyRefSchema, signerInventoryKeyEntrySchema),
});

/** One ordered custody backend for public signing material. */
export type SignerInventoryBackendEntry = z.infer<typeof signerInventoryBackendEntrySchema>;
/** Public metadata for one signing material item. */
export type SignerInventoryKeyEntry = z.infer<typeof signerInventoryKeyEntrySchema>;
/** Persisted public signing-material catalog. */
export type SignerInventory = z.infer<typeof signerInventorySchema>;
/** Input for inserting or updating public signing material. */
export interface UpsertSignerInventoryKeyInput {
  /** Public key identifying the signing material. */
  publicKey: Ed25519PublicKeyHex;
  /** Public-key scheme used by the signing material. */
  scheme: SignerInventoryKeyScheme;
  /** Module identifier owning the custody backend payload. */
  signingModule: string;
  /** Opaque module-owned custody backend payload. */
  backend: unknown;
  /** Optional bare label assigned when inserting an unlabeled key. */
  label?: string;
}
/** Result of inserting or updating signing material. */
export interface UpsertSignerInventoryKeyResult {
  /** Canonical reference for the inserted or updated signing material. */
  keyRef: SignerKeyRef;
}
/** Built-in selector for forgetting public signer inventory metadata. */
export type SignerInventoryForgetTarget = 'all'
  | { backend: 'software-signer'; location: SoftwareSignerBackend }
  | { backend: 'yubikey-piv'; location: PivDeviceLocator };
/** Operator-authorized signing-material label mutation. */
export interface SetSignerInventoryKeyLabelInput {
  /** Public key identifying the signing material. */
  publicKey: Ed25519PublicKeyHex;
  /** New bare label; omission preserves the current label for a set operation. */
  label?: string;
  /** Requested protection mode; omission preserves an existing mode and defaults new labels to hard. */
  mode?: CatalogLabelMode;
  /** Mutation to perform; defaults to `set`. */
  operation?: CatalogLabelOperation;
}
/** Operation-local signing-material updater. */
export interface SignerInventoryUpdater {
  /** Returns the current entry for a public key, when present. */
  getEntry(publicKey: Ed25519PublicKeyHex): SignerInventoryKeyEntry | undefined;
  /** Inserts or updates one signing-material entry and persists the catalog. */
  upsert(input: UpsertSignerInventoryKeyInput): UpsertSignerInventoryKeyResult;
}

/** Builds the canonical inventory key reference for an Ed25519 public key. */
export function ed25519SignerKeyRef(publicKey: Ed25519PublicKeyHex): SignerKeyRef { return `ed25519:${publicKey}`; }

/** Extracts a canonical Ed25519 public key from an inventory reference. */
export function publicKeyFromEd25519SignerKeyRef(keyRef: string): Ed25519PublicKeyHex | undefined {
  const key = keyRef.startsWith('ed25519:') ? ed25519PublicKey.from(keyRef.slice(8)) : undefined;
  return key !== undefined && keyRef === ed25519SignerKeyRef(key) ? key : undefined;
}

/** Loads the public signing-material catalog, returning an empty catalog only when absent. */
export function loadSignerInventory(): SignerInventory {
  const filename = getSignerInventoryPath();
  if (!protectedFileExists(filename)) return emptyInventory();
  let decoded: unknown;
  try { decoded = JSON.parse(readFileSync(filename, 'utf8')); }
  catch { throw new Error('Unsupported or invalid signer inventory format.'); }
  const result = signerInventorySchema.safeParse(decoded);
  if (!result.success) throw new Error('Unsupported or invalid signer inventory format.');
  assertUniqueLabels(result.data);
  return structuredClone(result.data);
}

/**
 * Finds signing material by a bare case-insensitive catalog label.
 *
 * @returns The canonical key reference and its public inventory entry, or `undefined` when no label matches.
 */
export function findSignerInventoryKeyByLabel(
  label: string,
): [SignerKeyRef, SignerInventoryKeyEntry] | undefined {
  return findCatalogLabel(
    Object.entries(loadSignerInventory().keys) as Array<[SignerKeyRef, SignerInventoryKeyEntry]>,
    label,
    ([, entry]) => entry.label,
  );
}

/** Atomically saves a producer-validated protected public signing-material catalog. */
export function saveSignerInventory(inventory: SignerInventory): void {
  assertUniqueLabels(inventory);
  writeProtectedJsonAtomic(getSignerInventoryPath(), inventory, 'inventory');
}

/** Inserts or updates one public signing-material item. */
export function upsertSignerInventoryKey(input: UpsertSignerInventoryKeyInput): UpsertSignerInventoryKeyResult {
  return createSignerInventoryUpdater().upsert(input);
}

/** Creates an operation-local signing-material updater. */
export function createSignerInventoryUpdater(): SignerInventoryUpdater {
  let inventory = loadSignerInventory();
  return {
    getEntry(publicKey) { return inventory.keys[ed25519SignerKeyRef(publicKey)]; },
    upsert(input) {
      const keyRef = ed25519SignerKeyRef(input.publicKey);
      const now = new Date().toISOString();
      const existing = inventory.keys[keyRef];
      const index = existing?.backends.findIndex((entry) => entry.signingModule === input.signingModule) ?? -1;
      const prior = index < 0 ? undefined : existing?.backends[index];
      const backend: SignerInventoryBackendEntry = {
        signingModule: input.signingModule,
        backend: prior === undefined ? input.backend : (mergeBuiltInSignerBackend(prior, input) ?? input.backend),
        createdAt: prior?.createdAt ?? now, updatedAt: now,
      };
      const backends = [...(existing?.backends ?? [])];
      if (index < 0) backends.push(backend); else backends[index] = backend;
      inventory.keys[keyRef] = {
        scheme: input.scheme, backends, createdAt: existing?.createdAt ?? now, updatedAt: now,
        ...(existing?.label !== undefined ? { label: existing.label }
          : input.label !== undefined ? { label: prepareCatalogLabelMutation({
            operation: 'set', label: input.label,
            otherLabels: Object.entries(inventory.keys)
              .filter(([reference]) => reference !== keyRef)
              .map(([, entry]) => entry.label),
          })! } : {}),
      };
      inventory.updatedAt = now;
      try { saveSignerInventory(inventory); } catch (error) { inventory = loadSignerInventory(); throw error; }
      return { keyRef };
    },
  };
}

/** Sets, replaces, converts, or removes an operator-managed signing-material label. */
export function setSignerInventoryKeyLabel(input: SetSignerInventoryKeyLabelInput): ParsedCatalogLabel | undefined {
  return mutateLabel(input, false);
}

/**
 * Creates, replaces, or removes a soft signing-material label.
 * Throws `CatalogLabelError` with `LABEL_PROTECTED` when a hard label protects the signing material.
 */
export function setSignerInventoryKeySoftLabel(input: { publicKey: Ed25519PublicKeyHex; label?: string }): void {
  mutateLabel({
    ...input, operation: input.label === undefined ? 'remove' : 'set',
  }, true);
}

/** Reorders a key's backends when the request is an exact permutation of persisted backend IDs. */
export function reorderSignerInventoryKeyBackends(input: {
  publicKey: Ed25519PublicKeyHex;
  backends: string[];
}): void {
  const inventory = loadSignerInventory();
  const key = requireInventoryKey(inventory, input.publicKey);
  const reordered = reorderExact(key.backends, input.backends, entry => entry.signingModule, value => value);
  if (reordered === undefined) throw new Error('Backend order must be an exact permutation of existing backends.');
  key.backends = reordered;
  touchAndSave(inventory, key);
}

/**
 * Reorders existing backend locations by backend-owned identity while preserving every stored field.
 * Unknown backends and malformed known payloads are rejected without changing the catalog.
 */
export function reorderSignerInventoryKeyLocations(input: {
  publicKey: Ed25519PublicKeyHex; signingModule: 'software-signer'; locations: SoftwareSignerBackend[];
} | {
  publicKey: Ed25519PublicKeyHex; signingModule: 'yubikey-piv'; locations: PivDeviceLocator[];
}): void {
  const inventory = loadSignerInventory();
  const key = requireInventoryKey(inventory, input.publicKey);
  const backend = requireInventoryBackend(key, input.signingModule);
  const locations = backendLocations(backend);
  if (locations === undefined) throw new Error('Signing backend does not support location ordering.');
  const identity = (value: unknown) => backendLocationIdentity(locations.kind, value);
  const reordered = reorderExact(locations.values, input.locations, identity, identity);
  if (reordered === undefined) throw new Error('Location order must be an exact permutation of existing locations.');
  backend.backend = locations.kind === 'software' ? reordered[0] : { ...locations.backend, devices: reordered };
  touchAndSave(inventory, key, backend);
}

/**
 * Forgets a whole public key record or one custody location, pruning emptied records.
 * This metadata-only operation never deletes private-key files or changes hardware.
 */
export function forgetSignerInventoryKeyLocation(
  publicKey: Ed25519PublicKeyHex,
  target: SignerInventoryForgetTarget,
): void {
  const parsedTarget = parseForgetTarget(target);
  const inventory = loadSignerInventory();
  const key = requireInventoryKey(inventory, publicKey);
  if (parsedTarget === 'all') {
    delete inventory.keys[ed25519SignerKeyRef(publicKey)];
    inventory.updatedAt = new Date().toISOString();
    saveSignerInventory(inventory);
    return;
  }
  const backend = requireInventoryBackend(key, parsedTarget.backend);
  const locations = backendLocations(backend);
  const targetIdentity = locations === undefined ? undefined : backendLocationIdentity(locations.kind, parsedTarget.location);
  if (locations === undefined || targetIdentity === undefined) {
    throw new Error('Signing backend does not support this location.');
  }
  const storedIds = locations.values.map(value => backendLocationIdentity(locations.kind, value));
  if (storedIds.some(identity => identity === undefined) || new Set(storedIds).size !== storedIds.length) {
    throw new Error('Signing backend has invalid or duplicate locations.');
  }
  const index = storedIds.indexOf(targetIdentity);
  if (index < 0) throw new Error('Signing location is not in the inventory.');
  const retained = locations.values.filter((_, candidate) => candidate !== index);
  if (retained.length === 0) key.backends.splice(key.backends.indexOf(backend), 1);
  else backend.backend = locations.kind === 'software' ? retained[0] : { ...locations.backend, devices: retained };
  if (key.backends.length === 0) delete inventory.keys[ed25519SignerKeyRef(publicKey)];
  touchAndSave(inventory, key, retained.length === 0 ? undefined : backend);
}

/** Trims and validates a bare signing-material label. */
export const normalizeSignerKeyLabel = normalizeCatalogLabel;

/** Predicate input for selecting public YubiKey inventory locations to remove. */
export interface YubiKeyInventoryLocatorPredicateInput {
  publicKey: Ed25519PublicKeyHex;
  device: YubiKeyPivDeviceLocator;
}

/** Forgets selected YubiKey locations while preserving unrelated backend metadata and order. */
export function forgetYubiKeyInventoryLocators(
  predicate: (input: YubiKeyInventoryLocatorPredicateInput) => boolean,
): { removedPublicKeys: Ed25519PublicKeyHex[] } {
  const inventory = loadSignerInventory(); const removedPublicKeys: Ed25519PublicKeyHex[] = []; const now = new Date().toISOString();
  for (const [reference, key] of Object.entries(inventory.keys)) {
    const publicKey = publicKeyFromEd25519SignerKeyRef(reference); if (publicKey === undefined) continue;
    const keyRef = ed25519SignerKeyRef(publicKey);
    const before = removedPublicKeys.length;
    const backends = key.backends.flatMap((entry) => {
      if (entry.signingModule !== 'yubikey-piv') return [entry];
      const backend = recordWithDevices(entry.backend);
      if (backend === undefined) return [entry];
      const devices = backend.devices.filter((raw) => {
        const parsed = parseBuiltInDevice(raw);
        if (parsed?.kind !== 'yubikey' || !predicate({ publicKey, device: parsed })) return true;
        removedPublicKeys.push(publicKey);
        return false;
      });
      if (devices.length === backend.devices.length) return [entry];
      return devices.length === 0 ? [] : [{ ...entry, backend: { ...backend, devices }, updatedAt: now }];
    });
    if (removedPublicKeys.length === before) continue;
    if (backends.length === 0) delete inventory.keys[keyRef]; else inventory.keys[keyRef] = { ...key, backends, updatedAt: now };
  }
  if (removedPublicKeys.length > 0) { inventory.updatedAt = now; saveSignerInventory(inventory); }
  return { removedPublicKeys };
}

/** Forgets YubiKey PIV locations for a serial and slot, optionally restricted to one public key. */
export function forgetYubiKeyPivSignerLocator(input: { publicKey?: Ed25519PublicKeyHex; serial: string; slot: string }): { removedPublicKeys: Ed25519PublicKeyHex[] } {
  return forgetYubiKeyInventoryLocators(({ publicKey, device }) => (input.publicKey === undefined || input.publicKey === publicKey) && input.serial === device.serial && input.slot === device.slot);
}

function mutateLabel(input: SetSignerInventoryKeyLabelInput, softOnly: boolean): ParsedCatalogLabel | undefined {
  const inventory = loadSignerInventory();
  const keyRef = ed25519SignerKeyRef(input.publicKey);
  const key = requireInventoryKey(inventory, input.publicKey);
  const stored = prepareCatalogLabelMutation({
    ...(key.label === undefined ? {} : { current: key.label }),
    operation: input.operation ?? 'set',
    ...(input.label === undefined ? {} : { label: input.label }),
    ...(input.mode === undefined ? {} : { mode: input.mode }),
    softOnly,
    otherLabels: Object.entries(inventory.keys)
      .filter(([reference]) => reference !== keyRef)
      .map(([, entry]) => entry.label),
  });
  if (stored === key.label) return stored === undefined ? undefined : parseCatalogLabel(stored);
  if (stored === undefined) delete key.label;
  else key.label = stored;
  key.updatedAt = new Date().toISOString(); inventory.updatedAt = key.updatedAt;
  saveSignerInventory(inventory);
  return stored === undefined ? undefined : parseCatalogLabel(stored);
}

function emptyInventory(): SignerInventory { return { version: 1, updatedAt: new Date().toISOString(), keys: {} }; }
function assertUniqueLabels(inventory: SignerInventory): void {
  assertUniqueCatalogLabels(Object.values(inventory.keys).map((entry) => entry.label));
}

function recordWithDevices(value: unknown): (Record<string, unknown> & { devices: unknown[] }) | undefined {
  if (!isRecord(value) || !Array.isArray(value.devices)) return undefined;
  return { ...value, devices: value.devices };
}

function parseBuiltInDevice(value: unknown): PivDeviceLocator | undefined {
  const devices = parseYubiKeyPivBackend({ devices: [value] })?.devices;
  return devices?.length === 1 ? devices[0] : undefined;
}

type BackendLocations =
  | { kind: 'software'; values: [unknown] }
  | { kind: 'piv'; values: unknown[]; backend: Record<string, unknown> & { devices: unknown[] } };

function backendLocations(entry: SignerInventoryBackendEntry): BackendLocations | undefined {
  if (entry.signingModule === 'software-signer') {
    if (parseSoftwareBackend(entry.backend) === undefined) return undefined;
    return { kind: 'software', values: [entry.backend] };
  }
  if (entry.signingModule !== 'yubikey-piv') return undefined;
  const backend = recordWithDevices(entry.backend);
  return backend === undefined ? undefined : { kind: 'piv', values: backend.devices, backend };
}

function backendLocationIdentity(kind: BackendLocations['kind'], value: unknown): string | undefined {
  if (kind === 'software') {
    const parsed = parseSoftwareBackend(value);
    return parsed === undefined ? undefined : canonicalJson(parsed);
  }
  const parsed = parseBuiltInDevice(value);
  return parsed === undefined ? undefined : pivDeviceLocatorIdentity(parsed);
}

function parseForgetTarget(value: unknown): SignerInventoryForgetTarget {
  if (value === 'all') return value;
  if (!isRecord(value) || Object.keys(value).length !== 2
    || !Object.hasOwn(value, 'backend') || !Object.hasOwn(value, 'location')) {
    throw new Error('Signing location target is invalid.');
  }
  if (value.backend === 'software-signer') {
    const location = parseSoftwareBackend(value.location);
    if (location !== undefined) return { backend: value.backend, location };
  } else if (value.backend === 'yubikey-piv') {
    const location = parseBuiltInDevice(value.location);
    if (location !== undefined) return { backend: value.backend, location };
  }
  throw new Error('Signing location target is invalid.');
}

function requireInventoryKey(inventory: SignerInventory, publicKey: Ed25519PublicKeyHex): SignerInventoryKeyEntry {
  const key = inventory.keys[ed25519SignerKeyRef(publicKey)];
  if (key === undefined) throw new Error('Signing material is not in the inventory.');
  return key;
}

function requireInventoryBackend(key: SignerInventoryKeyEntry, signingModule: string): SignerInventoryBackendEntry {
  const matches = key.backends.filter(entry => entry.signingModule === signingModule);
  if (matches.length !== 1) throw new Error('Signing backend is not uniquely present in the inventory.');
  return matches[0]!;
}

function touchAndSave(
  inventory: SignerInventory,
  key: SignerInventoryKeyEntry,
  backend?: SignerInventoryBackendEntry,
): void {
  const now = new Date().toISOString();
  if (backend !== undefined) backend.updatedAt = now;
  key.updatedAt = now;
  inventory.updatedAt = now;
  saveSignerInventory(inventory);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
