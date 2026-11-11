import type { ResolvedNetwork } from '@ccd-agent-kit/config-utils';
import { toPltCatalogueDto, toPltInfoDto } from '../../concordium/pltDtos.js';
import type { ToolContext } from '../toolPlumbing/toolTypes.js';
import type { ResourceInstance } from '../resourcePlumbing/resourceTypes.js';
import { readRequiredChainResource, type ChainNetworkResourceFamily } from '../resourcePlumbing/networkResources.js';

async function readPltCatalogueResource(ctx: ToolContext, network: ResolvedNetwork): Promise<unknown> {
  const { client } = ctx.clients.getClient(network);
  return toPltCatalogueDto(await client.getTokenList());
}


async function readPltTokenResource(ctx: ToolContext, network: ResolvedNetwork, tokenId: string): Promise<unknown> {
  const { client } = ctx.clients.getClient(network);
  const info = await readRequiredChainResource(() => client.getTokenInfo(tokenId));
  return toPltInfoDto(info);
}

async function listDefaultPltResources(ctx: ToolContext): Promise<ResourceInstance[]> {
  const { client } = ctx.clients.getClient(ctx.config.network);
  const tokenIds = await client.getTokenIds();
  return tokenIds.map((tokenId) => ({
    uri: `ccd://plt/${tokenId}`,
    name: `Concordium PLT ${tokenId}`,
  }));
}

/** Returns protocol-level token catalogue and token-detail resource definitions. */
export function pltResourceFamilies(): ChainNetworkResourceFamily[] {
  return [
    {
      name: 'plt-catalogue', path: 'plts',
      title: 'Concordium PLT Catalogue',
      description: 'Protocol-level token catalogue.',
      read: ({ ctx, network }) => readPltCatalogueResource(ctx, network),
      listDefault: async () => [{ uri: 'ccd://plts', name: 'Concordium PLT Catalogue' }],
    },
    {
      name: 'plt', path: 'plt/{tokenId}',
      title: 'Concordium PLT',
      description: 'Protocol-level token details for a token identifier.',
      read: ({ ctx, network, parameters }) => readPltTokenResource(ctx, network, parameters.tokenId!),
      listDefault: listDefaultPltResources,
    },
  ];
}
