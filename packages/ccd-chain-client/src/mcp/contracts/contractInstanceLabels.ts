import {
  findContractInstanceLabelForAddress,
  findContractInstanceLabelScopes,
  loadContractInstanceLabels,
  parseCatalogLabel,
  resolveContractInstanceLabel,
  resolveNetwork,
  type ResolvedNetwork,
} from '@ccd-agent-kit/config-utils';
import { caip2Reference, contractInstance, type ContractInstanceAddress } from '@ccd-agent-kit/sdk-utils';

function resolvedNetwork(network?: string | ResolvedNetwork): ResolvedNetwork {
  return typeof network === 'object' ? network : resolveNetwork(network);
}

function caip2RefForNetwork(network?: string | ResolvedNetwork): string {
  return caip2Reference(resolvedNetwork(network).config.caip2);
}

/** A canonical contract-instance address with optional local label metadata. */
export interface ResolvedContractInstance {
  /** Canonical contract index for chain queries. */
  index: bigint;
  /** Canonical contract subindex for chain queries. */
  subindex: bigint;
  /** Canonical serializable contract-instance address. */
  address: ContractInstanceAddress;
  /** Address formatted as `index,subindex`. */
  canonical: string;
  /** Optional bare local label on the selected network. */
  label?: string;
}

/** Resolves an instance address or label using a current selector or immutable network snapshot. */
export function resolveContractInstanceInput(
  input: string,
  network?: string | ResolvedNetwork,
): ResolvedContractInstance {
  const rawAddress = contractInstance.from(input);
  const parsed = rawAddress ?? resolveContractInstanceLabel(input, caip2RefForNetwork(network));
  if (parsed === undefined) {
    const networkName = resolvedNetwork(network).name;
    const otherNetworks = findContractInstanceLabelScopes(input)
      .filter((match) => match.network !== networkName)
      .map((match) => match.network)
      .sort((left, right) => left.localeCompare(right));
    const existsElsewhere = otherNetworks.length > 0 ? ` It exists for ${formatNetworkList(otherNetworks)}.` : '';
    throw {
      kind: 'invalid-argument',
      message: `Contract instance '${input}' is neither an address nor a configured contract-instance label on network '${networkName}'.${existsElsewhere}`,
    };
  }
  const label = findContractInstanceLabelForAddress(parsed, caip2RefForNetwork(network));
  return {
    index: BigInt(parsed.index),
    subindex: BigInt(parsed.subindex),
    address: parsed,
    canonical: contractInstance.format(parsed),
    ...(label !== undefined ? { label } : {}),
  };
}

/** Resolves a URI segment using a current selector or immutable network snapshot. */
export function resolveContractInstanceUriSegment(
  segment: string,
  network?: string | ResolvedNetwork,
): ResolvedContractInstance {
  return resolveContractInstanceInput(decodeURIComponent(segment), network);
}

/** Lists contract-instance labels using a current selector or immutable network snapshot. */
export function listContractInstanceLabelsForNetwork(
  network?: string | ResolvedNetwork,
): Record<string, ContractInstanceAddress> {
  return Object.fromEntries(
    Object.entries(loadContractInstanceLabels(caip2RefForNetwork(network))).map(([stored, address]) => [
      parseCatalogLabel(stored).label,
      address,
    ]),
  );
}

function formatNetworkList(networks: string[]): string {
  const unique = [...new Set(networks)];
  if (unique.length === 1) return unique[0]!;
  return `${unique.slice(0, -1).join(', ')} and ${unique.at(-1)}`;
}
