import { describe, expect, it } from 'vitest';
import { accountCredential } from '../helpers/accountCredentials.js';
import {
  AccountInfoType,
  BlockHash,
  Cbor,
  CborEpoch,
  CborMemo,
  CcdAmount,
  DelegationTargetType,
  LockId,
  LockMetadata as SDKLockMetadata,
  StakePendingChangeType,
  TokenAmount,
  TokenId,
  ReturnValue,
  type AccountInfo,
  type AccountBakerDetails,
  type BlockInfo,
  type ConsensusStatus,
  type InstanceInfo,
  type InvokeContractResult,
  type NextAccountNonce,
} from '@concordium/web-sdk';
import { sdkLockInfo, sdkRejectedReceiveFailure, sdkSimpleAccountInfo } from '../helpers/sdkFixtures.js';
import {
  accountBalancesToDto,
  accountInfoToDto,
  accountStakeToDto,
  blockInfoToDto,
  consensusInfoToDto,
  instanceInfoToDto,
  simulateContractResultToDto,
  lockInfoToDto,
  nextAccountSequenceNumberToDto,
  tokenBalancesToDto,
} from '../../src/concordium/serializers.js';

function accountInfo(overrides: Partial<AccountInfo> = {}): AccountInfo {
  return {
    type: 'simple',
    accountAddress: { address: '3kBx2h5Y2veb4hZgAJWPrr8RyQESKm5TjzF3ti1QQ4VSvj6tF' },
    accountAmount: { microCcdAmount: 1000000n },
    accountNonce: 5n,
    accountIndex: 42n,
    accountThreshold: 1,
    accountKeys: { 0: {} },
    accountCredentials: { 0: accountCredential() },
    ...overrides,
  } as unknown as AccountInfo;
}

describe('accountInfoToDto', () => {
  it('maps a simple account', () => {
    const raw = accountInfo({
      accountCredentials: { 0: accountCredential('initial', 'aa'.repeat(48)) },
    });

    expect(accountInfoToDto(raw)).toEqual({
      address: '3kBx2h5Y2veb4hZgAJWPrr8RyQESKm5TjzF3ti1QQ4VSvj6tF',
      'CCD Balance': { value: '1000000', decimals: 6, display: '1.000000 CCD' },
      sequenceNumber: '5',
      index: '42',
      accountType: 'Account',
      keys: {
        threshold: 1,
        credentialCount: 1,
        credentialIds: ['aa'.repeat(48)],
        credentials: {
          '0': {
            credentialId: 'aa'.repeat(48),
            threshold: 1,
            keys: { '0': { scheme: 'Ed25519', publicKey: 'cd'.repeat(32) } },
          },
        },
      },
      PLTs: [],
    });
  });

  it('maps nested credential key details and ignores unsupported key schemes', () => {
    const raw = accountInfo({
      accountCredentials: {
        0: accountCredential('normal', 'ef'.repeat(48), {
          threshold: 2,
          keys: {
            0: { schemeId: 'ed25519', verifyKey: 'cd'.repeat(32) },
            1: { schemeId: 'Other', verifyKey: 'ab'.repeat(32) },
          },
        }),
      },
    });

    expect(accountInfoToDto(raw).keys.credentials).toEqual({
      '0': {
        credentialId: 'ef'.repeat(48),
        threshold: 2,
        keys: { '0': { scheme: 'Ed25519', publicKey: 'cd'.repeat(32) } },
      },
    });
  });

  it('maps a baker account with stake and pending change', () => {
    const raw = {
      type: 'baker',
      accountAddress: { address: '4QkqdUnrjShrUrHpE96odLM6J77nWzEryifzqNnwNk4FYNge8a' },
      accountAmount: { microCcdAmount: 2000000n },
      accountNonce: 0n,
      accountIndex: 7n,
      accountThreshold: 1,
      accountKeys: { 0: {} },
      accountCredentials: { 0: accountCredential() },
      accountBaker: {
        stakedAmount: { microCcdAmount: 1500000n },
        pendingChange: {
          change: 'ReduceStake',
          newStake: 800000n,
          effectiveTime: new Date('2024-06-01T00:00:00Z'),
        },
      },
    } as unknown as AccountInfo;

    const dto = accountInfoToDto(raw);
    expect(dto.accountType).toBe('Baker');
    expect(dto.stake).toEqual({
      stakedAmount: '1500000',
      pendingChange: {
        change: 'ReduceStake',
        newStake: '800000',
        effectiveTime: '2024-06-01T00:00:00.000Z',
      },
    });
  });

  it('maps a delegator with a RemoveStake pending change', () => {
    const raw = {
      type: 'delegator',
      accountAddress: { address: '4QkqdUnrjShrUrHpE96odLM6J77nWzEryifzqNnwNk4FYNge8a' },
      accountAmount: { microCcdAmount: 3000000n },
      accountNonce: 0n,
      accountIndex: 9n,
      accountThreshold: 1,
      accountKeys: { 0: {} },
      accountCredentials: {},
      accountDelegation: {
        stakedAmount: { microCcdAmount: 1000000n },
        restakeEarnings: true,
        pendingChange: { change: 'RemoveStake', effectiveTime: new Date('2025-01-01T00:00:00Z') },
      },
    } as unknown as AccountInfo;

    const dto = accountInfoToDto(raw);
    expect(dto.accountType).toBe('Delegator');
    expect(dto.stake).toEqual({
      stakedAmount: '1000000',
      pendingChange: { change: 'RemoveStake', effectiveTime: '2025-01-01T00:00:00.000Z' },
    });
  });

  it('maps missing pending change to NoChange', () => {
    const raw = {
      type: 'delegator',
      accountAddress: { address: '4QkqdUnrjShrUrHpE96odLM6J77nWzEryifzqNnwNk4FYNge8a' },
      accountAmount: { microCcdAmount: 3000000n },
      accountNonce: 0n,
      accountIndex: 9n,
      accountThreshold: 1,
      accountKeys: { 0: {} },
      accountCredentials: {},
      accountDelegation: { stakedAmount: { microCcdAmount: 1000000n }, restakeEarnings: true },
    } as unknown as AccountInfo;

    const dto = accountInfoToDto(raw);
    expect(dto.accountType).toBe('Delegator');
    expect(dto.stake?.pendingChange).toEqual({ change: 'NoChange' });
  });

  it('returns no credential IDs for an empty credential map', () => {
    const raw = accountInfo({ accountCredentials: {} });

    expect(accountInfoToDto(raw).keys.credentialIds).toEqual([]);
  });
});

describe('accountBalancesToDto', () => {
  it('maps CCD releases and PLT balances by token id', () => {
    const raw = {
      accountAddress: { address: 'addr' },
      accountAmount: { microCcdAmount: 2000000n },
      accountAvailableBalance: { microCcdAmount: 1500000n },
      accountReleaseSchedule: {
        total: { microCcdAmount: 500000n },
        schedule: [
          {
            timestamp: new Date('2026-01-01T00:00:00Z'),
            amount: { microCcdAmount: 500000n },
            transactions: ['tx-hash'],
          },
        ],
      },
      accountTokens: [
        {
          id: 'IMT',
          state: {
            balance: { value: 825000000n, decimals: 6 },
          },
        },
      ],
    } as unknown as AccountInfo;

    expect(accountBalancesToDto(raw)).toEqual({
      address: 'addr',
      balances: {
        CCD: {
          tokenId: 'CCD',
          decimals: 6,
          totalBalance: { value: '2000000', decimals: 6, display: '2.000000 CCD' },
          availableBalance: { value: '1500000', decimals: 6, display: '1.500000 CCD' },
          lockedBalance: { value: '500000', decimals: 6, display: '0.500000 CCD' },
          releases: [
            {
              timestamp: '2026-01-01T00:00:00.000Z',
              amount: { value: '500000', decimals: 6, display: '0.500000 CCD' },
              transactions: ['tx-hash'],
            },
          ],
        },
        IMT: {
          tokenId: 'IMT',
          decimals: 6,
          totalBalance: { value: '825000000', decimals: 6, display: '825.000000' },
          availableBalance: { value: '825000000', decimals: 6, display: '825.000000' },
          lockedBalance: { value: '0', decimals: 6, display: '0.000000' },
          locks: [],
        },
      },
    });
  });
});

describe('accountStakeToDto', () => {
  it('maps accounts without staking to None', () => {
    const raw = { type: 'simple', accountAddress: { address: 'addr' } } as unknown as AccountInfo;
    expect(accountStakeToDto(raw)).toEqual({
      address: 'addr',
      poolStatus: 'None',
      stakedAmount: { value: '0', decimals: 6, display: '0.000000 CCD' },
      pendingChange: { change: 'NoChange' },
    });
  });

  it('maps delegators with validator targets', () => {
    const raw = {
      type: 'delegator',
      accountAddress: { address: 'addr' },
      accountDelegation: {
        stakedAmount: { microCcdAmount: 1000000n },
        restakeEarnings: true,
        pendingChange: {
          change: 'ReduceStake',
          newStake: 500000n,
          effectiveTime: new Date('2026-01-01T00:00:00Z'),
        },
        delegationTarget: { delegateType: 'Baker', bakerId: 42n },
      },
    } as unknown as AccountInfo;
    expect(accountStakeToDto(raw)).toEqual({
      address: 'addr',
      poolStatus: 'Delegator',
      stakedAmount: { value: '1000000', decimals: 6, display: '1.000000 CCD' },
      pendingChange: {
        change: 'ReduceStake',
        effectiveTime: '2026-01-01T00:00:00.000Z',
        newStake: { value: '500000', decimals: 6, display: '0.500000 CCD' },
      },
      delegation: {
        restakeEarnings: true,
        target: { type: 'Validator', validatorId: '42' },
      },
    });
  });

  it('maps validators with pool metadata', () => {
    const raw = {
      type: 'baker',
      accountAddress: { address: 'addr' },
      accountBaker: {
        bakerId: 7n,
        stakedAmount: { microCcdAmount: 2000000n },
        restakeEarnings: false,
        isSuspended: true,
        bakerPoolInfo: {
          openStatus: 'open',
          metadataUrl: 'https://example.com/pool.json',
          commissionRates: {
            transactionCommission: 0.1,
            bakingCommission: 0.2,
            finalizationCommission: 0.3,
          },
        },
      },
    } as unknown as AccountInfo;
    expect(accountStakeToDto(raw)).toEqual({
      address: 'addr',
      poolStatus: 'Validator',
      stakedAmount: { value: '2000000', decimals: 6, display: '2.000000 CCD' },
      pendingChange: { change: 'NoChange' },
      validator: {
        validatorId: '7',
        restakeEarnings: false,
        isSuspended: true,
        pool: {
          openStatus: 'open',
          metadataUrl: 'https://example.com/pool.json',
          commissionRates: {
            transactionCommission: 0.1,
            bakingCommission: 0.2,
            finalizationCommission: 0.3,
          },
        },
      },
    });
  });

  it('maps passive delegation and a RemoveStake pending change', () => {
    const { type: simpleType, ...base } = sdkSimpleAccountInfo('4QkqdUnrjShrUrHpE96odLM6J77nWzEryifzqNnwNk4FYNge8a');
    if (simpleType !== AccountInfoType.Simple) throw new Error('Expected a simple account fixture');
    const raw: AccountInfo = {
      ...base,
      type: AccountInfoType.Delegator,
      accountDelegation: {
        stakedAmount: CcdAmount.fromMicroCcd(750000n),
        restakeEarnings: false,
        delegationTarget: { delegateType: DelegationTargetType.PassiveDelegation },
        pendingChange: {
          change: StakePendingChangeType.RemoveStake,
          effectiveTime: new Date('2026-02-01T00:00:00Z'),
        },
      },
    };

    expect(accountStakeToDto(raw)).toMatchObject({
      poolStatus: 'Delegator',
      pendingChange: { change: 'RemoveStake', effectiveTime: '2026-02-01T00:00:00.000Z' },
      delegation: { restakeEarnings: false, target: { type: 'PassiveDelegation' } },
    });
  });

  it.each([
    {
      version: 0 as const,
      expectedPool: undefined,
    },
    {
      version: 1 as const,
      bakerPoolInfo: {
        openStatus: null,
        metadataUrl: '',
        commissionRates: { transactionCommission: 0, bakingCommission: 0, finalizationCommission: 0 },
      },
      expectedPool: {
        openStatus: null,
        metadataUrl: '',
        commissionRates: { transactionCommission: 0, bakingCommission: 0, finalizationCommission: 0 },
      },
    },
  ])('maps a version $version validator with optional pool metadata', ({ expectedPool, ...variant }) => {
    const { type: simpleType, ...base } = sdkSimpleAccountInfo('4QkqdUnrjShrUrHpE96odLM6J77nWzEryifzqNnwNk4FYNge8a');
    if (simpleType !== AccountInfoType.Simple) throw new Error('Expected a simple account fixture');
    const accountBaker: AccountBakerDetails =
      variant.version === 0
        ? {
            version: 0,
            bakerId: 7n,
            stakedAmount: CcdAmount.fromMicroCcd(2000000n),
            restakeEarnings: false,
            isSuspended: false,
            bakerAggregationVerifyKey: '',
            bakerElectionVerifyKey: '',
            bakerSignatureVerifyKey: '',
          }
        : {
            version: 1,
            bakerPoolInfo: variant.bakerPoolInfo,
            bakerId: 7n,
            stakedAmount: CcdAmount.fromMicroCcd(2000000n),
            restakeEarnings: false,
            isSuspended: false,
            bakerAggregationVerifyKey: '',
            bakerElectionVerifyKey: '',
            bakerSignatureVerifyKey: '',
          };
    const raw: AccountInfo = {
      ...base,
      type: AccountInfoType.Baker,
      accountBaker,
    };

    expect(accountStakeToDto(raw).validator?.pool).toEqual(expectedPool);
  });
});

describe('tokenBalancesToDto', () => {
  it('maps account tokens without locks', () => {
    const raw = {
      accountAddress: { address: 'addr' },
      accountTokens: [
        {
          id: 'IMT',
          state: {
            balance: { value: 825000000n, decimals: 6 },
          },
        },
      ],
    } as unknown as AccountInfo;

    expect(tokenBalancesToDto(raw)).toEqual([
      {
        tokenId: 'IMT',
        holder: 'addr',
        decimals: 6,
        'total balance': { value: '825000000', decimals: 6, display: '825.000000' },
        'available balance': { value: '825000000', decimals: 6, display: '825.000000' },
        'locked balance': { value: '0', decimals: 6, display: '0.000000' },
        locks: [],
      },
    ]);
  });

  it('maps module-state available balances and locks', () => {
    const lock = LockId.create(42n, 5n, 9n);
    const raw = {
      accountAddress: { address: 'addr' },
      accountTokens: [
        {
          id: 'IMT',
          state: {
            balance: { value: 825n, decimals: 2 },
            moduleState: Cbor.encode({
              available: TokenAmount.create(800n, 2),
              locks: [{ lock, amount: TokenAmount.create(25n, 2) }],
            }),
          },
        },
      ],
    } as unknown as AccountInfo;

    expect(tokenBalancesToDto(raw)[0]).toMatchObject({
      'available balance': { value: '800', display: '8.00' },
      'locked balance': { value: '25', display: '0.25' },
      locks: [{ lock: lock.toString(), amount: { value: '25', display: '0.25' } }],
    });
  });

  it('falls back to total and no locks when optional CBOR account state fields are absent', () => {
    const raw: AccountInfo = {
      ...sdkSimpleAccountInfo('4QkqdUnrjShrUrHpE96odLM6J77nWzEryifzqNnwNk4FYNge8a'),
      accountTokens: [
        {
          id: TokenId.fromString('IMT'),
          state: {
            balance: TokenAmount.create(825n, 2),
            moduleState: Cbor.encode({}),
          },
        },
      ],
    };

    expect(tokenBalancesToDto(raw)[0]).toMatchObject({
      'total balance': { value: '825', display: '8.25' },
      'available balance': { value: '825', display: '8.25' },
      'locked balance': { value: '0', display: '0.00' },
      locks: [],
    });
  });
});

describe('lockInfoToDto', () => {
  const address = '32dZpZpu929J81XPFPbBxhwdig3v18U8KnBTXK3vrwdhUAk1Bp';

  it.each([
    { memo: Uint8Array.from([0xaa, 0xbb, 0xcc]), hex: 'aabbcc' },
    { memo: CborMemo.fromString('hello'), hex: '6568656c6c6f' },
  ])('maps memo $hex with grants, token IDs, keep-alive, and funds', ({ memo, hex }) => {
    const raw = sdkLockInfo(address, memo);

    expect(lockInfoToDto(raw)).toEqual({
      lockId: raw.lock.toString(),
      creatorAccountIndex: '42',
      creatorSequenceNumber: '5',
      creationOrder: '9',
      recipients: [address],
      expiryUnixSeconds: '1700000000',
      expiryTime: '2023-11-14T22:13:20.000Z',
      grants: [
        { account: address, capabilities: ['fund', 'send'] },
        { account: address, capabilities: ['release', 'cancel'] },
      ],
      tokenIds: ['TOKEN', 'OTHER'],
      keepAlive: true,
      memoHex: hex,
      funds: [
        {
          account: address,
          balances: [
            { tokenId: 'TOKEN', decimals: 3, amount: { value: '123456', decimals: 3, display: '123.456' } },
            { tokenId: 'OTHER', decimals: 0, amount: { value: '50', decimals: 0, display: '50' } },
          ],
        },
      ],
    });
  });

  it('maps any-recipient locks without optional controller fields', () => {
    expect(
      lockInfoToDto({
        lock: LockId.create(7n, 3n, 2n),
        config: {
          simpleV0: {
            recipients: 'any',
            expiry: CborEpoch.fromEpochSeconds(1_700_000_060n),
            grants: [],
            tokens: [],
          },
        },
        funds: [],
      }),
    ).toEqual({
      lockId: LockId.create(7n, 3n, 2n).toString(),
      creatorAccountIndex: '7',
      creatorSequenceNumber: '3',
      creationOrder: '2',
      recipients: 'any',
      expiryUnixSeconds: '1700000060',
      expiryTime: '2023-11-14T22:14:20.000Z',
      grants: [],
      tokenIds: [],
      funds: [],
    });

    const metadataJson = {
      name: 'Escrow',
      description: 'Release after delivery',
      documentHash: Uint8Array.from([0xab, 0xcd]),
      nested: [{ amount: 9_007_199_254_740_993n }, Uint8Array.from([0x01, 0x02])],
    };
    const metadataFixtures = [
      {
        raw: SDKLockMetadata.encode(metadataJson),
        cbor: {
          name: 'Escrow',
          description: 'Release after delivery',
          documentHash: 'abcd',
          nested: [{ amount: '9007199254740993' }, '0102'],
        },
      },
      { raw: SDKLockMetadata.encode({}), cbor: {} },
      { raw: Uint8Array.from([0xff]) },
      { raw: Cbor.toBuffer(Cbor.encode({ name: 42 })) },
      { raw: Cbor.toBuffer(Cbor.encode(new Map([[1, 'not-a-JSON-object']]))) },
    ];
    for (const fixture of metadataFixtures) {
      const dto = lockInfoToDto({
        lock: LockId.create(7n, 3n, 2n),
        config: {
          simpleV0: {
            recipients: 'any',
            expiry: CborEpoch.fromEpochSeconds(1_700_000_060n),
            grants: [],
            tokens: [],
            metadata: fixture.raw,
          },
        },
        funds: [],
      });
      expect(dto.metadata).toEqual({
        hex: Buffer.from(fixture.raw).toString('hex'),
        ...(fixture.cbor !== undefined && { cbor: fixture.cbor }),
      });
    }
  });
});

describe('nextAccountSequenceNumberToDto', () => {
  it('serializes the sequence number as a decimal string', () => {
    const raw = { nonce: 7n, allFinal: true } as unknown as NextAccountNonce;
    expect(nextAccountSequenceNumberToDto(raw)).toEqual({ sequenceNumber: '7', allFinal: true });
  });
});

describe('blockInfoToDto', () => {
  it('maps block fields including ISO slot time and era', () => {
    const raw = {
      blockHash: BlockHash.fromHexString('ab'.repeat(32)),
      blockHeight: 1234n,
      blockSlotTime: new Date('2024-01-01T00:00:00Z'),
      finalized: true,
      transactionCount: 42n,
      genesisIndex: 3,
    } as unknown as BlockInfo;

    expect(blockInfoToDto(raw)).toEqual({
      hash: 'ab'.repeat(32),
      height: '1234',
      slotTime: '2024-01-01T00:00:00.000Z',
      era: 3,
      transactionsCount: '42',
      finalized: true,
    });
  });
});

describe('consensusInfoToDto', () => {
  it('maps a protocol 6+ (V1) consensus status with epoch', () => {
    const raw = {
      version: 1,
      bestBlock: 'aa',
      lastFinalizedBlock: 'bb',
      lastFinalizedBlockHeight: 5000n,
      genesisTime: new Date('2021-06-09T10:00:00Z'),
      currentEraGenesisTime: new Date('2024-01-01T00:00:00Z'),
      genesisIndex: 2,
      concordiumBFTStatus: { currentEpoch: 17n },
    } as unknown as ConsensusStatus;

    expect(consensusInfoToDto(raw)).toEqual({
      bestBlockHash: 'aa',
      lastFinalizedBlockHash: 'bb',
      lastFinalizedBlockHeight: '5000',
      genesisTime: '2021-06-09T10:00:00.000Z',
      currentEraGenesisTime: '2024-01-01T00:00:00.000Z',
      epoch: '17',
      currentEra: 2,
    });
  });

  it('omits epoch for pre-protocol-6 (V0) consensus status', () => {
    const raw = {
      version: 0,
      bestBlock: 'aa',
      lastFinalizedBlock: 'bb',
      lastFinalizedBlockHeight: 100n,
      genesisTime: new Date('2021-06-09T10:00:00Z'),
      currentEraGenesisTime: new Date('2021-06-09T10:00:00Z'),
      genesisIndex: 0,
      slotDuration: 250,
    } as unknown as ConsensusStatus;

    const dto = consensusInfoToDto(raw);
    expect(dto.epoch).toBeUndefined();
    expect(dto.currentEra).toBe(0);
  });
});

describe('instanceInfoToDto', () => {
  it('maps instance fields and the query address', () => {
    const raw = {
      version: 1,
      amount: { microCcdAmount: 999n },
      sourceModule: 'module123',
      owner: { address: '4QkqdUnrjShrUrHpE96odLM6J77nWzEryifzqNnwNk4FYNge8a' },
      methods: ['CIS2.transfer', 'CIS2.balanceOf'],
      name: 'init_CIS2',
    } as unknown as InstanceInfo;

    expect(instanceInfoToDto(raw, { index: 9870n, subindex: 0n })).toEqual({
      index: '9870',
      subindex: '0',
      moduleRef: 'module123',
      owner: '4QkqdUnrjShrUrHpE96odLM6J77nWzEryifzqNnwNk4FYNge8a',
      amount: '999',
      name: 'init_CIS2',
      methods: ['CIS2.transfer', 'CIS2.balanceOf'],
    });
  });
});

describe('simulateContractResultToDto', () => {
  it('maps a successful invocation with return value', () => {
    const raw = {
      tag: 'success',
      usedEnergy: 500n,
      returnValue: ReturnValue.fromHexString('010203'),
      events: [{}, {}, {}],
    } as unknown as InvokeContractResult;

    const dto = simulateContractResultToDto(raw);
    expect(dto.tag).toBe('success');
    expect(dto.usedEnergy).toBe('500');
    expect(dto.returnValueHex).toBe(Buffer.from([1, 2, 3]).toString('hex'));
    expect(dto.eventCount).toBe(3);
  });

  it('maps a failed invocation with a reason', () => {
    const raw = {
      tag: 'failure',
      usedEnergy: 100n,
      reason: { tag: 42 },
      returnValue: ReturnValue.fromHexString('040506'),
    } as unknown as InvokeContractResult;

    const dto = simulateContractResultToDto(raw);
    expect(dto.tag).toBe('failure');
    expect(dto.usedEnergy).toBe('100');
    expect(dto.reason).toBeTruthy();
    expect(dto.returnValueHex).toBeUndefined();
    expect(dto.errorHex).toBe(Buffer.from([4, 5, 6]).toString('hex'));
  });

  it('maps SDK RejectedReceive reasons with bigint fields into stable JSON', () => {
    const dto = simulateContractResultToDto(sdkRejectedReceiveFailure());
    expect(dto).toMatchObject({ tag: 'failure', usedEnergy: '100', errorHex: '040506' });
    expect(dto.reason).toBeDefined();
    const reason = JSON.parse(dto.reason ?? '{}') as Record<string, unknown>;
    expect(reason).toMatchObject({
      tag: 'RejectedReceive',
      contractAddress: { index: '7', subindex: '0' },
      receiveName: { contractName: 'counter', receiveName: 'set' },
      rejectReason: -2147483648,
      parameter: '0102',
    });
  });
});
