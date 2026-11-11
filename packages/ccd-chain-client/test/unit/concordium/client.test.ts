import { AccountInfoType, BlockHash, DelegationTargetType, TokenId } from '@concordium/web-sdk';
import { describe, expect, it, vi } from 'vitest';
import { ConcordiumNodeQueries } from '../../../src/concordium/client.js';
import { sdkSimpleAccountInfo } from '../../helpers/sdkFixtures.js';

function asyncItems<T>(items: T[]): AsyncIterable<T> {
  return {
    async *[Symbol.asyncIterator]() {
      yield* items;
    },
  };
}

describe('ConcordiumNodeQueries client decisions', () => {
  const accountAddress = '4StnMEQCKtfDRuHJfsY6eZL9KJWqdYoqRVRoDSSAz35LsmHcmg';

  it.each([
    [
      'baker',
      {
        type: AccountInfoType.Baker,
        accountBaker: { stakedAmount: { microCcdAmount: 12n } },
      },
      { address: accountAddress, poolStatus: 'Baker', stakedAmount: '12' },
    ],
    [
      'validator delegator',
      {
        type: AccountInfoType.Delegator,
        accountDelegation: {
          delegationTarget: { delegateType: DelegationTargetType.Baker, bakerId: 7n },
          stakedAmount: { microCcdAmount: 34n },
        },
      },
      { address: accountAddress, poolStatus: 'Delegator', bakerPoolId: '7', stakedAmount: '34' },
    ],
    [
      'passive delegator',
      {
        type: AccountInfoType.Delegator,
        accountDelegation: {
          delegationTarget: { delegateType: 'PassiveDelegation' },
          stakedAmount: { microCcdAmount: 34n },
        },
      },
      { address: accountAddress, poolStatus: 'Delegator', stakedAmount: '34' },
    ],
    [
      'non-staker',
      { type: AccountInfoType.Simple },
      { address: accountAddress, poolStatus: 'None', stakedAmount: '0' },
    ],
  ])('maps %s account pool status', async (_name, accountInfo, expected) => {
    const client = new ConcordiumNodeQueries({ getAccountInfo: async () => accountInfo } as never);
    await expect(client.getAccountPoolInfo(accountAddress)).resolves.toEqual(expected);
  });

  it('returns a zero PLT balance when the account does not hold the token', async () => {
    const client = new ConcordiumNodeQueries({
      getAccountInfo: async () => ({ accountAddress: { address: accountAddress }, accountTokens: [] }),
      getTokenInfo: async () => ({ state: { decimals: 3 } }),
    } as never);

    await expect(client.getTokenBalance('IMT', accountAddress)).resolves.toEqual({
      tokenId: 'IMT',
      holder: accountAddress,
      decimals: 3,
      'total balance': { value: '0', decimals: 3, display: '0.000' },
      'available balance': { value: '0', decimals: 3, display: '0.000' },
      'locked balance': { value: '0', decimals: 3, display: '0.000' },
      locks: [],
    });
  });

  it('collects node streams while token-id reads avoid metadata fanout', async () => {
    const getTokenInfo = vi.fn(async () => ({ state: { decimals: 2, totalSupply: { value: 12345n } } }));
    const client = new ConcordiumNodeQueries({
      getLockList: () => asyncItems([{ toString: () => 'lock-a' }]),
      getModuleList: () => asyncItems([{ toString: () => 'module-a' }]),
      getTokenList: () => asyncItems([TokenId.fromString('TOKEN')]),
      getTokenInfo,
    } as never);

    await expect(client.getLockList()).resolves.toEqual(['lock-a']);
    await expect(client.getModuleRefs()).resolves.toEqual(['module-a']);
    await expect(client.getTokenIds()).resolves.toEqual(['TOKEN']);
    expect(getTokenInfo).not.toHaveBeenCalled();
    await expect(client.getTokenList()).resolves.toEqual({
      PLTs: [
        {
          tokenId: 'TOKEN',
          decimals: 2,
          'total supply': { value: '12345', decimals: 2, display: '123.45' },
        },
      ],
    });
    expect(getTokenInfo).toHaveBeenCalledOnce();
  });

  it('uses one resolved block for transaction-event metadata and streaming', async () => {
    const finalizedHash = BlockHash.fromHexString('ef'.repeat(32));
    const getBlockInfo = vi.fn(async () => ({ blockHash: finalizedHash, blockHeight: 123n }));
    const getBlockTransactionEvents = vi.fn(() => asyncItems([]));
    const client = new ConcordiumNodeQueries({
      getConsensusStatus: async () => ({ lastFinalizedBlock: finalizedHash }),
      getBlockInfo,
      getBlockTransactionEvents,
    } as never);

    await expect(client.getBlockTransactionEvents({ type: 'last_final' })).resolves.toEqual({
      events: [],
      hash: String(finalizedHash),
      height: '123',
    });
    expect(getBlockInfo).toHaveBeenCalledWith(finalizedHash);
    expect(getBlockTransactionEvents).toHaveBeenCalledWith(finalizedHash);
  });

  it('preserves received transaction status without manufacturing effects', async () => {
    const transactionHash = 'ab'.repeat(32);
    const client = new ConcordiumNodeQueries({
      getBlockItemStatus: async () => ({ status: 'received' }),
    } as never);

    await expect(client.getTransactionEffects(transactionHash)).resolves.toEqual({
      transactionHash,
      status: 'received',
      blockHash: null,
      effects: [],
    });
  });

  it('maps representative typed unary node results', async () => {
    const client = new ConcordiumNodeQueries({
      getNextAccountNonce: async () => ({ nonce: 12n, allFinal: true }),
      getConsensusStatus: async () => ({
        version: 1,
        bestBlock: 'best-hash',
        lastFinalizedBlock: 'final-hash',
        lastFinalizedBlockHeight: 456n,
        genesisTime: new Date('2026-01-01T00:00:00.000Z'),
        currentEraGenesisTime: new Date('2026-01-02T00:00:00.000Z'),
        genesisIndex: 3,
        protocolVersion: 11n,
      }),
      getBlockInfo: async () => ({
        blockHash: 'block-hash',
        blockHeight: 123n,
        blockSlotTime: new Date('2026-01-02T03:04:05.000Z'),
        genesisIndex: 2,
        transactionCount: 7n,
        finalized: true,
      }),
      getPassiveDelegationInfo: async () => ({
        delegatedCapital: { microCcdAmount: 123n },
        currentPaydayDelegatedCapital: { microCcdAmount: 45n },
      }),
    } as never);

    await expect(client.getNextAccountSequenceNumber(accountAddress)).resolves.toEqual({
      sequenceNumber: '12',
      allFinal: true,
    });
    await expect(client.getProtocolVersion()).resolves.toBe(11);
    await expect(client.getConsensusInfo()).resolves.toMatchObject({ lastFinalizedBlockHeight: '456' });
    await expect(client.getBlockInfo()).resolves.toMatchObject({ hash: 'block-hash', height: '123' });
    await expect(client.getPassiveDelegationInfo()).resolves.toEqual({
      totalStaked: '123',
      currentPaydayStaked: '45',
    });
  });

  it.each([
    [
      {
        bakerId: 7n,
        bakerAddress: { address: accountAddress },
        bakerEquityCapital: { microCcdAmount: 10n },
        delegatedCapital: { microCcdAmount: 20n },
        delegatedCapitalCap: { microCcdAmount: 30n },
        currentPaydayStatus: {
          bakerEquityCapital: { microCcdAmount: 9n },
          delegatedCapital: { microCcdAmount: 19n },
        },
        poolInfo: { openStatus: null, metadataUrl: '', commissionRates: {} },
        isSuspended: false,
      },
      { delegatedCapitalCap: '30', currentPaydayStaked: '9', poolInfo: { openStatus: null } },
    ],
    [
      { bakerId: 7n, bakerAddress: { address: accountAddress }, isSuspended: false },
      { stakedAmount: '0', delegatedAmount: '0', currentPaydayStaked: '0', currentPaydayDelegated: '0' },
    ],
  ])('maps optional pool fields from structured SDK results', async (poolInfo, expected) => {
    const client = new ConcordiumNodeQueries({ getPoolInfo: async () => poolInfo } as never);
    await expect(client.getPoolInfo(7n)).resolves.toMatchObject(expected);
  });

  it('caches the address from a cold account-index lookup and still queries numeric selectors as indexes', async () => {
    const seen: unknown[] = [];
    const client = new ConcordiumNodeQueries({
      getAccountInfo: async (identifier: unknown) => {
        seen.push(identifier);
        return sdkSimpleAccountInfo(accountAddress);
      },
    } as never);

    await expect(client.getAccountAddressByIndex(42n)).resolves.toBe(accountAddress);
    expect(seen).toEqual([42n]);
    await expect(client.getAccountAddressByIndex(42n)).resolves.toBe(accountAddress);
    expect(seen).toEqual([42n]);

    await expect(client.getAccountBalances('42')).resolves.toMatchObject({ address: accountAddress });
    await expect(client.getAccountBalance('42', 'CCD')).resolves.toMatchObject({ address: accountAddress });
    await expect(client.getAccountStake('42')).resolves.toMatchObject({ address: accountAddress });
    expect(seen).toEqual([42n, 42n, 42n, 42n]);
  });
});
