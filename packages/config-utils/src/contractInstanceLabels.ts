import { existsSync, readFileSync } from 'node:fs';

import { caip2Reference, contractInstance, type ContractInstanceAddress } from '@ccd-agent-kit/sdk-utils';

import { isStringRecord, readJsonFile, writeJsonFile } from './jsonFile.js';
import { findLabelScopes, resolveActiveCaip2Ref } from './labelIndexes.js';
import { getContractInstanceLabelsPath, getContractInstanceLabelsPathForNetwork } from './paths.js';
import {
  assertUniqueCatalogLabels, findCatalogLabel, normalizeCatalogLabel, parseCatalogLabel,
  prepareCatalogLabelMutation, storedCatalogLabel, type CatalogLabelMode, type CatalogLabelOperation,
  type ParsedCatalogLabel,
} from './labels.js';
import { loadNetworks } from './networks.js';

/** Network-scoped stored contract-instance labels mapped to canonical addresses. */
export type ContractInstanceLabelMap = Record<string, ContractInstanceAddress>;

/** Contract-instance labels for one network in the derived all-network index. */
export interface ContractInstanceLabelsIndexNetwork {
  /** Stored hard and soft labels mapped to canonical contract-instance addresses. */
  labels: ContractInstanceLabelMap;
}

/** Derived all-network contract-instance-label index file shape. */
export interface ContractInstanceLabelsIndex {
  /** File format version. */
  version: 1;
  /** Network label maps keyed by CAIP-2 reference. */
  networks: Record<string, ContractInstanceLabelsIndexNetwork>;
}

/** A configured network scope containing a contract-instance label match. */
export interface ContractInstanceLabelScopeMatch {
  /** Scope discriminator. */
  scope: 'network';
  /** Configured network name. */
  network: string;
  /** CAIP-2 reference for the network. */
  caip2Ref: string;
  /** Bare user-facing label. */
  label: string;
  /** Canonical configured contract-instance address. */
  address: ContractInstanceAddress;
}

/** Operator-authorized contract-instance label mutation. */
export interface SetContractInstanceLabelInput {
  /** Contract-instance address to mutate. */
  address: ContractInstanceAddress;
  /** Bare label to store, or omission to remove the address's current label. */
  label?: string;
  /** Protection mode, defaulting to `hard`. */
  mode?: CatalogLabelMode;
  /** Mutation to perform; defaults to `set`. */
  operation?: CatalogLabelOperation;
}

function parseLabelMap(value: unknown): ContractInstanceLabelMap | undefined {
  if (!isStringRecord(value)) return undefined;
  const labels: ContractInstanceLabelMap = {};
  const targets = new Set<string>();
  for (const [stored, address] of Object.entries(value)) {
    const validatedLabel = storedCatalogLabel.from(stored);
    if (validatedLabel === undefined || !isStringRecord(address)
      || typeof address.index !== 'string' || typeof address.subindex !== 'string') return undefined;
    const parsed = contractInstance.from(address);
    if (parsed === undefined || parsed.index !== address.index || parsed.subindex !== address.subindex) return undefined;
    const target = contractInstance.format(parsed);
    if (targets.has(target)) return undefined;
    targets.add(target);
    labels[validatedLabel] = parsed;
  }
  try { assertUniqueCatalogLabels(Object.keys(labels)); } catch { return undefined; }
  return labels;
}

function requireLabelMap(value: unknown): ContractInstanceLabelMap {
  const labels = parseLabelMap(value);
  if (labels === undefined) throw new Error('Invalid contract instance label map.');
  return labels;
}

function parseIndex(value: unknown): ContractInstanceLabelsIndex | undefined {
  if (!isStringRecord(value) || value.version !== 1 || !isStringRecord(value.networks)) return undefined;
  const networks: Record<string, ContractInstanceLabelsIndexNetwork> = {};
  for (const [network, entry] of Object.entries(value.networks)) {
    if (!isStringRecord(entry)) return undefined;
    const labels = parseLabelMap(entry.labels);
    if (labels === undefined) return undefined;
    networks[network] = { labels };
  }
  return { version: 1, networks };
}

function requireIndex(value: unknown): ContractInstanceLabelsIndex {
  const index = parseIndex(value);
  if (index === undefined) throw new Error('Invalid contract instance labels index.');
  return index;
}

/** Loads the validated derived all-network contract-instance-label index. */
export function loadContractInstanceLabelsIndex(): ContractInstanceLabelsIndex {
  return readJsonFile(getContractInstanceLabelsPath(), parseIndex) ?? { version: 1, networks: {} };
}

/** Validates and saves the derived all-network contract-instance-label index. */
export function saveContractInstanceLabelsIndex(index: ContractInstanceLabelsIndex): void {
  writeJsonFile(getContractInstanceLabelsPath(), requireIndex(index));
}

/** Rebuilds the derived index from configured networks' authoritative label maps. */
export function rebuildContractInstanceLabelsIndex(): ContractInstanceLabelsIndex {
  const index: ContractInstanceLabelsIndex = { version: 1, networks: {} };
  for (const config of Object.values(loadNetworks().networks)) {
    const ref = caip2Reference(config.caip2);
    const labels = loadContractInstanceLabels(ref);
    if (Object.keys(labels).length > 0) index.networks[ref] = { labels };
  }
  saveContractInstanceLabelsIndex(index);
  return index;
}

/** Loads one network's authoritative labels, throwing when existing data is invalid. */
export function loadContractInstanceLabels(caip2Ref?: string): ContractInstanceLabelMap {
  const path = getContractInstanceLabelsPathForNetwork(resolveActiveCaip2Ref(caip2Ref));
  if (!existsSync(path)) return {};
  return requireLabelMap(JSON.parse(readFileSync(path, 'utf8')) as unknown);
}

/** Validates and saves one authoritative network label map and synchronizes the derived index. */
export function saveContractInstanceLabels(labels: ContractInstanceLabelMap, caip2Ref?: string): void {
  const ref = resolveActiveCaip2Ref(caip2Ref);
  const normalized = requireLabelMap(labels);
  const index = loadContractInstanceLabelsIndex();
  if (Object.keys(normalized).length === 0) delete index.networks[ref];
  else index.networks[ref] = { labels: normalized };
  writeJsonFile(getContractInstanceLabelsPathForNetwork(ref), normalized);
  saveContractInstanceLabelsIndex(index);
}

/** Resolves a trimmed valid bare label to its configured address. */
export function resolveContractInstanceLabel(label: string, caip2Ref?: string): ContractInstanceAddress | undefined {
  const normalized = normalizeSelector(label);
  if (normalized === undefined) return undefined;
  return findCatalogLabel(Object.entries(loadContractInstanceLabels(caip2Ref)), normalized, ([stored]) => stored)?.[1];
}

/** Finds the bare label configured for a contract-instance address. */
export function findContractInstanceLabelForAddress(
  address: ContractInstanceAddress,
  caip2Ref?: string,
): string | undefined {
  const match = findAddressEntry(loadContractInstanceLabels(caip2Ref), contractInstance.format(address));
  return match === undefined ? undefined : parseCatalogLabel(match[0]).label;
}

/** Sets, converts, relabels, or removes the sole label for one canonical address. */
export function setContractInstanceLabel(
  input: SetContractInstanceLabelInput,
  caip2Ref?: string,
): ParsedCatalogLabel | undefined {
  const ref = resolveActiveCaip2Ref(caip2Ref);
  const address = contractInstance.require(input.address);
  const labels = loadContractInstanceLabels(ref);
  const result = replaceLabel(labels, address, input, false);
  saveContractInstanceLabels(labels, ref);
  return result;
}

/** Creates, replaces, or removes a soft label unless a relevant hard label is protected. */
export function setSoftContractInstanceLabel(
  label: string | undefined,
  address: ContractInstanceAddress,
  caip2Ref?: string,
): void {
  const ref = resolveActiveCaip2Ref(caip2Ref);
  const canonicalAddress = contractInstance.require(address);
  const labels = loadContractInstanceLabels(ref);
  const current = findAddressEntry(labels, contractInstance.format(canonicalAddress));
  const result = replaceLabel(labels, canonicalAddress, {
    operation: label === undefined ? 'remove' : 'set', ...(label === undefined ? {} : { label }),
  }, true);
  if (current !== undefined && result !== undefined
    && current[0] === result.label && result.mode === 'hard') return;
  saveContractInstanceLabels(labels, ref);
}

function replaceLabel(
  labels: ContractInstanceLabelMap,
  address: ContractInstanceAddress,
  input: Pick<SetContractInstanceLabelInput, 'label' | 'mode' | 'operation'>,
  softOnly: boolean,
): ParsedCatalogLabel | undefined {
  const target = contractInstance.format(address);
  const current = findAddressEntry(labels, target)?.[0];
  const stored = prepareCatalogLabelMutation({
    ...(current === undefined ? {} : { current }),
    operation: input.operation ?? 'set',
    ...(input.label === undefined ? {} : { label: input.label }),
    ...(input.mode === undefined ? {} : { mode: input.mode }),
    softOnly,
    otherLabels: Object.entries(labels)
      .filter(([, candidate]) => contractInstance.format(candidate) !== target)
      .map(([label]) => label),
  });
  for (const [stored, current] of Object.entries(labels)) {
    if (contractInstance.format(current) === target) delete labels[stored];
  }
  if (stored === undefined) return undefined;
  labels[stored] = address;
  return parseCatalogLabel(stored);
}

function findAddressEntry(labels: ContractInstanceLabelMap, target: string): [string, ContractInstanceAddress] | undefined {
  return Object.entries(labels).find(([, address]) => contractInstance.format(address) === target);
}

function normalizeSelector(label: string): string | undefined {
  try { return normalizeCatalogLabel(label); }
  catch { return undefined; }
}

/** Finds configured-network scopes containing a trimmed valid bare label. */
export function findContractInstanceLabelScopes(label: string): ContractInstanceLabelScopeMatch[] {
  const normalized = normalizeSelector(label);
  if (normalized === undefined) return [];
  return findLabelScopes((caip2Ref, network) => {
    const labels = loadContractInstanceLabels(caip2Ref);
    const match = findCatalogLabel(Object.entries(labels), normalized, ([stored]) => stored);
    return match === undefined ? undefined : {
      scope: 'network', network, caip2Ref, label: parseCatalogLabel(match[0]).label, address: match[1],
    };
  });
}

/** Finds configured-network scopes containing a contract-instance address. */
export function findContractInstanceAddressLabelScopes(address: ContractInstanceAddress): ContractInstanceLabelScopeMatch[] {
  const target = contractInstance.format(address);
  return findLabelScopes((caip2Ref, network) => {
    const match = findAddressEntry(loadContractInstanceLabels(caip2Ref), target);
    return match === undefined ? undefined : {
      scope: 'network', network, caip2Ref, label: parseCatalogLabel(match[0]).label, address: match[1],
    };
  });
}
