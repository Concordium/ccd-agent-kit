import type { ResolvedNetwork } from '@ccd-agent-kit/config-utils';
import { formatCcd } from '../../concordium/formats.js';
import { displayValue } from '../../concordium/serializers.js';
import type { DisplayValueDTO, PoolInfoDTO } from '../../concordium/dto.js';
import { readRequiredChainResource, type ChainNetworkResourceFamily } from '../resourcePlumbing/networkResources.js';
import type { ToolContext } from '../toolPlumbing/toolTypes.js';

interface DelegationCommissionDto {
  transaction: string;
  baking: string;
}


interface PassiveDelegationResourceDto {
  totalAmount: DisplayValueDTO;
  currentPaydayTotalAmount: DisplayValueDTO;
  commission: DelegationCommissionDto;
}

interface PoolDelegationResourceDto extends PassiveDelegationResourceDto {
  pool: {
    poolId: string;
    status?: string | null;
    validatorAccount: string;
    isSuspended: boolean;
    validatorStakeAmount: DisplayValueDTO;
    delegatedAmount: DisplayValueDTO;
    delegationCap?: DisplayValueDTO;
    delegationAvailable?: DisplayValueDTO;
    metadataUrl?: string;
  };
}

function ccdValue(value: string | bigint): DisplayValueDTO {
  const amount = typeof value === 'bigint' ? value : BigInt(value);
  return displayValue(amount, 6, formatCcd(amount));
}

function formatCommission(rate: number): string {
  return `${Number((rate * 100).toFixed(12)).toString()}%`;
}

function poolCommission(pool: PoolInfoDTO): DelegationCommissionDto {
  const rates = pool.poolInfo?.commissionRates;
  return {
    transaction: formatCommission(rates?.transactionCommission ?? 0),
    baking: formatCommission(rates?.bakingCommission ?? 0),
  };
}

function poolDelegationResource(pool: PoolInfoDTO): PoolDelegationResourceDto {
  const validatorStakeAmount = BigInt(pool.stakedAmount);
  const delegatedAmount = BigInt(pool.delegatedAmount);
  const currentPaydayValidatorStakeAmount = BigInt(pool.currentPaydayStaked);
  const currentPaydayDelegatedAmount = BigInt(pool.currentPaydayDelegated);
  const delegationCap = pool.delegatedCapitalCap === undefined ? undefined : BigInt(pool.delegatedCapitalCap);
  const delegationAvailable =
    delegationCap === undefined ? undefined : delegationCap > delegatedAmount ? delegationCap - delegatedAmount : 0n;

  return {
    totalAmount: ccdValue(validatorStakeAmount + delegatedAmount),
    currentPaydayTotalAmount: ccdValue(currentPaydayValidatorStakeAmount + currentPaydayDelegatedAmount),
    commission: poolCommission(pool),
    pool: {
      poolId: pool.poolId,
      validatorAccount: pool.bakerAccount,
      isSuspended: pool.isSuspended ?? false,
      validatorStakeAmount: ccdValue(validatorStakeAmount),
      delegatedAmount: ccdValue(delegatedAmount),
      ...(pool.poolInfo?.openStatus !== undefined && { status: pool.poolInfo.openStatus }),
      ...(delegationCap !== undefined && { delegationCap: ccdValue(delegationCap) }),
      ...(delegationAvailable !== undefined && { delegationAvailable: ccdValue(delegationAvailable) }),
      ...(pool.poolInfo?.metadataUrl !== undefined && { metadataUrl: pool.poolInfo.metadataUrl }),
    },
  };
}

async function readPassiveDelegationResource(ctx: ToolContext, network: ResolvedNetwork): Promise<unknown> {
  const info = await ctx.clients.getClient(network).client.getPassiveDelegationInfo();
  return {
    totalAmount: ccdValue(info.totalStaked),
    currentPaydayTotalAmount: ccdValue(info.currentPaydayStaked),
    commission: { transaction: '25%', baking: '25%' },
  } satisfies PassiveDelegationResourceDto;
}

async function readPoolDelegationResource(ctx: ToolContext, network: ResolvedNetwork, poolId: string): Promise<unknown> {
  if (!/^\d+$/.test(poolId)) throw { kind: 'invalid-argument', message: 'Pool ID must be a non-negative integer.' };
  const pool = await readRequiredChainResource(() => ctx.clients.getClient(network).client.getPoolInfo(BigInt(poolId)));
  return poolDelegationResource(pool);
}

/** Delegation-target resource family definitions. */
export function stakingResourceFamilies(): ChainNetworkResourceFamily[] {
  return [
    {
      name: 'passive-delegation', path: 'delegation/passive',
      title: 'Concordium Passive Delegation',
      description: 'Passive delegation target summary, including totals and commission.',
      read: ({ ctx, network }) => readPassiveDelegationResource(ctx, network),
      listDefault: async () => [{ uri: 'ccd://delegation/passive', name: 'Concordium Passive Delegation' }],
    },
    {
      name: 'pool-delegation', path: 'delegation/{poolId}',
      title: 'Concordium Pool Delegation',
      description: 'Validator pool delegation target summary, including totals, commission, status, and capacity.',
      read: ({ ctx, network, parameters }) => readPoolDelegationResource(ctx, network, parameters.poolId!),
    },
  ];
}
