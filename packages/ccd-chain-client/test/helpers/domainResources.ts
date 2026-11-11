import { resolveNetwork } from '@ccd-agent-kit/config-utils';
import type { ChainNetworkResourceFamily } from '../../src/mcp/resourcePlumbing/networkResources.js';
import type { ToolContext } from '../../src/mcp/toolPlumbing/toolTypes.js';

/** Selects one chain domain family by its stable registration name. */
export function domainFamily(
  families: readonly ChainNetworkResourceFamily[],
  name: string,
): ChainNetworkResourceFamily {
  const family = families.find((candidate) => candidate.name === name);
  if (family === undefined) throw new Error(`Missing resource family ${name}`);
  return family;
}

/** Reads a chain domain family directly without recreating shared URI routing or serialization. */
export function readDomainResource(
  families: readonly ChainNetworkResourceFamily[],
  name: string,
  ctx: ToolContext,
  input: { network?: string; parameters?: Readonly<Record<string, string>> } = {},
): Promise<unknown> {
  return domainFamily(families, name).read({
    ctx,
    network: resolveNetwork(input.network ?? ctx.config.network),
    parameters: input.parameters ?? {},
  });
}
