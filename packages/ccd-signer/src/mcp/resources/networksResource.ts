import { jsonResourceContent, type NetworksResourceDto, type TextResourceContent } from '@ccd-agent-kit/mcp-utils';
import { getActiveNetwork, loadNetworks, type DefaultNetworkSource } from '@ccd-agent-kit/config-utils';

/**
 * Resource metadata for the signer network catalogue.
 */
export const networksResource = {
  name: 'ccd://networks',
  uri: 'ccd://networks',
  title: 'Concordium Signer Networks',
  description: 'Configured Concordium networks and the active default network.',
  mimeType: 'application/json',
} as const;

/**
 * JSON payload exposed by the signer networks resource.
 */
export type NetworksResourceContent = NetworksResourceDto<DefaultNetworkSource>;

function listNetworkCatalogueEntries() {
  const registry = loadNetworks();
  return Object.entries(registry.networks)
    .map(([name, config]) => ({ name, caip2: config.caip2 }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * Builds the signer network catalogue payload.
 *
 * @returns Resource payload with default network and available configured networks.
 */
export function formatNetworksResource(): NetworksResourceContent {
  const { name: defaultNetwork, source: defaultNetworkSource } = getActiveNetwork();
  return {
    defaultNetwork,
    defaultNetworkSource,
    networks: listNetworkCatalogueEntries(),
  };
}

/**
 * Reads the signer network catalogue as MCP resource contents.
 *
 * @param uri - The requested resource URI.
 * @returns JSON resource contents for available signer networks.
 */
export function readNetworksResource(uri: string): TextResourceContent {
  return jsonResourceContent(uri, formatNetworksResource());
}
