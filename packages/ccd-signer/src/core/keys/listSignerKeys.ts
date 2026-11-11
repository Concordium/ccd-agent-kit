import type { Ed25519PublicKeyHex } from '@ccd-agent-kit/sdk-utils';
import { parseCatalogLabel, type SignerInventoryKeyScheme } from '@ccd-agent-kit/config-utils';
import { listVisibleSignerInventoryKeys } from '../modules/keyVisibility.js';
import { aggregateSignerBackendStatus, getSignerBackendStatus } from '../modules/status.js';
import type { SignerBackendStatus } from '../modules/types.js';

/** Public signer key metadata exposed by CLI and MCP inventory listing. */
export interface ListedSignerKey {
  /** Public signing-key scheme. */
  scheme: SignerInventoryKeyScheme;
  /** Validated canonical public key; serialized as a JSON string. */
  publicKey: Ed25519PublicKeyHex;
  /** Whether this process can currently attempt signing with at least one visible backend for the key. */
  status: ListedSignerKeyStatus;
  /** Optional bare signer-local label, without its on-disk mode encoding. */
  label?: string;
}

/** Current process availability for a listed signer key. */
export type ListedSignerKeyStatus = SignerBackendStatus;

/** Public signer-key inventory DTO shared by CLI and MCP. */
export interface ListedSignerKeys extends Record<string, unknown> {
  /** Signer-known public keys. */
  keys: ListedSignerKey[];
}

/** Lists public signing keys while preserving the signer custody boundary. */
export function listSignerKeys(): ListedSignerKeys {
  const keys = listVisibleSignerInventoryKeys().map(({ backends, entry, publicKey }) => ({
    ...(entry.label !== undefined ? { label: parseCatalogLabel(entry.label).label } : {}),
    publicKey,
    scheme: entry.scheme,
    status: aggregateSignerBackendStatus(backends.map((backend) => getSignerBackendStatus(backend, entry.scheme))),
  }));

  return { keys: keys.sort((left, right) => left.publicKey.localeCompare(right.publicKey)) };
}
