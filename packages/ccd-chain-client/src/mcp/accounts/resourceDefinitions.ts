import { getNetwork, listAccountLabelAddresses, resolveAccountLabel, type ResolvedNetwork } from '@ccd-agent-kit/config-utils';
import { caip2Reference } from '@ccd-agent-kit/sdk-utils';
import type { AccountInfoDTO, AccountSummaryDTO } from '../../concordium/dto.js';
import { getCompleteAccountCredentials } from '../accountCredentialsCache.js';
import { findLabelForAccount, resolveAccountInput } from './accountLabels.js';
import type { ToolContext } from '../toolPlumbing/toolTypes.js';
import type { ResourceInstance } from '../resourcePlumbing/resourceTypes.js';
import { readRequiredChainResource, type ChainNetworkResourceFamily } from '../resourcePlumbing/networkResources.js';
const MAX_U64 = 18_446_744_073_709_551_615n;

function listAddressResources(networkName: string): ResourceInstance[] {
  const network = getNetwork(networkName);
  if (network === undefined) return [];
  const caip2Ref = caip2Reference(network.caip2);
  const addresses = new Set<string>(listAccountLabelAddresses(caip2Ref));
  return [...addresses]
    .sort((left, right) => left.localeCompare(right))
    .flatMap((account) => [
      {
        uri: `ccd://${networkName}/account/${account}`,
        name: `Concordium Account ${networkName}:${account}`,
      },
      {
        uri: `ccd://${networkName}/account/${account}/balances`,
        name: `Concordium Account Balances ${networkName}:${account}`,
      },
      {
        uri: `ccd://${networkName}/account/${account}/stake`,
        name: `Concordium Account Stake ${networkName}:${account}`,
      },
      {
        uri: `ccd://${networkName}/account/${account}/credentials`,
        name: `Concordium Account Credentials ${networkName}:${account}`,
      },
    ]);
}

function listDefaultAddressResources(networkName: string): ResourceInstance[] {
  return listAddressResources(networkName).map(({ uri, name }) => ({
    uri: uri.replace(`ccd://${networkName}/`, 'ccd://'),
    name: name.replace(`${networkName}:`, ''),
  }));
}

function accountLabelForAddress(address: string, network: ResolvedNetwork): string | undefined {
  return findLabelForAccount(address, network);
}

function accountSummary(info: AccountInfoDTO, network: ResolvedNetwork, selectedLabel?: string): AccountSummaryDTO {
  const label = selectedLabel ?? accountLabelForAddress(info.address, network);
  return {
    address: info.address,
    ...(label !== undefined && { label }),
    sequenceNumber: info.sequenceNumber,
    index: info.index,
    accountType: info.accountType === 'Baker' ? 'Validator' : info.accountType,
  };
}

function isCanonicalUint64(value: string): boolean {
  if (!/^(0|[1-9]\d*)$/.test(value)) return false;
  return BigInt(value) <= MAX_U64;
}

interface ResolvedAccountResourceSelector {
  address: string;
  label?: string;
}

function resolveConfiguredLabel(selector: string, network: ResolvedNetwork): ResolvedAccountResourceSelector | undefined {
  if (selector.length === 50 || isCanonicalUint64(selector)) return undefined;
  return resolveAccountLabel(selector, caip2Reference(network.config.caip2));
}

async function resolveAccountResourceSelector(
  ctx: ToolContext,
  network: ResolvedNetwork,
  selector: string,
): Promise<ResolvedAccountResourceSelector> {
  const { client } = ctx.clients.getClient(network);
  if (isCanonicalUint64(selector)) {
    const address = await readRequiredChainResource(() => client.getAccountAddressByIndex(BigInt(selector)));
    return { address };
  }
  const selected = resolveConfiguredLabel(selector, network);
  if (selected !== undefined) return selected;
  const address = resolveAccountInput(selector, network);
  return { address };
}

async function readAccountResource(ctx: ToolContext, network: ResolvedNetwork, account: string): Promise<unknown> {
  const { client } = ctx.clients.getClient(network);
  const selected = resolveConfiguredLabel(account, network);
  const rawInfo = await readRequiredChainResource(() =>
    account.length !== 50 && isCanonicalUint64(account)
      ? client.getAccountInfoByIndex(BigInt(account))
      : client.getAccountInfo(selected?.address ?? resolveAccountInput(account, network)),
  );
  const info = accountSummary(rawInfo, network, selected?.label);
  return info;
}

async function readAccountBalancesResource(
  ctx: ToolContext,
  network: ResolvedNetwork,
  account: string,
): Promise<unknown> {
  const { client } = ctx.clients.getClient(network);
  const selected = resolveConfiguredLabel(account, network);
  const selector = isCanonicalUint64(account) ? account : selected?.address ?? resolveAccountInput(account, network);
  const balances = await readRequiredChainResource(() => client.getAccountBalances(selector));
  const label = selected?.label ?? accountLabelForAddress(balances.address, network);
  return {
    address: balances.address,
    ...(label !== undefined && { label }),
    balances: balances.balances,
  };
}

async function readAccountNextSequenceResource(
  ctx: ToolContext,
  network: ResolvedNetwork,
  account: string,
): Promise<unknown> {
  const { client } = ctx.clients.getClient(network);
  const selected = await resolveAccountResourceSelector(ctx, network, account);
  const sequence = await readRequiredChainResource(() => client.getNextAccountSequenceNumber(selected.address));
  const label = selected.label ?? accountLabelForAddress(selected.address, network);
  return {
    address: selected.address,
    ...(label !== undefined && { label }),
    ...sequence,
  };
}

async function readAccountBalanceResource(
  ctx: ToolContext,
  network: ResolvedNetwork,
  account: string,
  tokenId: string,
): Promise<unknown> {
  const { client } = ctx.clients.getClient(network);
  const selected = tokenId === 'CCD' && isCanonicalUint64(account)
    ? undefined
    : await resolveAccountResourceSelector(ctx, network, account);
  const selector = selected?.address ?? account;
  const balance = await readRequiredChainResource(() => client.getAccountBalance(selector, tokenId));
  const label = selected?.label ?? accountLabelForAddress(balance.address, network);
  return {
    address: balance.address,
    ...(label !== undefined && { label }),
    balance: balance.balance,
  };
}

async function readAccountStakeResource(ctx: ToolContext, network: ResolvedNetwork, account: string): Promise<unknown> {
  const { client } = ctx.clients.getClient(network);
  const selected = resolveConfiguredLabel(account, network);
  const selector = isCanonicalUint64(account) ? account : selected?.address ?? resolveAccountInput(account, network);
  const stake = await readRequiredChainResource(() => client.getAccountStake(selector));
  const label = selected?.label ?? accountLabelForAddress(stake.address, network);
  return {
    address: stake.address,
    ...(label !== undefined && { label }),
    poolStatus: stake.poolStatus,
    stakedAmount: stake.stakedAmount,
    pendingChange: stake.pendingChange,
    ...(stake.validator !== undefined && { validator: stake.validator }),
    ...(stake.delegation !== undefined && { delegation: stake.delegation }),
  };
}

async function readAccountCredentialsResource(
  ctx: ToolContext,
  network: ResolvedNetwork,
  account: string,
): Promise<unknown> {
  const { client } = ctx.clients.getClient(network);
  const selected = await resolveAccountResourceSelector(ctx, network, account);
  const result = await readRequiredChainResource(() => getCompleteAccountCredentials(client, network, selected.address));
  const label = selected.label ?? accountLabelForAddress(result.canonicalAddress, network);
  return {
    address: result.canonicalAddress,
    ...(label !== undefined && { label }),
    accountThreshold: result.observation.accountThreshold,
    credentials: result.observation.credentials,
    sourceBlock: result.observation.sourceBlock,
  };
}

/** Returns account resource families before shared network routing is applied. */
export function accountResourceFamilies(): ChainNetworkResourceFamily[] {
  return [
    {
      name: 'account',
      path: 'account/{account}',
      title: 'Concordium Account',
      description: 'Account summary for an account address/alias, uint64 account index, or configured account label.',
      read: ({ ctx, network, parameters }) => readAccountResource(ctx, network, parameters.account!),
      listDefault: async (ctx) => listDefaultAddressResources(ctx.config.network),
    },
    {
      name: 'account-balances',
      path: 'account/{account}/balances',
      title: 'Concordium Account Balances',
      description: 'CCD and PLT balances for an account selector, keyed by token identifier.',
      read: ({ ctx, network, parameters }) => readAccountBalancesResource(ctx, network, parameters.account!),
    },
    {
      name: 'account-credentials',
      path: 'account/{account}/credentials',
      title: 'Concordium Account Credentials',
      description: 'Finalized public credential keys for an account selector, read from cache or refreshed from chain.',
      read: ({ ctx, network, parameters }) => readAccountCredentialsResource(ctx, network, parameters.account!),
    },
    {
      name: 'account-next-sequence-number',
      path: 'account/{account}/next-sequence-number',
      title: 'Concordium Account Next Sequence Number',
      description: 'Next sequence number and finality status for an account selector.',
      read: ({ ctx, network, parameters }) => readAccountNextSequenceResource(ctx, network, parameters.account!),
    },
    {
      name: 'account-token-balance',
      path: 'account/{account}/balances/{tokenId}',
      title: 'Concordium Account Token Balance',
      description: 'Single CCD or PLT balance for an account selector.',
      read: ({ ctx, network, parameters }) =>
        readAccountBalanceResource(ctx, network, parameters.account!, parameters.tokenId!),
    },
    {
      name: 'account-stake',
      path: 'account/{account}/stake',
      title: 'Concordium Account Stake',
      description: 'Validator or delegator staking details for an account selector.',
      read: ({ ctx, network, parameters }) => readAccountStakeResource(ctx, network, parameters.account!),
    },
  ];
}
