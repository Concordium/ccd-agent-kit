import type { ResolvedNetwork } from '@ccd-agent-kit/config-utils';
import { requireLockSupport } from './capabilities.js';
import type { ToolContext } from '../toolPlumbing/toolTypes.js';
import type { ResourceInstance } from '../resourcePlumbing/resourceTypes.js';
import { readRequiredChainResource, type ChainNetworkResourceFamily } from '../resourcePlumbing/networkResources.js';

async function readLockResource(ctx: ToolContext, network: ResolvedNetwork, lockId: string): Promise<unknown> {
  const { client, networkName } = ctx.clients.getClient(network);
  await requireLockSupport(client, networkName, 'lock.info');
  const info = await readRequiredChainResource(() => client.getLockInfo(lockId));
  return info;
}


async function readLockCatalogueResource(
  ctx: ToolContext,
  network: ResolvedNetwork,
): Promise<unknown> {
  const { client, networkName } = ctx.clients.getClient(network);
  await requireLockSupport(client, networkName, 'lock.list');
  const locks = (await client.getLockList()).map((lockId) => ({
    lockId,
    uri: `ccd://${networkName}/lock/${lockId}`,
  }));
  return { locks };
}

async function listDefaultLockResources(ctx: ToolContext): Promise<ResourceInstance[]> {
  const { client, networkName } = ctx.clients.getClient(ctx.config.network);
  try {
    await requireLockSupport(client, networkName, 'lock.list');
  } catch {
    return [];
  }
  return (await client.getLockList()).map((lockId) => ({
    uri: `ccd://lock/${lockId}`,
    name: `Concordium Lock ${lockId}`,
  }));
}

/** Returns protocol-level lock catalogue and lock-detail resource definitions. */
export function lockResourceFamilies(): ChainNetworkResourceFamily[] {
  return [
    {
      name: 'locks', path: 'locks',
      title: 'Concordium Locks',
      description: 'Protocol-level lock identifiers with network-qualified drill-down resource URIs.',
      read: ({ ctx, network }) => readLockCatalogueResource(ctx, network),
    },
    {
      name: 'lock', path: 'lock/{lockId}',
      title: 'Concordium Lock',
      description: 'Protocol-level lock details for a lock identifier.',
      read: ({ ctx, network, parameters }) => readLockResource(ctx, network, parameters.lockId!),
      listDefault: listDefaultLockResources,
    },
  ];
}
