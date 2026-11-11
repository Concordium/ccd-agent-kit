import type { BoundMcpResourceDefinition } from '@ccd-agent-kit/mcp-utils';
import { accountResourceFamilies } from '../accounts/resourceDefinitions.js';
import { blockResourceFamilies } from '../blocks/resourceDefinitions.js';
import { contractResourceFamilies } from '../contracts/resourceDefinitions.js';
import { lockResourceFamilies } from '../locks/resourceDefinitions.js';
import { globalNetworkResourceDefinitions, networkResourceFamilies } from '../networks/resourceDefinitions.js';
import { skillResourceDefinitions } from '../skills/resourceDefinitions.js';
import { stakingResourceFamilies } from '../staking/resourceDefinitions.js';
import { pltResourceFamilies } from '../tokens/resourceDefinitions.js';
import type { ToolContext } from '../toolPlumbing/toolTypes.js';
import { createChainNetworkResourceCatalog } from './networkResources.js';

/** Builds the complete SDK-facing resource catalog for one server session. */
export function createResourceCatalog(ctx: ToolContext): BoundMcpResourceDefinition[] {
  const network = createChainNetworkResourceCatalog(ctx, [
    ...accountResourceFamilies(),
    ...stakingResourceFamilies(),
    ...blockResourceFamilies(),
    ...contractResourceFamilies(),
    ...lockResourceFamilies(),
    ...pltResourceFamilies(),
    ...networkResourceFamilies(),
  ]);
  const local = [
    ...globalNetworkResourceDefinitions(ctx),
    ...skillResourceDefinitions(),
  ];
  return [...network, ...local];
}

export type { ResourceInstance } from './resourceTypes.js';
