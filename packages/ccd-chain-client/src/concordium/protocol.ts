import type { ConcordiumQueryClient } from './client.js';

/** A chain feature exposed by the capability resource for the effective protocol version. */
export type ChainCapability =
  | 'ccd.transfer'
  | 'ccd.registerData'
  | 'staking.query'
  | 'staking.configure'
  | 'contract.info'
  | 'contract.invoke'
  | 'contract.update'
  | 'plt.list'
  | 'plt.info'
  | 'plt.balance'
  | 'plt.transfer'
  | 'plt.mint'
  | 'plt.burn'
  | 'plt.allowList.update'
  | 'plt.denyList.update'
  | 'plt.pause'
  | 'plt.metadata.update'
  | 'lock.list'
  | 'lock.info'
  | 'plt.lock.create'
  | 'plt.lock.fund'
  | 'plt.lock.send'
  | 'plt.lock.cancel'
  | 'plt.lock.release';

/** Protocol behavior used internally to select supported chain-client transaction paths. */
export interface ProtocolCapabilities {
  networkProtocolVersion: number;
  effectiveProtocolVersion: number;
  supportsLocks: boolean;
  /** Whether PLT writes use a payload-level token id or operation-level token ids. */
  pltWriteMode: 'scoped' | 'unscoped';
  requiresGovernanceForNonTransferPltOps: boolean;
}

const KNOWN_PROTOCOL_BEHAVIOR = [
  {
    version: 10,
    supportsLocks: false,
    pltWriteMode: 'scoped' as const,
    requiresGovernanceForNonTransferPltOps: true,
  },
  {
    version: 11,
    supportsLocks: true,
    pltWriteMode: 'unscoped' as const,
    requiresGovernanceForNonTransferPltOps: false,
  },
] as const;

const BASE_CAPABILITIES: ChainCapability[] = [
  'ccd.transfer',
  'ccd.registerData',
  'staking.query',
  'staking.configure',
  'contract.info',
  'contract.invoke',
  'contract.update',
  'plt.list',
  'plt.info',
  'plt.balance',
  'plt.transfer',
  'plt.mint',
  'plt.burn',
  'plt.allowList.update',
  'plt.denyList.update',
  'plt.pause',
  'plt.metadata.update',
];

const LOCK_CAPABILITIES: ChainCapability[] = [
  'lock.list',
  'lock.info',
  'plt.lock.create',
  'plt.lock.fund',
  'plt.lock.send',
  'plt.lock.cancel',
  'plt.lock.release',
];

export interface ChainCapabilities {
  network: string;
  protocolVersion: number;
  capabilities: ChainCapability[];
}

export interface ChainCapabilityError {
  kind: 'chain-capability';
  capability: ChainCapability;
  network: string;
  message: string;
}

export function chainCapabilitiesForProtocol(protocolVersion: number): ChainCapability[] {
  const capabilities = [...BASE_CAPABILITIES];
  if (protocolVersion >= 11) capabilities.push(...LOCK_CAPABILITIES);
  return capabilities;
}

export async function resolveProtocolCapabilities(client: ConcordiumQueryClient): Promise<ProtocolCapabilities> {
  const networkProtocolVersion = await client.getProtocolVersion();
  const latestKnownProtocolVersion = KNOWN_PROTOCOL_BEHAVIOR[KNOWN_PROTOCOL_BEHAVIOR.length - 1]!.version;
  const effectiveProtocolVersion = Math.min(networkProtocolVersion, latestKnownProtocolVersion);
  const behavior =
    [...KNOWN_PROTOCOL_BEHAVIOR].reverse().find((entry) => entry.version <= effectiveProtocolVersion) ??
    KNOWN_PROTOCOL_BEHAVIOR[0];
  return {
    networkProtocolVersion,
    effectiveProtocolVersion: behavior.version,
    supportsLocks: behavior.supportsLocks,
    pltWriteMode: behavior.pltWriteMode,
    requiresGovernanceForNonTransferPltOps: behavior.requiresGovernanceForNonTransferPltOps,
  };
}

export async function resolveChainCapabilities(
  client: ConcordiumQueryClient,
  network: string,
): Promise<ChainCapabilities> {
  const capabilities = await resolveProtocolCapabilities(client);
  return {
    network,
    protocolVersion: capabilities.networkProtocolVersion,
    capabilities: chainCapabilitiesForProtocol(capabilities.effectiveProtocolVersion),
  };
}
