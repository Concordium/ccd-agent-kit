import { resolveNetwork, type ResolvedNetwork } from '@ccd-agent-kit/config-utils';
import { ConcordiumNodeQueries, createConcordiumClient, type ConcordiumQueryClient } from '../../concordium/client.js';
import { resolveEndpoint } from '../../concordium/endpoints.js';
import type { ServerConfig } from '../../config.js';
import type { ToolContext, NetworkClientProvider } from './toolTypes.js';

export function effectiveNetwork(ctx: ToolContext, network?: string): string {
  return network ?? ctx.config.network;
}

/**
 * Creates a lazy client provider that resolves string selectors at acquisition time while preserving
 * immutable resolved snapshots for resource reads. Clients are cached by chain identity and endpoint.
 */
export function createCachingNetworkClientProvider(config: ServerConfig): NetworkClientProvider {
  const startupNetwork = config.resolvedNetwork;
  const clients = new Map<string, ConcordiumQueryClient>();
  return {
    getClient(network?: string | ResolvedNetwork) {
      const resolved = typeof network === 'object' ? network : resolveNetwork(network ?? config.network);
      const endpoint = resolved.config.genesisHash === startupNetwork.config.genesisHash
        ? resolveEndpoint(config)
        : {
            host: resolved.config.grpc.host,
            port: resolved.config.grpc.port,
            tls: resolved.config.grpc.ssl,
          };
      const cacheKey = JSON.stringify([
        resolved.config.genesisHash,
        endpoint.host,
        endpoint.port,
        endpoint.tls,
      ]);
      const existing = clients.get(cacheKey);
      if (existing !== undefined) return { client: existing, networkName: resolved.name };

      const grpc = createConcordiumClient(endpoint, config.grpc.timeoutMs);
      const client = new ConcordiumNodeQueries(grpc);
      clients.set(cacheKey, client);
      return { client, networkName: resolved.name };
    },
  };
}
