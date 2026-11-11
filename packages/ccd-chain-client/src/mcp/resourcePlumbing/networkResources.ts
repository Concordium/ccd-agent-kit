import { createNetworkResourceAdapter, type NetworkConfig, type ResolvedNetwork } from '@ccd-agent-kit/config-utils';
import {
  NetworkResourceError,
  registerNetworkResourceFamily,
  toJsonSafe,
  type BoundMcpResourceDefinition,
  type McpJsonValue,
  type NetworkResourceRegistration,
} from '@ccd-agent-kit/mcp-utils';
import type { ToolContext } from '../toolPlumbing/toolTypes.js';
import type { ResourceInstance } from './resourceTypes.js';

/** @internal Chain-server domain family before shared network routing is applied. */
export interface ChainNetworkResourceFamily {
  name: string;
  title: string;
  description: string;
  path: string;
  read(input: {
    ctx: ToolContext;
    network: ResolvedNetwork;
    parameters: Readonly<Record<string, string>>;
  }): Promise<unknown>;
  listDefault?: (ctx: ToolContext) => Promise<ResourceInstance[]> | ResourceInstance[];
}

function publicDomainError(error: unknown): NetworkResourceError | undefined {
  if (error instanceof NetworkResourceError) return error;
  if (typeof error !== 'object' || error === null || typeof (error as { message?: unknown }).message !== 'string') {
    return undefined;
  }
  const kind = (error as { kind?: unknown }).kind;
  const message = (error as { message: string }).message;
  if (kind === 'node') {
    return new NetworkResourceError(
      (error as { code?: unknown }).code === 5 ? 'RESOURCE_NOT_FOUND' : 'NODE_REQUEST_FAILED',
      message,
    );
  }
  if (kind === 'invalid-argument' || kind === 'chain-capability') {
    return new NetworkResourceError('RESOURCE_READ_FAILED', message);
  }
  return undefined;
}

/** @internal Classifies absence from a successfully parsed entity lookup without inspecting error text. */
export async function readRequiredChainResource<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      ((error as { kind?: unknown }).kind === 'invalid-argument' ||
        ((error as { kind?: unknown }).kind === 'node' && (error as { code?: unknown }).code === 5))
    ) {
      throw new NetworkResourceError('RESOURCE_NOT_FOUND', 'The selected chain resource was not found.');
    }
    throw error;
  }
}

function registerFamily(
  ctx: ToolContext,
  family: ChainNetworkResourceFamily,
): NetworkResourceRegistration<NetworkConfig> {
  const adapter = createNetworkResourceAdapter();
  return registerNetworkResourceFamily({
    ...adapter,
    resolveDefault: () => ({
      name: ctx.config.resolvedNetwork.name,
      caip2: ctx.config.resolvedNetwork.config.caip2 as `ccd:${string}`,
      value: ctx.config.resolvedNetwork.config,
    }),
  }, {
    name: family.name,
    title: family.title,
    description: family.description,
    path: family.path,
    read: async ({ network, parameters }) => {
      try {
        return toJsonSafe(await family.read({
          ctx,
          network: { name: network.name, config: network.value },
          parameters,
        })) as McpJsonValue;
      } catch (error) {
        throw publicDomainError(error) ?? error;
      }
    },
  });
}

/** @internal Registers every family once and returns shared bound definitions directly. */
export function createChainNetworkResourceCatalog(
  ctx: ToolContext,
  families: readonly ChainNetworkResourceFamily[],
): BoundMcpResourceDefinition[] {
  const registrations = families.map((family) => registerFamily(ctx, family));
  const definitions = registrations.flatMap((registration, familyIndex) =>
    registration.definitions.map((definition, definitionIndex): BoundMcpResourceDefinition =>
      definitionIndex === 0 && families[familyIndex]!.listDefault !== undefined
        ? { ...definition, list: () => families[familyIndex]!.listDefault!(ctx) }
        : definition,
    ),
  );
  return definitions;
}
