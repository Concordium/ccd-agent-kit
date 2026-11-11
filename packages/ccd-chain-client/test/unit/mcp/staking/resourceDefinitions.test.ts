import { describe, expect, it, vi } from 'vitest';
import type { PassiveDelegationInfoDTO, PoolInfoDTO } from '../../../../src/concordium/dto.js';
import { stakingResourceFamilies } from '../../../../src/mcp/staking/resourceDefinitions.js';
import { domainFamily, readDomainResource } from '../../../helpers/domainResources.js';
import { FakeConcordiumClient, makeContext } from '../../../helpers/fakes.js';

const PASSIVE_DELEGATION = {
  totalStaked: '5000000',
  currentPaydayStaked: '4000000',
} satisfies PassiveDelegationInfoDTO;

const RICH_POOL = {
  poolId: '42',
  bakerAccount: 'validator',
  stakedAmount: '4000000',
  delegatedAmount: '3000000',
  delegatedCapitalCap: '5000000',
  currentPaydayStaked: '3000000',
  currentPaydayDelegated: '2000000',
  poolType: 'BakerPool',
  isSuspended: true,
  poolInfo: {
    openStatus: 'openForAll',
    metadataUrl: 'https://example.com/pool.json',
    commissionRates: {
      transactionCommission: 0.1,
      bakingCommission: 0.2,
      finalizationCommission: 0.3,
    },
  },
} satisfies PoolInfoDTO;

describe('staking resource definitions', () => {
  it('routes pool ids and projects rich pool details', async () => {
    const client = new FakeConcordiumClient({ pools: { '42': RICH_POOL } });
    const getPoolInfo = vi.spyOn(client, 'getPoolInfo');
    const result = await readDomainResource(stakingResourceFamilies(), 'pool-delegation', makeContext(client), {
      network: 'testnet', parameters: { poolId: '42' },
    });

    expect(result).toEqual({
      totalAmount: { value: '7000000', decimals: 6, display: '7.000000 CCD' },
      currentPaydayTotalAmount: { value: '5000000', decimals: 6, display: '5.000000 CCD' },
      commission: { transaction: '10%', baking: '20%' },
      pool: {
        poolId: '42',
        status: 'openForAll',
        validatorAccount: 'validator',
        isSuspended: true,
        validatorStakeAmount: { value: '4000000', decimals: 6, display: '4.000000 CCD' },
        delegatedAmount: { value: '3000000', decimals: 6, display: '3.000000 CCD' },
        delegationCap: { value: '5000000', decimals: 6, display: '5.000000 CCD' },
        delegationAvailable: { value: '2000000', decimals: 6, display: '2.000000 CCD' },
        metadataUrl: 'https://example.com/pool.json',
      },
    });
    expect(getPoolInfo).toHaveBeenCalledExactlyOnceWith(42n);
  });

  it('projects passive delegation totals and commission', async () => {
    const client = new FakeConcordiumClient({ passiveDelegation: PASSIVE_DELEGATION });
    const getPassiveDelegationInfo = vi.spyOn(client, 'getPassiveDelegationInfo');

    await expect(readDomainResource(stakingResourceFamilies(), 'passive-delegation', makeContext(client))).resolves.toEqual({
      totalAmount: { value: '5000000', decimals: 6, display: '5.000000 CCD' },
      currentPaydayTotalAmount: { value: '4000000', decimals: 6, display: '4.000000 CCD' },
      commission: { transaction: '25%', baking: '25%' },
    });
    expect(getPassiveDelegationInfo).toHaveBeenCalledOnce();
  });

  it('lists the default passive delegation resource', async () => {
    await expect(domainFamily(stakingResourceFamilies(), 'passive-delegation').listDefault?.(
      makeContext(new FakeConcordiumClient()),
    )).resolves.toEqual([
      { uri: 'ccd://delegation/passive', name: 'Concordium Passive Delegation' },
    ]);
  });

  it('rejects non-numeric pool ids before querying a pool', async () => {
    const client = new FakeConcordiumClient();
    const getPoolInfo = vi.spyOn(client, 'getPoolInfo');
    await expect(
      readDomainResource(stakingResourceFamilies(), 'pool-delegation', makeContext(client), {
        parameters: { poolId: 'nope' },
      }),
    ).rejects.toMatchObject({
      kind: 'invalid-argument',
    });
    expect(getPoolInfo).not.toHaveBeenCalled();
  });
});
