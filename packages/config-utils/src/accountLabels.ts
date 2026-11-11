import { sameAccount } from '@ccd-agent-kit/sdk-utils';

import { isStringRecord, readJsonFile, writeJsonFile } from './jsonFile.js';
import {
  findLabelScopes, loadLabelIndex, rebuildLabelIndex, resolveActiveCaip2Ref, updateLabelIndexForNetwork,
} from './labelIndexes.js';
import { getAccountLabelsPath, getAccountLabelsPathForNetwork } from './paths.js';
import {
  CATALOG_LABEL_PATTERN, assertUniqueCatalogLabels, findCatalogLabel, parseCatalogLabel,
  prepareCatalogLabelMutation, type CatalogLabelError, type CatalogLabelMode, type CatalogLabelOperation,
  type ParsedCatalogLabel,
} from './labels.js';

/** A local account-label-to-address mapping. */
export type AccountLabelMap = Record<string, string>;

/** Account labels are short local selectors that cannot collide with account indexes or 50-character addresses. */
export type AccountLabel = string;

/** Pattern for valid local account labels. */
export const ACCOUNT_LABEL_PATTERN = CATALOG_LABEL_PATTERN;

/** Indexed account labels for one network in the shared all-network account-label index. */
export interface AccountLabelsIndexNetwork {
  /** Network-specific addresses keyed by account label. */
  labels: AccountLabelMap;
}

/** Shared all-network account-label index file shape. */
export interface AccountLabelsIndex {
  /** File format version. */
  version: 1;
  /** Network account labels keyed by CAIP-2 reference. */
  networks: Record<string, AccountLabelsIndexNetwork>;
}

/** Scope where an account-label mapping was found. */
export interface AccountLabelScopeMatch {
  /** Network scope discriminator. */
  scope: 'network';
  /** Configured network name that produced the mapping. */
  network: string;
  /** CAIP-2 reference used to load the network mapping. */
  caip2Ref: string;
  /** Configured account label. */
  label: string;
  /** Configured account address. */
  address: string;
}

/** One account label resolved from a single network catalog snapshot. */
export interface ResolvedAccountLabel {
  /** Native address stored on the selected label entry. */
  address: string;
  /** Canonical bare label spelling from the selected stored entry. */
  label: string;
}

/** Operator-authorized account-label mutation. */
export interface SetAccountLabelInput {
  /** Account address whose alias-equivalent label is mutated. */
  address: string;
  /** New bare label; omission preserves the current label for a set operation. */
  label?: string;
  /** Requested protection mode; omission preserves an existing mode and defaults new labels to hard. */
  mode?: CatalogLabelMode;
  /** Mutation to perform; defaults to `set`. */
  operation?: CatalogLabelOperation;
}

function isAccountLabelMap(value: unknown): value is AccountLabelMap {
  return isStringRecord(value) && Object.values(value).every((entry) => typeof entry === 'string');
}

function parseAccountLabelMap(value: unknown): AccountLabelMap | undefined {
  return isAccountLabelMap(value) ? value : undefined;
}

function loadAccountLabelsFile(filePath: string): AccountLabelMap | undefined {
  return readJsonFile(filePath, (parsed) => (isStringRecord(parsed) ? (parsed as AccountLabelMap) : undefined));
}

/** Loads the shared all-network account-label index. */
export function loadAccountLabelsIndex(): AccountLabelsIndex {
  return loadLabelIndex(getAccountLabelsPath(), parseAccountLabelMap, true);
}

/** Saves the shared all-network account-label index. */
export function saveAccountLabelsIndex(index: AccountLabelsIndex): void {
  writeJsonFile(getAccountLabelsPath(), index);
}

/** Rebuilds the shared all-network account-label index from network-specific files. */
export function rebuildAccountLabelsIndex(): AccountLabelsIndex {
  return rebuildLabelIndex(loadAccountLabels, saveAccountLabelsIndex);
}

/** Loads account labels for a network, using the active default network when omitted. */
export function loadAccountLabels(caip2Ref?: string): AccountLabelMap {
  const labels = loadAccountLabelsFile(getAccountLabelsPathForNetwork(resolveActiveCaip2Ref(caip2Ref))) ?? {};
  validateAccountLabelMap(labels);
  return labels;
}

/** Saves account labels for a network and synchronizes the shared index, using the active default network when omitted. */
export function saveAccountLabels(labels: AccountLabelMap, caip2Ref?: string): void {
  const resolvedCaip2Ref = resolveActiveCaip2Ref(caip2Ref);
  validateAccountLabelMap(labels);
  writeJsonFile(getAccountLabelsPathForNetwork(resolvedCaip2Ref), labels);
  updateLabelIndexForNetwork(getAccountLabelsPath(), resolvedCaip2Ref, labels, parseAccountLabelMap, true);
}

/** Resolves a bare account-label selector to its canonical stored label and native address. */
export function resolveAccountLabel(selector: string, caip2Ref?: string): ResolvedAccountLabel | undefined {
  const normalized = normalizeAccountLabelSelector(selector);
  if (normalized === undefined) return undefined;
  const match = findCatalogLabel(Object.entries(loadAccountLabels(caip2Ref)), normalized, ([stored]) => stored);
  return match === undefined ? undefined : { address: match[1], label: parseAccountLabel(match[0]) };
}

/** Finds the configured account label for an address, using alias-aware matching when possible. */
export function findAccountLabelForAddress(address: string, caip2Ref?: string): string | undefined {
  return findAccountLabelInMap(address, loadAccountLabels(caip2Ref));
}

/** Finds a label in an already-loaded map, preferring an exact address match over aliases without reading state. */
export function findAccountLabelInMap(address: string, labels: AccountLabelMap): string | undefined {
  const stored = findAccountEntry(labels, address)?.[0];
  return stored === undefined ? undefined : parseAccountLabel(stored);
}

function findAccountEntry(labels: AccountLabelMap, address: string): [string, string] | undefined {
  const entries = Object.entries(labels);
  // An earlier alias must not hide a later exact address match.
  return entries.find(([, value]) => value === address) ?? entries.find(([, value]) => sameAccount(value, address));
}

/**
 * Sets, converts, or removes the sole operator-managed label for an alias-equivalent account.
 * Supplied bare labels are trimmed and validated before the network mapping is changed.
 */
export function setAccountLabel(
  input: SetAccountLabelInput,
  caip2Ref?: string,
): ParsedCatalogLabel | undefined {
  const { address } = input;
  const resolvedCaip2Ref = resolveActiveCaip2Ref(caip2Ref);
  const labels = loadAccountLabels(resolvedCaip2Ref);
  const result = replaceAccountLabel(labels, address, input, false);
  if (result.changed) saveAccountLabels(labels, resolvedCaip2Ref);
  return result.label;
}

/**
 * Creates, replaces, or removes a trimmed bare agent-modifiable account label unless any alias has a hard label.
 */
export function setSoftAccountLabel(label: string | undefined, address: string, caip2Ref?: string): void {
  const resolvedCaip2Ref = resolveActiveCaip2Ref(caip2Ref);
  const labels = loadAccountLabels(resolvedCaip2Ref);
  const result = replaceAccountLabel(labels, address, {
    operation: label === undefined ? 'remove' : 'set', ...(label === undefined ? {} : { label }),
  }, true);
  if (!result.changed) return;
  saveAccountLabels(labels, resolvedCaip2Ref);
}

interface AccountLabelMutationResult {
  label: ParsedCatalogLabel | undefined;
  changed: boolean;
}

function replaceAccountLabel(
  labels: AccountLabelMap,
  address: string,
  input: Pick<SetAccountLabelInput, 'label' | 'mode' | 'operation'>,
  softOnly: boolean,
): AccountLabelMutationResult {
  const current = findAccountMutationEntry(labels, address)?.[0];
  const stored = prepareMutation({
    ...(current === undefined ? {} : { current }),
    operation: input.operation ?? 'set',
    ...(input.label === undefined ? {} : { label: input.label }),
    ...(input.mode === undefined ? {} : { mode: input.mode }),
    softOnly,
    otherLabels: Object.entries(labels)
      .filter(([, currentAddress]) => !sameAccount(currentAddress, address))
      .map(([label]) => label),
  });
  const parsed = stored === undefined ? undefined : parseCatalogLabel(stored);
  if (softOnly && stored === current && parsed?.mode === 'hard') {
    return { label: parsed, changed: false };
  }
  removeLabelsForAccount(labels, address);
  if (stored === undefined) return { label: undefined, changed: current !== undefined };
  labels[stored] = address;
  return { label: parsed, changed: true };
}

function findAccountMutationEntry(labels: AccountLabelMap, address: string): [string, string] | undefined {
  const aliases = Object.entries(labels).filter(([, current]) => sameAccount(current, address));
  return aliases.find(([stored]) => !stored.startsWith('@'))
    ?? aliases.find(([, current]) => current === address)
    ?? aliases[0];
}

/** Returns whether a local account label satisfies the shared non-ambiguous syntax. */
export function isValidAccountLabel(label: string): label is AccountLabel {
  return ACCOUNT_LABEL_PATTERN.test(label);
}

/** Throws when a local account label can collide with an account index/address selector. */
export function assertValidAccountLabel(label: string): asserts label is AccountLabel {
  if (!isValidAccountLabel(label)) throw new Error('Account labels must be 1-49 characters, start with a letter, and contain only letters, digits, underscores, or hyphens.');
}

function validateAccountLabelMap(labels: AccountLabelMap): void {
  for (const label of Object.keys(labels)) {
    if (!label.startsWith('@')) assertValidAccountLabel(label);
    parseAccountLabel(label);
  }
  assertUniqueCatalogLabels(Object.keys(labels));
}

/**
 * Removes a mapping selected by a trimmed valid bare label and synchronizes the shared index.
 * Invalid selectors return `false`; the active default network is used when omitted.
 */
export function removeAccountLabel(label: string, caip2Ref?: string): boolean {
  const normalized = normalizeAccountLabelSelector(label);
  if (normalized === undefined) return false;
  const resolvedCaip2Ref = resolveActiveCaip2Ref(caip2Ref);
  const labels = loadAccountLabels(resolvedCaip2Ref);
  const stored = findCatalogLabel(Object.keys(labels), normalized, (entry) => entry);
  if (stored === undefined) return false;
  delete labels[stored];
  saveAccountLabels(labels, resolvedCaip2Ref);
  return true;
}

function parseAccountLabel(stored: string): string {
  try { return parseCatalogLabel(stored).label; }
  catch { throw new Error('Unsupported or invalid account label format.'); }
}

function removeLabelsForAccount(labels: AccountLabelMap, address: string): void {
  for (const [label, current] of Object.entries(labels)) if (sameAccount(current, address)) delete labels[label];
}

/** Lists configured account-label addresses for a network, using the active default network when omitted. */
export function listAccountLabelAddresses(caip2Ref?: string): string[] {
  return Object.values(loadAccountLabels(caip2Ref));
}

/**
 * Finds all network-specific scopes containing a trimmed valid bare account label.
 * Invalid selectors return an empty array; matches include each producer-guaranteed network identity.
 */
export function findAccountLabelScopes(label: string): AccountLabelScopeMatch[] {
  const normalized = normalizeAccountLabelSelector(label);
  if (normalized === undefined) return [];
  return findLabelScopes((caip2Ref, network) => {
    const match = findCatalogLabel(Object.entries(loadAccountLabels(caip2Ref)), normalized, ([stored]) => stored);
    return match === undefined ? undefined : {
      scope: 'network', network, caip2Ref, label: parseAccountLabel(match[0]), address: match[1],
    };
  });
}

function prepareMutation(input: Parameters<typeof prepareCatalogLabelMutation>[0]) {
  try { return prepareCatalogLabelMutation(input); }
  catch (error) {
    const labelError = error as CatalogLabelError;
    if (labelError.code === 'DUPLICATE_LABEL') labelError.message = 'Account label is already used.';
    throw error;
  }
}

function normalizeAccountLabelSelector(label: string): string | undefined {
  const normalized = label.trim();
  return isValidAccountLabel(normalized) ? normalized : undefined;
}

/**
 * Finds all network-specific scopes containing an address, using address-alias-aware matching and including each
 * producer-guaranteed network identity.
 */
export function findAddressLabelScopes(address: string): AccountLabelScopeMatch[] {
  return findLabelScopes((caip2Ref, network) => {
    const match = findAccountEntry(loadAccountLabels(caip2Ref), address);
    return match === undefined ? undefined : { scope: 'network', network, caip2Ref, label: parseAccountLabel(match[0]), address: match[1] };
  });
}
