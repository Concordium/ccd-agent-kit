import { AccountAddress } from '@concordium/web-sdk';
import {
  findAccountLabelForAddress,
  findAccountLabelScopes,
  resolveAccountLabel,
  resolveNetwork,
  type ResolvedNetwork,
} from '@ccd-agent-kit/config-utils';
import { caip2Reference } from '@ccd-agent-kit/sdk-utils';

function resolvedNetwork(network?: string | ResolvedNetwork): ResolvedNetwork {
  return typeof network === 'object' ? network : resolveNetwork(network);
}

function caip2RefForNetwork(network?: string | ResolvedNetwork): string {
  return caip2Reference(resolvedNetwork(network).config.caip2);
}

/** Resolves an account address or label using a current selector or an immutable network snapshot. */
export function resolveAccountInput(input: string, network?: string | ResolvedNetwork): string {
  try {
    AccountAddress.fromBase58(input);
    return input;
  } catch {
    const label = input.trim();
    const selectedNetwork = resolvedNetwork(network);
    const networkName = selectedNetwork.name;
    const caip2Ref = caip2Reference(selectedNetwork.config.caip2);
    const resolved = resolveAccountLabel(label, caip2Ref);
    if (resolved !== undefined) return resolved.address;
    const otherNetworks = findAccountLabelScopes(label)
      .filter((match) => match.network !== networkName)
      .map((match) => match.network)
      .sort((left, right) => left.localeCompare(right));
    const existsElsewhere = otherNetworks.length > 0 ? ` It exists for ${formatNetworkList(otherNetworks)}.` : '';
    throw {
      kind: 'invalid-argument',
      message: `Account label '${label}' not found on network '${networkName}'.${existsElsewhere}`,
    };
  }
}

/** Returns true when two valid Concordium account addresses identify the same account, including aliases. */
export function sameAccount(left: string, right: string): boolean {
  try {
    return AccountAddress.isAlias(AccountAddress.fromBase58(left), AccountAddress.fromBase58(right));
  } catch {
    return false;
  }
}

/** Finds a preferred account label using a current selector or an immutable network snapshot. */
export function findLabelForAccount(address: string, network?: string | ResolvedNetwork): string | undefined {
  return findAccountLabelForAddress(address, caip2RefForNetwork(network));
}

function formatNetworkList(networks: string[]): string {
  const unique = [...new Set(networks)];
  if (unique.length === 1) return unique[0]!;
  return `${unique.slice(0, -1).join(', ')} and ${unique.at(-1)}`;
}
