import { loadAccountLabels, loadNetworks, parseCatalogLabel } from '@ccd-agent-kit/config-utils';
import type { BoundMcpResourceDefinition } from '@ccd-agent-kit/mcp-utils';
import { caip2Reference } from '@ccd-agent-kit/sdk-utils';
import { resolveChainCapabilities } from '../../concordium/protocol.js';
import type { ToolContext } from '../toolPlumbing/toolTypes.js';
import { jsonResource } from '../resourcePlumbing/resourceTypes.js';
import type { ChainNetworkResourceFamily } from '../resourcePlumbing/networkResources.js';

const NETWORKS_URI = 'ccd://networks';

function listNetworkCatalogueEntries() {
  const registry = loadNetworks();
  return Object.entries(registry.networks)
    .map(([name, config]) => ({ name, caip2: config.caip2 }))
    .sort((left, right) => left.name.localeCompare(right.name));
}


/** Returns the global configured-network catalogue. */
export function globalNetworkResourceDefinitions(ctx: ToolContext): BoundMcpResourceDefinition[] {
  return [{
    name: NETWORKS_URI,
    uri: NETWORKS_URI,
    title: 'Concordium Networks',
    description: 'Configured Concordium networks and the active default network.',
    mimeType: 'application/json',
    read: async (uri) => ({ uri, ...jsonResource({
      defaultNetwork: ctx.config.network,
      defaultNetworkSource: ctx.config.defaultNetworkSource,
      networks: listNetworkCatalogueEntries(),
    }) }),
    list: async () => [{ uri: NETWORKS_URI, name: 'Concordium Networks' }],
  }];
}

/** Returns network-dependent capability, account-label, and consensus families. */
export function networkResourceFamilies(): ChainNetworkResourceFamily[] {
  return [
    {
      name: 'chain-capabilities', path: 'chain/capabilities',
      title: 'Concordium Chain Capabilities',
      description: 'Chain features supported by the selected network.',
      read: async ({ ctx, network }) => {
        const { client, networkName } = ctx.clients.getClient(network);
        const resolved = await resolveChainCapabilities(client, networkName);
        return { protocolVersion: resolved.protocolVersion, capabilities: resolved.capabilities };
      },
    },
    {
      name: 'account-labels', path: 'account-labels',
      title: 'Concordium Account Labels',
      description: 'Configured account labels for the selected network.',
      read: async ({ network }) => {
        const labels = Object.entries(loadAccountLabels(caip2Reference(network.config.caip2)))
          .map(([label, address]) => ({ label: parseCatalogLabel(label).label, address }))
          .sort((left, right) => left.label.localeCompare(right.label));
        return { labels };
      },
      listDefault: async () => [{ uri: 'ccd://account-labels', name: 'Concordium Account Labels' }],
    },
    {
      name: 'consensus-status', path: 'consensus/status',
      title: 'Concordium Consensus Status',
      description: 'Consensus status for the selected network.',
      read: async ({ ctx, network }) => ctx.clients.getClient(network).client.getConsensusInfo(),
      listDefault: async () => [{ uri: 'ccd://consensus/status', name: 'Concordium Consensus Status' }],
    },
  ];
}
