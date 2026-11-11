import {
  caip2FromGenesis,
  caip2Reference,
  MAINNET_GENESIS_HASH,
  TESTNET_GENESIS_HASH,
} from '@ccd-agent-kit/sdk-utils';
import {
  NetworkResourceError,
  type NetworkResourceAdapter,
  type NetworkResourceNetwork,
} from '@ccd-agent-kit/mcp-utils';

import { readJsonFile, writeJsonFile } from './jsonFile.js';
import { CATALOG_LABEL_PATTERN, normalizeCatalogLabel } from './labels.js';
import { getNetworksFilePath } from './paths.js';

/** gRPC connection details for a configured CCD network. */
export interface NetworkGrpc {
  /** gRPC server hostname or IP address. */
  host: string;
  /** gRPC server port. */
  port: number;
  /** Whether to use TLS. */
  ssl: boolean;
}

/** Persisted configuration for one CCD network. */
export interface NetworkConfig {
  /** CAIP-2 identifier, for example `ccd:9dd9ca4d19e9393877d2c44b70f89acb`. */
  caip2: string;
  /** Full 64-character genesis block hash. */
  genesisHash: string;
  /** gRPC connection details. */
  grpc: NetworkGrpc;
}

/** Persisted network registry file shape. */
export interface NetworksFile {
  /** Name of the persisted default network. */
  default: string;
  /** Configured networks keyed by user-facing network name. */
  networks: Record<string, NetworkConfig>;
}

/** A resolved network and its user-facing name. */
export interface ResolvedNetwork {
  /** Network name from the registry. */
  name: string;
  /** Network configuration. */
  config: NetworkConfig;
}

/** Source that selected the active default network. */
export type DefaultNetworkSource = 'config' | 'session';

/** Environment variable that overrides the configured default network for one process. */
export const SESSION_NETWORK_ENV = 'CCD_NETWORK';

/** Built-in network names that are always available. */
export const BUILTIN_NETWORKS = ['mainnet', 'testnet'] as const;

const DEFAULT_NETWORKS: Record<string, NetworkConfig> = {
  mainnet: {
    caip2: caip2FromGenesis(MAINNET_GENESIS_HASH),
    genesisHash: MAINNET_GENESIS_HASH,
    grpc: { host: 'grpc.mainnet.concordium.software', port: 20000, ssl: true },
  },
  testnet: {
    caip2: caip2FromGenesis(TESTNET_GENESIS_HASH),
    genesisHash: TESTNET_GENESIS_HASH,
    grpc: { host: 'grpc.testnet.concordium.software', port: 20000, ssl: true },
  },
};

const DEFAULT_REGISTRY: NetworksFile = { default: 'mainnet', networks: { ...DEFAULT_NETWORKS } };

function isCanonicalNetworkName(value: string): boolean {
  return CATALOG_LABEL_PATTERN.test(value);
}

function isNetworkConfig(value: unknown): value is NetworkConfig {
  const candidate = value as Partial<NetworkConfig> | undefined;
  const grpc = candidate?.grpc as Partial<NetworkGrpc> | undefined;
  return (
    typeof candidate?.caip2 === 'string' &&
    typeof candidate.genesisHash === 'string' &&
    /^[0-9a-f]{64}$/.test(candidate.genesisHash) &&
    candidate.caip2 === `ccd:${candidate.genesisHash.slice(0, 32)}` &&
    typeof grpc?.host === 'string' &&
    typeof grpc.port === 'number' &&
    typeof grpc.ssl === 'boolean'
  );
}

function isNetworksFile(value: unknown): value is NetworksFile {
  const candidate = value as Partial<NetworksFile> | undefined;
  return (
    typeof candidate?.default === 'string' &&
    isCanonicalNetworkName(candidate.default) &&
    typeof candidate.networks === 'object' &&
    candidate.networks !== null &&
    !Array.isArray(candidate.networks) &&
    Object.keys(candidate.networks).every(isCanonicalNetworkName) &&
    Object.values(candidate.networks).every(isNetworkConfig)
  );
}

function assertNetworkConfig(config: unknown, name: string): asserts config is NetworkConfig {
  if (!isNetworkConfig(config)) throw new Error(`Invalid network config for '${name}'.`);
}

function normalizeNetworksFile(value: unknown): NetworksFile | undefined {
  if (!isNetworksFile(value)) return undefined;
  return { default: value.default, networks: { ...DEFAULT_NETWORKS, ...value.networks } };
}

/** Loads the configured network registry, falling back to built-in networks when missing or invalid. */
export function loadNetworks(): NetworksFile {
  return readJsonFile(getNetworksFilePath(), normalizeNetworksFile) ?? { ...DEFAULT_REGISTRY, networks: { ...DEFAULT_NETWORKS } };
}

/** Saves the network registry, creating its parent directory when needed. */
export function saveNetworks(config: NetworksFile): void {
  if (!isNetworksFile(config)) throw new Error('Invalid network config registry.');
  writeJsonFile(getNetworksFilePath(), config);
}

/** Returns a network by trimmed configured name, or `undefined` for an invalid or missing name. */
export function getNetwork(name: string): NetworkConfig | undefined {
  const normalized = name.trim();
  if (!CATALOG_LABEL_PATTERN.test(normalized)) return undefined;
  const networks = loadNetworks().networks;
  return Object.hasOwn(networks, normalized) ? networks[normalized] : undefined;
}

/** Finds a network by CAIP-2 reference. */
export function getNetworkByCaip2Reference(reference: string): ResolvedNetwork | undefined {
  for (const [name, config] of Object.entries(loadNetworks().networks)) {
    if (caip2Reference(config.caip2) === reference) return { name, config };
  }
  return undefined;
}

function getNetworkByCaip2ReferenceFromRegistry(reference: string, registry: NetworksFile): ResolvedNetwork | undefined {
  const entry = Object.entries(registry.networks).find(([, config]) => caip2Reference(config.caip2) === reference);
  return entry === undefined ? undefined : { name: entry[0], config: entry[1] };
}

function findNetworkByCaip2FromRegistry(identifier: string, registry: NetworksFile): ResolvedNetwork | undefined {
  return getNetworkByCaip2ReferenceFromRegistry(identifier.startsWith('ccd:') ? caip2Reference(identifier) : identifier.slice(0, 32), registry);
}

function resolveExplicitNetwork(identifier: string, registry: NetworksFile): ResolvedNetwork | undefined {
  const selector = identifier.trim();
  if (selector.startsWith('ccd:')) return findNetworkByCaip2FromRegistry(selector, registry);
  const config = Object.hasOwn(registry.networks, selector) ? registry.networks[selector] : undefined;
  return config ? { name: selector, config } : getNetworkByCaip2ReferenceFromRegistry(selector, registry);
}

/** Returns the persisted default network, falling back to mainnet when the configured default is missing. */
export function getDefaultNetwork(): ResolvedNetwork {
  const registry = loadNetworks();
  const config = Object.hasOwn(registry.networks, registry.default) ? registry.networks[registry.default] : undefined;
  return config ? { name: registry.default, config } : { name: 'mainnet', config: registry.networks.mainnet! };
}

/** Returns the active network from an already loaded registry, honoring `CCD_NETWORK`. */
export function getActiveNetworkFromRegistry(registry: NetworksFile): ResolvedNetwork & { source: DefaultNetworkSource } {
  const sessionNetwork = process.env[SESSION_NETWORK_ENV];
  if (sessionNetwork) {
    const resolved = resolveExplicitNetwork(sessionNetwork, registry);
    if (!resolved) throw new Error(`Session network '${sessionNetwork}' from ${SESSION_NETWORK_ENV} not found.`);
    return { ...resolved, source: 'session' };
  }
  const config = Object.hasOwn(registry.networks, registry.default) ? registry.networks[registry.default] : undefined;
  return { ...(config ? { name: registry.default, config } : { name: 'mainnet', config: registry.networks.mainnet! }), source: 'config' };
}

/** Returns the active default network, honoring `CCD_NETWORK` as a session override. */
export function getActiveNetwork(): ResolvedNetwork & { source: DefaultNetworkSource } {
  return getActiveNetworkFromRegistry(loadNetworks());
}

/** Resolves a trimmed selector from an already loaded registry, or the active default when omitted. */
export function resolveNetworkFromRegistry(name: string | undefined, registry: NetworksFile): ResolvedNetwork {
  if (name === undefined) return getActiveNetworkFromRegistry(registry);
  const resolved = resolveExplicitNetwork(name, registry);
  if (!resolved) throw new Error(`Network '${name}' not found.`);
  return resolved;
}

/** Resolves a trimmed network name, CAIP-2 reference, full CAIP-2 identifier, or the active default network. */
export function resolveNetwork(name?: string): ResolvedNetwork {
  return resolveNetworkFromRegistry(name, loadNetworks());
}

function networkResourceNetwork(resolved: ResolvedNetwork): NetworkResourceNetwork<NetworkConfig> {
  return {
    name: resolved.name,
    caip2: resolved.config.caip2 as `ccd:${string}`,
    value: resolved.config,
  };
}

/**
 * Creates the config-owned adapter for shared network-scoped MCP resources.
 *
 * Every operation loads exactly one registry snapshot. Unknown or invalid selectors are
 * mapped to a path-safe `NETWORK_NOT_FOUND` failure.
 */
export function createNetworkResourceAdapter(): NetworkResourceAdapter<NetworkConfig> {
  return {
    list: () => {
      const registry = loadNetworks();
      return Object.entries(registry.networks)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, config]) => networkResourceNetwork({ name, config }));
    },
    resolveDefault: () => {
      const registry = loadNetworks();
      try {
        return networkResourceNetwork(resolveNetworkFromRegistry(undefined, registry));
      } catch {
        throw new NetworkResourceError('NETWORK_NOT_FOUND', 'No default network is configured.');
      }
    },
    resolve: (selector) => {
      const registry = loadNetworks();
      try {
        return networkResourceNetwork(resolveNetworkFromRegistry(selector, registry));
      } catch {
        throw new NetworkResourceError('NETWORK_NOT_FOUND', 'The selected network is not configured.');
      }
    },
  };
}

/** Lists all configured network names. */
export function listNetworks(): string[] {
  return Object.keys(loadNetworks().networks);
}

/** Lists all configured network names sorted by locale-aware string order. */
export function listSortedNetworks(): string[] {
  return listNetworks().slice().sort((left, right) => left.localeCompare(right));
}

/** Adds a network after trimming and validating its configured name. */
export function addNetwork(name: string, config: NetworkConfig): void {
  const normalized = normalizeCatalogLabel(name);
  assertNetworkConfig(config, normalized);
  const registry = loadNetworks();
  if (Object.hasOwn(registry.networks, normalized)) throw new Error(`Network '${normalized}' already exists. Use 'network update' to modify it.`);
  assertGenesisHashAvailable(config.genesisHash, registry);
  registry.networks[normalized] = config;
  saveNetworks(registry);
}

/** Updates an existing network selected by its trimmed, validated configured name. */
export function updateNetwork(name: string, updates: Partial<NetworkConfig>): void {
  const normalized = normalizeCatalogLabel(name);
  const registry = loadNetworks();
  const existing = Object.hasOwn(registry.networks, normalized) ? registry.networks[normalized] : undefined;
  if (!existing) throw new Error(`Network '${normalized}' not found.`);
  const updated = { ...existing, ...updates, grpc: updates.grpc ?? existing.grpc };
  assertNetworkConfig(updated, normalized);
  if (updated.genesisHash !== existing.genesisHash) assertGenesisHashAvailable(updated.genesisHash, registry, normalized);
  registry.networks[normalized] = updated;
  saveNetworks(registry);
}

function assertGenesisHashAvailable(genesisHash: string, registry: NetworksFile, exceptName?: string): void {
  const match = Object.entries(registry.networks)
    .find(([name, config]) => name !== exceptName && config.genesisHash === genesisHash);
  if (match !== undefined) throw new Error(`Network '${match[0]}' already uses this genesis hash.`);
}

/** Removes a non-built-in network selected by its trimmed, validated configured name. */
export function removeNetwork(name: string): void {
  const normalized = normalizeCatalogLabel(name);
  const registry = loadNetworks();
  if (!Object.hasOwn(registry.networks, normalized)) throw new Error(`Network '${normalized}' not found.`);
  if ((BUILTIN_NETWORKS as readonly string[]).includes(normalized)) throw new Error(`Cannot remove built-in network '${normalized}'.`);
  delete registry.networks[normalized];
  if (registry.default === normalized) registry.default = 'mainnet';
  saveNetworks(registry);
}

/** Sets the persisted default network by its trimmed, validated configured name. */
export function setDefaultNetwork(name: string): void {
  const normalized = normalizeCatalogLabel(name);
  const registry = loadNetworks();
  if (!Object.hasOwn(registry.networks, normalized)) throw new Error(`Network '${normalized}' not found.`);
  registry.default = normalized;
  saveNetworks(registry);
}

/** Finds a network by full CAIP-2 identifier, CAIP-2 reference, or full genesis hash. */
export function findNetworkByCaip2(identifier: string): ResolvedNetwork | undefined {
  return findNetworkByCaip2FromRegistry(identifier, loadNetworks());
}
