import type { ResolvedNetwork } from '@ccd-agent-kit/config-utils';
import { parseBlockReference } from '../toolPlumbing/toolSchemas.js';
import type { ToolContext } from '../toolPlumbing/toolTypes.js';
import { readRequiredChainResource, type ChainNetworkResourceFamily } from '../resourcePlumbing/networkResources.js';

async function readBlockResource(ctx: ToolContext, network: ResolvedNetwork, id: string): Promise<unknown> {
  const { client } = ctx.clients.getClient(network);
  const block = /^\d+$/.test(id) ? { type: 'height' as const, height: BigInt(id) } : parseBlockReference(id);
  return readRequiredChainResource(() => client.getBlockInfo(block));
}


async function readBlockEventsResource(ctx: ToolContext, network: ResolvedNetwork, id: string): Promise<unknown> {
  const { client } = ctx.clients.getClient(network);
  const block = /^\d+$/.test(id) ? { type: 'height' as const, height: BigInt(id) } : parseBlockReference(id);
  return readRequiredChainResource(() => client.getBlockTransactionEvents(block));
}

async function readBlockItemResource(ctx: ToolContext, network: ResolvedNetwork, id: string): Promise<unknown> {
  const { client } = ctx.clients.getClient(network);
  return readRequiredChainResource(() => client.getBlockItem(id));
}

async function readBlockItemEffectsResource(ctx: ToolContext, network: ResolvedNetwork, id: string): Promise<unknown> {
  const { client } = ctx.clients.getClient(network);
  return readRequiredChainResource(() => client.getTransactionEffects(id));
}

/** Returns block, block-event, block-item, and transaction-effect resource families. */
export function blockResourceFamilies(): ChainNetworkResourceFamily[] {
  return [
    {
      name: 'block', path: 'block/{id}',
      title: 'Concordium Block',
      description: 'Block hash, height, slot time, era and transaction count.',
      read: ({ ctx, network, parameters }) => readBlockResource(ctx, network, parameters.id!),
    },
    {
      name: 'block-events', path: 'block/{id}/events',
      title: 'Concordium Block Events',
      description: 'Transaction event summaries for a block.',
      read: ({ ctx, network, parameters }) => readBlockEventsResource(ctx, network, parameters.id!),
    },
    {
      name: 'block-item', path: 'block-item/{id}',
      title: 'Concordium Block Item',
      description: 'Block item status, inclusion block, kind, and serialized block item hex for a transaction hash.',
      read: ({ ctx, network, parameters }) => readBlockItemResource(ctx, network, parameters.id!),
    },
    {
      name: 'block-item-effects', path: 'block-item/{id}/effects',
      title: 'Concordium Block Item Effects',
      description: 'Transaction effect summaries for a transaction hash.',
      read: ({ ctx, network, parameters }) => readBlockItemEffectsResource(ctx, network, parameters.id!),
    },
  ];
}
