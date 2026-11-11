import {
  ed25519SignerKeyRef,
  loadSignerInventory,
  publicKeyFromEd25519SignerKeyRef,
  type SignerInventoryBackendEntry,
  type SignerInventory,
  type SignerInventoryKeyEntry,
  type SignerKeyRef,
} from '@ccd-agent-kit/config-utils';
import type { Ed25519PublicKeyHex } from '@ccd-agent-kit/sdk-utils';
import { loadModuleConfig, type SignerConfigFile } from '@ccd-agent-kit/config-utils';
import { isRegisteredSigningModuleEnabledInConfig } from './moduleConfig.js';
import { getSignerModule } from './registry.js';

/** Public-key-addressed inventory entry that is visible under current module policy. */
export interface VisibleSignerInventoryKey {
  /** Public-key reference in the inventory map. */
  keyRef: SignerKeyRef;
  /** Validated canonical Ed25519 public key. */
  publicKey: Ed25519PublicKeyHex;
  /** Policy-visible inventory entry. */
  entry: SignerInventoryKeyEntry;
  /** Policy-visible backends for this public key. */
  backends: SignerInventoryBackendEntry[];
}

/** Returns policy-visible backends for an inventory entry. */
export function listVisibleSignerInventoryBackends(entry: SignerInventoryKeyEntry, config: SignerConfigFile): SignerInventoryBackendEntry[] {
  return entry.backends.filter((backendEntry) => {
    const module = getSignerModule(backendEntry.signingModule);
    return module !== undefined &&
      isRegisteredSigningModuleEnabledInConfig(module.id, module.defaultEnabled, config) &&
      module.isBackendVisible(backendEntry, entry.scheme, config);
  });
}

/** Returns whether an inventory entry has any visible backend under current module policy. */
export function isSignerInventoryEntryVisible(entry: SignerInventoryKeyEntry): boolean {
  return listVisibleSignerInventoryBackends(entry, loadModuleConfig()).length > 0;
}

/** Lists inventory keys visible under current module policy. */
export function listVisibleSignerInventoryKeys(): VisibleSignerInventoryKey[] {
  return listVisibleSignerInventoryKeysFromSnapshot(loadSignerInventory(), loadModuleConfig());
}

/** Lists inventory keys visible under a caller-provided inventory and module-config snapshot. */
export function listVisibleSignerInventoryKeysFromSnapshot(inventory: SignerInventory, config: SignerConfigFile): VisibleSignerInventoryKey[] {
  return Object.entries(inventory.keys).flatMap(([keyRef, entry]) => {
    const publicKey = publicKeyFromEd25519SignerKeyRef(keyRef);
    const backends = listVisibleSignerInventoryBackends(entry, config);
    if (publicKey === undefined || backends.length === 0) return [];
    return [{ backends, entry, keyRef: ed25519SignerKeyRef(publicKey), publicKey }];
  });
}

/** Looks up a visible signer inventory entry by public key. */
export function getVisibleSignerInventoryEntry(publicKey: Ed25519PublicKeyHex): SignerInventoryKeyEntry | undefined {
  return getVisibleSignerInventoryKey(publicKey)?.entry;
}

/** Looks up visible signer inventory backends by public key. */
export function getVisibleSignerInventoryBackends(publicKey: Ed25519PublicKeyHex): SignerInventoryBackendEntry[] {
  return getVisibleSignerInventoryKey(publicKey)?.backends ?? [];
}

/** Looks up one visible signer inventory key and its visible backends by public key. */
export function getVisibleSignerInventoryKey(publicKey: Ed25519PublicKeyHex): VisibleSignerInventoryKey | undefined {
  const inventory = loadSignerInventory();
  const config = loadModuleConfig();
  const entry = inventory.keys[ed25519SignerKeyRef(publicKey)];
  if (entry === undefined) return undefined;
  const backends = listVisibleSignerInventoryBackends(entry, config);
  return backends.length === 0 ? undefined : { backends, entry, keyRef: ed25519SignerKeyRef(publicKey), publicKey };
}
