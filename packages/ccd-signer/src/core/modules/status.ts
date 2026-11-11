import type { SignerInventoryBackendEntry, SignerInventoryKeyScheme } from '@ccd-agent-kit/config-utils';
import { getSignerModule } from './registry.js';
import type { SignerBackendStatus } from './types.js';

/** Account-level signing availability exposed by signer account discovery. */
export type AccountSigningStatus = 'unknown' | 'available' | 'locked' | 'unavailable';

/** Returns a module-owned backend status with a conservative unknown default. */
export function getSignerBackendStatus(backend: SignerInventoryBackendEntry, scheme: SignerInventoryKeyScheme): SignerBackendStatus {
  return getSignerModule(backend.signingModule)?.getBackendStatus?.(backend, scheme) ?? 'unknown';
}

/** Aggregates backend status for one public key. */
export function aggregateSignerBackendStatus(statuses: SignerBackendStatus[]): SignerBackendStatus {
  if (statuses.includes('unlocked')) return 'unlocked';
  if (statuses.includes('locked')) return 'locked';
  if (statuses.includes('unknown')) return 'unknown';
  return 'unavailable';
}

/** Aggregates signer key statuses for one account. */
export function aggregateAccountSigningStatus(statuses: SignerBackendStatus[]): AccountSigningStatus {
  const status = aggregateSignerBackendStatus(statuses);
  return status === 'unlocked' ? 'available' : status;
}
