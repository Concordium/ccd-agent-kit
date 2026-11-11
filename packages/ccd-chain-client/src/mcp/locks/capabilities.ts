import type { ConcordiumQueryClient } from '../../concordium/client.js';
import {
  resolveProtocolCapabilities,
  type ChainCapability,
  type ProtocolCapabilities,
} from '../../concordium/protocol.js';

type LockQueryCapability = Extract<ChainCapability, 'lock.list' | 'lock.info'>;

/** Ensures protocol-level lock query support before serving lock reads. */
export async function requireLockSupport(
  client: ConcordiumQueryClient,
  network: string,
  capability: LockQueryCapability,
): Promise<ProtocolCapabilities> {
  const capabilities = await resolveProtocolCapabilities(client);
  if (!capabilities.supportsLocks) {
    throw {
      kind: 'chain-capability' as const,
      capability,
      network,
      message:
        capability === 'lock.list'
          ? `Lock listing is not available on ${network}.`
          : `Lock queries are not available on ${network}.`,
    };
  }
  return capabilities;
}
