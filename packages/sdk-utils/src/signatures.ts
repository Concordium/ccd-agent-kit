import type { AccountTransactionSignature } from '@concordium/web-sdk';

/** Role-separated account signature maps used by sender/sponsor transaction signing. */
export interface RoleSeparatedSignatureMaps {
  /** Sender signatures keyed by credential/key index. */
  sender?: AccountTransactionSignature;
  /** Sponsor signatures keyed by credential/key index. */
  sponsor?: AccountTransactionSignature;
}

/** Normalized role-separated account signature maps with both roles present. */
export interface NormalizedRoleSeparatedSignatureMaps {
  /** Sender signatures keyed by credential/key index. */
  sender: AccountTransactionSignature;
  /** Sponsor signatures keyed by credential/key index. */
  sponsor: AccountTransactionSignature;
}
/** Returns true when an account signature map has no key signatures. */
export function isEmptySignatureMap(map: AccountTransactionSignature): boolean {
  return countSignatureEntries(map) === 0;
}

/** Counts credential/key signature entries in an account signature map. */
export function countSignatureEntries(map: AccountTransactionSignature): number {
  return Object.values(map).reduce((count, keys) => count + Object.keys(keys).length, 0);
}

/** Clones an account signature map without sharing nested credential maps. */
export function cloneSignatureMap(map: AccountTransactionSignature): AccountTransactionSignature {
  return Object.fromEntries(Object.entries(map).map(([credentialIndex, keySignatures]) => [credentialIndex, { ...keySignatures }]));
}

/** Normalizes optional role-separated signature maps into cloned sender/sponsor maps. */
export function normalizeRoleSeparatedSignatureMaps(
  signatures: RoleSeparatedSignatureMaps | undefined,
): NormalizedRoleSeparatedSignatureMaps {
  return {
    sender: cloneSignatureMap(signatures?.sender ?? {}),
    sponsor: cloneSignatureMap(signatures?.sponsor ?? {}),
  };
}
