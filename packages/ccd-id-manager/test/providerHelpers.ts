import path from 'node:path';
import { vi } from 'vitest';
import type { IdentityContextSnapshot } from '@ccd-agent-kit/sdk-utils';
import type {
  CanonicalNetwork,
  FinalizedIdentityProviderContext,
  IdentityProviderRegistry,
  ProviderInventory,
  ProviderRegistrySnapshot,
  ProviderSettings,
} from '../src/core/providers/types.js';
import { useTestXdg } from './xdgTestHelpers.js';

export const GENESIS = '12'.repeat(32);
export const OTHER_GENESIS = '34'.repeat(32);
export const NETWORK: CanonicalNetwork = { caip2: `ccd:${GENESIS.slice(0, 32)}`, genesisHash: GENESIS };

export function contextSnapshot(overrides: Partial<IdentityContextSnapshot> = {}): IdentityContextSnapshot {
  return {
    version: 1,
    network: NETWORK,
    sourceBlock: { hash: 'ab'.repeat(32), height: '17', time: '2026-10-16T11:59:59.000Z' },
    observedAt: '2026-10-16T12:00:00.000Z',
    globalContext: {
      onChainCommitmentKey: '66'.repeat(48),
      bulletproofGenerators: '77'.repeat(64),
      genesisString: 'provider-test-genesis',
    },
    identityProviders: [
      {
        ipIdentity: 0,
        ipDescription: { name: 'Zero ID', description: 'Provider zero', url: 'https://zero.example' },
        ipVerifyKey: '22'.repeat(32),
        ipCdiVerifyKey: '33'.repeat(96),
      },
      {
        ipIdentity: 2,
        ipDescription: { name: 'Two ID', description: '', url: 'https://two.example' },
        ipVerifyKey: '23'.repeat(32),
        ipCdiVerifyKey: '34'.repeat(96),
      },
    ],
    anonymityRevokers: [1, 2, 3].map((arIdentity) => ({
      arIdentity,
      arDescription: { name: `AR ${arIdentity}`, description: '', url: `https://ar${arIdentity}.example` },
      arPublicKey: String(40 + arIdentity).repeat(96),
    })),
    ...overrides,
  };
}

export function inventory(overrides: Partial<ProviderInventory> = {}): ProviderInventory {
  return {
    version: 1,
    genesisHash: GENESIS,
    refreshedAt: '2026-10-16T12:00:00.000Z',
    providers: [
      { index: 0, name: 'Zero ID', description: 'Provider zero' },
      { index: 2, name: 'Two ID' },
    ],
    anonymityRevokers: [1, 2, 3],
    ...overrides,
  };
}

export function settings(overrides: Partial<ProviderSettings> = {}): ProviderSettings {
  return {
    version: 1,
    genesisHash: GENESIS,
    providers: {
      '0': {
        label: 'primary',
        issuanceUrl: 'https://idp.example/issue',
        recoveryUrl: 'https://idp.example/recover',
        anonymityRevokers: [1, 2],
        enabled: true,
      },
      '2': { enabled: false },
    },
    defaultIdentityProvider: 0,
    ...overrides,
  };
}

export function nodeContext(
  overrides: Partial<FinalizedIdentityProviderContext> = {},
): FinalizedIdentityProviderContext {
  return {
    version: 1,
    network: NETWORK,
    sdkNetwork: 'Testnet',
    sourceBlock: contextSnapshot().sourceBlock,
    observedAt: contextSnapshot().observedAt,
    globalContext: contextSnapshot().globalContext,
    identityProviders: contextSnapshot().identityProviders,
    anonymityRevokers: contextSnapshot().anonymityRevokers,
    ...overrides,
  };
}

export function memoryRegistry(initialInventory?: ProviderInventory, initialSettings?: ProviderSettings) {
  let snapshot: ProviderRegistrySnapshot = {
    ...(initialInventory === undefined ? {} : { inventory: structuredClone(initialInventory) }),
    settings: structuredClone(initialSettings ?? { version: 1 as const, genesisHash: GENESIS, providers: {} }),
  };
  const registry: IdentityProviderRegistry = {
    read: vi.fn(async () => structuredClone(snapshot)),
    updateSettings: vi.fn(async (_network, update) => {
      snapshot = { ...snapshot, settings: structuredClone(update(structuredClone(snapshot))) };
      return structuredClone(snapshot);
    }),
  };
  return {
    registry,
    get: () => structuredClone(snapshot),
    set: (next: typeof snapshot) => {
      snapshot = structuredClone(next);
    },
  };
}

/** Isolates all provider tests from developer XDG and home state. */
export function useProviderScratch(prefix: string) {
  const scratch = useTestXdg(prefix, ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME']);
  const networkDirectory = (kind: 'config' | 'data') =>
    path.join(
      process.env[kind === 'config' ? 'XDG_CONFIG_HOME' : 'XDG_DATA_HOME']!,
      'ccd-agent-kit',
      'id-manager',
      GENESIS.slice(0, 32),
    );
  return {
    root: scratch.scratch,
    configDirectory: () => networkDirectory('config'),
    dataDirectory: () => networkDirectory('data'),
    settingsFile: () => path.join(networkDirectory('config'), 'idps.json'),
    inventoryFile: () => path.join(networkDirectory('data'), 'idp-inventory.json'),
    contextFile: () => path.join(
      process.env.XDG_STATE_HOME!, 'ccd-agent-kit', 'identity-context', `${GENESIS.slice(0, 32)}.json`,
    ),
    lockFile: () => path.join(networkDirectory('config'), '.idps.mutation.lock'),
  };
}
