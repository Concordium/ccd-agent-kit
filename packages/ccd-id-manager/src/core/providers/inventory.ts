import type { IdentityContextSnapshot } from '@ccd-agent-kit/sdk-utils';
import type { ProviderInventory } from './types.js';

/** Derive the safe provider inventory projection from a validated public context snapshot. */
export function providerInventory(snapshot: IdentityContextSnapshot): ProviderInventory {
  return {
    version: 1,
    genesisHash: snapshot.network.genesisHash,
    refreshedAt: snapshot.observedAt,
    providers: snapshot.identityProviders.map(({ ipIdentity, ipDescription }) => ({
      index: ipIdentity,
      name: ipDescription.name,
      ...(ipDescription.description ? { description: ipDescription.description } : {}),
    })),
    anonymityRevokers: snapshot.anonymityRevokers.map(({ arIdentity }) => arIdentity),
  };
}
