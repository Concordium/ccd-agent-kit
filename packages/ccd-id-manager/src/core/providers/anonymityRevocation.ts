import type { ArInfo } from '@concordium/web-sdk';
import { IdentityProviderError } from './error.js';

const MAX_AR_ID = 0xffff_ffff;
const MAX_AR_THRESHOLD = 255;

/** Persisted or request-scoped anonymity-revocation preferences. */
export interface AnonymityRevocationPolicy {
  /** Selected AR identities; omission selects the complete finalized network AR map. */
  anonymityRevokers?: number[];
  /** Explicit threshold; omission selects one fewer than the effective AR count. */
  anonymityRevokerThreshold?: number;
}

function invalid(): never { throw new IdentityProviderError('INVALID_CONFIGURATION'); }

function validArId(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_AR_ID;
}

/**
 * Validate policy shape and self-contained bounds without consulting network inventory.
 * @throws {IdentityProviderError} With code `INVALID_CONFIGURATION` for an invalid policy.
 */
export function validateStoredAnonymityRevocationPolicy(policy: AnonymityRevocationPolicy): void {
  const selected = policy.anonymityRevokers;
  const threshold = policy.anonymityRevokerThreshold;
  if (selected !== undefined && (!Array.isArray(selected) || selected.length === 0
    || !selected.every(validArId) || new Set(selected).size !== selected.length)) invalid();
  if (threshold !== undefined && (!Number.isInteger(threshold) || threshold < 1 || threshold > MAX_AR_THRESHOLD)) invalid();
  if (selected !== undefined) {
    const effective = threshold ?? selected.length - 1;
    if (effective < 1 || effective > Math.min(selected.length, MAX_AR_THRESHOLD)) invalid();
  }
}

/**
 * Resolve a fresh issuance subset and threshold without mutating the authoritative AR map.
 * @throws {IdentityProviderError} With code `INVALID_CONFIGURATION` for invalid or unknown choices.
 */
export function resolveAnonymityRevocationPolicy<T extends Pick<ArInfo, 'arIdentity'>>(
  policy: AnonymityRevocationPolicy,
  available: Record<string, T>,
): { arsInfos: Record<string, T>; arThreshold: number } {
  validateStoredAnonymityRevocationPolicy(policy);
  const selectedIds = policy.anonymityRevokers ?? Object.values(available).map(({ arIdentity }) => arIdentity);
  if (selectedIds.length === 0 || !selectedIds.every(validArId) || new Set(selectedIds).size !== selectedIds.length) invalid();
  const entries = selectedIds.map((id) => {
    const ar = available[String(id)];
    if (ar === undefined || ar.arIdentity !== id) invalid();
    return [String(id), ar] as const;
  });
  const threshold = policy.anonymityRevokerThreshold ?? selectedIds.length - 1;
  if (threshold < 1 || threshold > Math.min(selectedIds.length, MAX_AR_THRESHOLD)) invalid();
  return { arsInfos: Object.fromEntries(entries), arThreshold: threshold };
}
