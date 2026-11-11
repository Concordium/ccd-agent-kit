import {
  AccountInfoType,
  Cbor,
  CborAccountAddress,
  CborMemo,
  DelegationTargetType,
  LockMetadata,
  ReturnValue,
  StakePendingChangeType,
  TransactionExpiry,
  type AccountInfo,
  type AccountBakerDetails,
  type AccountDelegationDetails,
  type BlockInfo,
  type ConsensusStatus,
  type InstanceInfo,
  type InvokeContractResult,
  type LockInfo,
  type NextAccountNonce,
  type StakePendingChange,
} from '@concordium/web-sdk';
import { mcpJsonValueSchema } from '@ccd-agent-kit/mcp-utils';
import { z } from 'zod';
import { credentialIdOf, credentialPublicData } from '@ccd-agent-kit/sdk-utils';
import type { ContractIdentifier } from './client.js';
import { formatCcd, formatTokenAmount } from './formats.js';
import type {
  AccountInfoDTO,
  AccountBalancesDTO,
  AccountStakeResourceDTO,
  AccountStakeResourcePendingChangeDTO,
  DisplayValueDTO,
  CcdBalanceDTO,
  AccountKeysDTO,
  PltBalanceDTO,
  AccountStakeDTO,
  AccountStakePendingChangeDTO,
  BlockInfoDTO,
  ConsensusInfoDTO,
  InstanceInfoDTO,
  LockFundAmountDTO,
  LockFundDTO,
  LockGrantDTO,
  LockInfoDTO,
  JsonObject,
  InvokeResultDTO,
  NextSequenceNumberDTO,
  TokenHoldingDTO,
  TokenBalanceDTO,
  TokenLockDTO,
} from './dto.js';

const mcpJsonObjectSchema: z.ZodType<JsonObject> = z.record(z.string(), mcpJsonValueSchema);

function ccdDisplayValue(value: bigint): DisplayValueDTO {
  return displayValue(value, 6, formatCcd(value));
}

function accountTypeToDto(type: AccountInfoType): AccountInfoDTO['accountType'] {
  switch (type) {
    case AccountInfoType.Simple:
      return 'Account';
    case AccountInfoType.Baker:
      return 'Baker';
    case AccountInfoType.Delegator:
      return 'Delegator';
    default:
      return 'Unknown';
  }
}

function pendingChangeToDto(raw: StakePendingChange | undefined | null): AccountStakePendingChangeDTO {
  if (raw === undefined || raw === null) return { change: 'NoChange' };
  if (raw.change === StakePendingChangeType.ReduceStake) {
    return {
      change: 'ReduceStake',
      effectiveTime: raw.effectiveTime.toISOString(),
      newStake: raw.newStake.toString(),
    };
  }
  return { change: 'RemoveStake', effectiveTime: raw.effectiveTime.toISOString() };
}

function pendingChangeToResourceDto(raw: StakePendingChange | undefined | null): AccountStakeResourcePendingChangeDTO {
  if (raw === undefined || raw === null) return { change: 'NoChange' };
  if (raw.change === StakePendingChangeType.ReduceStake) {
    return {
      change: 'ReduceStake',
      effectiveTime: raw.effectiveTime.toISOString(),
      newStake: ccdDisplayValue(raw.newStake),
    };
  }
  return { change: 'RemoveStake', effectiveTime: raw.effectiveTime.toISOString() };
}

function stakeToDto(raw: Pick<AccountBakerDetails | AccountDelegationDetails, 'stakedAmount' | 'pendingChange'>): AccountStakeDTO {
  return {
    stakedAmount: raw.stakedAmount.microCcdAmount.toString(),
    pendingChange: pendingChangeToDto(raw.pendingChange),
  };
}

function credentialDetailsOf(
  credential: AccountInfo['accountCredentials'][number],
): NonNullable<AccountKeysDTO['credentials']>[string] {
  const data = credentialPublicData(credential);
  const { threshold, ...details } = data;
  return {
    ...details,
    threshold: Number(threshold),
  };
}

export function displayValue(value: bigint, decimals: number, display: string): DisplayValueDTO {
  return { value: value.toString(), decimals, display };
}

function ccdBalanceToDto(raw: AccountInfo): CcdBalanceDTO {
  const total = raw.accountAmount.microCcdAmount;
  const available = raw.accountAvailableBalance.microCcdAmount;
  const scheduledLocked = raw.accountReleaseSchedule.total.microCcdAmount;
  const locked = total > available ? total - available : scheduledLocked;
  return {
    tokenId: 'CCD',
    decimals: 6,
    totalBalance: displayValue(total, 6, formatCcd(total)),
    availableBalance: displayValue(available, 6, formatCcd(available)),
    lockedBalance: displayValue(locked, 6, formatCcd(locked)),
    releases: raw.accountReleaseSchedule.schedule.map((release) => ({
      timestamp: release.timestamp.toISOString(),
      amount: displayValue(release.amount.microCcdAmount, 6, formatCcd(release.amount.microCcdAmount)),
      transactions: release.transactions,
    })),
  };
}

export function tokenHoldingBalanceToDto(token: TokenHoldingDTO): PltBalanceDTO {
  return {
    tokenId: token.tokenId,
    decimals: token.decimals,
    totalBalance: token['total balance'],
    availableBalance: token['available balance'],
    lockedBalance: token['locked balance'],
    locks: token.locks,
  };
}

export function tokenHoldingsToDto(raw: AccountInfo): TokenHoldingDTO[] {
  return (raw.accountTokens ?? []).map((accountToken) => {
    const tokenId = String(accountToken.id);
    const decimals = accountToken.state.balance.decimals;
    const balance = accountToken.state.balance.value;
    let available = balance;
    let locked = 0n;
    const locks: TokenLockDTO[] = [];

    if (accountToken.state.moduleState !== undefined) {
      const accountState = Cbor.decode(accountToken.state.moduleState, 'TokenModuleAccountState');
      if (accountState.available !== undefined) available = accountState.available.value;
      for (const entry of accountState.locks ?? []) {
        locked += entry.amount.value;
        locks.push({
          lock: entry.lock.toString(),
          amount: displayValue(entry.amount.value, decimals, formatTokenAmount(entry.amount.value, decimals)),
        });
      }
    }

    return {
      tokenId,
      decimals,
      'total balance': displayValue(balance, decimals, formatTokenAmount(balance, decimals)),
      'available balance': displayValue(available, decimals, formatTokenAmount(available, decimals)),
      'locked balance': displayValue(locked, decimals, formatTokenAmount(locked, decimals)),
      locks,
    };
  });
}

export function tokenBalancesToDto(raw: AccountInfo): TokenBalanceDTO[] {
  return tokenHoldingsToDto(raw).map((token) => ({ holder: raw.accountAddress.address, ...token }));
}

export function accountBalancesToDto(raw: AccountInfo): AccountBalancesDTO {
  const balances: AccountBalancesDTO['balances'] = { CCD: ccdBalanceToDto(raw) };
  for (const token of tokenHoldingsToDto(raw)) {
    balances[token.tokenId] = tokenHoldingBalanceToDto(token);
  }
  return { address: raw.accountAddress.address, balances };
}

export function accountStakeToDto(raw: AccountInfo): AccountStakeResourceDTO {
  if (raw.type === AccountInfoType.Baker && raw.accountBaker !== undefined) {
    const poolInfo = 'bakerPoolInfo' in raw.accountBaker ? raw.accountBaker.bakerPoolInfo : undefined;
    return {
      address: raw.accountAddress.address,
      poolStatus: 'Validator',
      stakedAmount: ccdDisplayValue(raw.accountBaker.stakedAmount.microCcdAmount),
      pendingChange: pendingChangeToResourceDto(raw.accountBaker.pendingChange),
      validator: {
        validatorId: raw.accountBaker.bakerId.toString(),
        restakeEarnings: raw.accountBaker.restakeEarnings,
        isSuspended: raw.accountBaker.isSuspended,
        ...(poolInfo !== undefined && {
          pool: {
            openStatus: poolInfo.openStatus === null ? null : String(poolInfo.openStatus),
            metadataUrl: poolInfo.metadataUrl,
            commissionRates: poolInfo.commissionRates,
          },
        }),
      },
    };
  }
  if (raw.type === AccountInfoType.Delegator && raw.accountDelegation !== undefined) {
    const target = raw.accountDelegation.delegationTarget;
    return {
      address: raw.accountAddress.address,
      poolStatus: 'Delegator',
      stakedAmount: ccdDisplayValue(raw.accountDelegation.stakedAmount.microCcdAmount),
      pendingChange: pendingChangeToResourceDto(raw.accountDelegation.pendingChange),
      delegation: {
        restakeEarnings: raw.accountDelegation.restakeEarnings,
        target:
          target.delegateType === DelegationTargetType.Baker
            ? { type: 'Validator', validatorId: target.bakerId.toString() }
            : { type: 'PassiveDelegation' },
      },
    };
  }
  return {
    address: raw.accountAddress.address,
    poolStatus: 'None',
    stakedAmount: ccdDisplayValue(0n),
    pendingChange: { change: 'NoChange' },
  };
}

export function accountInfoToDto(
  raw: AccountInfo,
  tokens: TokenHoldingDTO[] = tokenHoldingsToDto(raw),
): AccountInfoDTO {
  const credentialDetails = Object.fromEntries(
    Object.entries(raw.accountCredentials).map(([index, credential]) => [index, credentialDetailsOf(credential)]),
  );
  const keys: AccountKeysDTO = {
    threshold: raw.accountThreshold,
    credentialCount: Object.keys(raw.accountCredentials).length,
    credentialIds: Object.values(raw.accountCredentials).map(credentialIdOf),
    ...(Object.keys(credentialDetails).length > 0 ? { credentials: credentialDetails } : {}),
  };
  const base: AccountInfoDTO = {
    address: raw.accountAddress.address,
    'CCD Balance': displayValue(raw.accountAmount.microCcdAmount, 6, formatCcd(raw.accountAmount.microCcdAmount)),
    sequenceNumber: raw.accountNonce.toString(),
    index: raw.accountIndex.toString(),
    accountType: accountTypeToDto(raw.type),
    keys,
    PLTs: tokens,
  };
  if (raw.type === AccountInfoType.Baker && raw.accountBaker !== undefined) {
    return { ...base, stake: stakeToDto(raw.accountBaker) };
  }
  if (raw.type === AccountInfoType.Delegator && raw.accountDelegation !== undefined) {
    return { ...base, stake: stakeToDto(raw.accountDelegation) };
  }
  return base;
}

export function nextAccountSequenceNumberToDto(raw: NextAccountNonce): NextSequenceNumberDTO {
  return { sequenceNumber: raw.nonce.toString(), allFinal: raw.allFinal };
}

export function blockInfoToDto(raw: BlockInfo): BlockInfoDTO {
  return {
    hash: String(raw.blockHash),
    height: raw.blockHeight.toString(),
    slotTime: raw.blockSlotTime.toISOString(),
    era: raw.genesisIndex,
    transactionsCount: raw.transactionCount.toString(),
    finalized: raw.finalized,
  };
}

export function consensusInfoToDto(raw: ConsensusStatus): ConsensusInfoDTO {
  const epoch =
    raw.version === 1 && raw.concordiumBFTStatus !== undefined
      ? raw.concordiumBFTStatus.currentEpoch.toString()
      : undefined;
  return {
    bestBlockHash: String(raw.bestBlock),
    lastFinalizedBlockHash: String(raw.lastFinalizedBlock),
    lastFinalizedBlockHeight: raw.lastFinalizedBlockHeight.toString(),
    genesisTime: raw.genesisTime.toISOString(),
    currentEraGenesisTime: raw.currentEraGenesisTime.toISOString(),
    ...(epoch !== undefined && { epoch }),
    currentEra: raw.genesisIndex,
  };
}

export function instanceInfoToDto(raw: InstanceInfo, address: ContractIdentifier): InstanceInfoDTO {
  return {
    index: address.index.toString(),
    subindex: address.subindex.toString(),
    moduleRef: String(raw.sourceModule),
    owner: raw.owner.address,
    amount: raw.amount.microCcdAmount.toString(),
    name: String(raw.name),
    methods: raw.methods.map((method) => String(method)),
  };
}

/** Renders SDK reject reasons as compact JSON without failing on bigint fields. */
export function renderRejectReason(reason: unknown): string | undefined {
  return reason === undefined || reason === null ? undefined : JSON.stringify(rejectReasonToJson(reason));
}

function rejectReasonToJson(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value !== 'object') return value;
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return Buffer.from(value).toString('hex');
  if (Array.isArray(value)) return value.map(rejectReasonToJson);
  if (value instanceof Date) return value.toISOString();

  const record = value as Record<string, unknown>;
  if (record.__type === 'ccd_parameter' && record.buffer instanceof Uint8Array) {
    return Buffer.from(record.buffer).toString('hex');
  }
  if (record.__type === 'ccd_receive_name' && typeof record.value === 'string') {
    const separator = record.value.indexOf('.');
    return separator < 0
      ? record.value
      : { contractName: record.value.slice(0, separator), receiveName: record.value.slice(separator + 1) };
  }

  const result: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(record)) {
    if (key === '__type') continue;
    result[key] = rejectReasonToJson(nested);
  }
  return result;
}

export function simulateContractResultToDto(raw: InvokeContractResult): InvokeResultDTO {
  if (raw.tag === 'failure') {
    const reason = renderRejectReason(raw.reason);
    const errorHex = raw.returnValue === undefined ? undefined : ReturnValue.toHexString(raw.returnValue);
    return {
      tag: 'failure',
      usedEnergy: raw.usedEnergy.toString(),
      ...(errorHex !== undefined && { errorHex }),
      ...(reason !== undefined && { reason }),
      eventCount: 0,
    };
  }
  const returnValueHex = raw.returnValue === undefined ? undefined : ReturnValue.toHexString(raw.returnValue);
  return {
    tag: 'success',
    usedEnergy: raw.usedEnergy.toString(),
    ...(returnValueHex !== undefined && { returnValueHex }),
    eventCount: raw.events?.length ?? 0,
  };
}

function normalizeLockMetadata(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return Buffer.from(value).toString('hex');
  if (Array.isArray(value)) return value.map(normalizeLockMetadata);
  if (value !== null && typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value);
    if (prototype === Object.prototype || prototype === null) {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([key, nested]) => [key, normalizeLockMetadata(nested)]),
      );
    }
  }
  return value;
}

function lockMetadataToDto(metadata: Uint8Array): NonNullable<LockInfoDTO['metadata']> {
  const result: NonNullable<LockInfoDTO['metadata']> = { hex: Buffer.from(metadata).toString('hex') };
  try {
    const decoded = mcpJsonObjectSchema.safeParse(normalizeLockMetadata(LockMetadata.decode(metadata)));
    return decoded.success ? { ...result, cbor: decoded.data } : result;
  } catch {
    return result;
  }
}

/** Converts decoded SDK lock information to the flattened public JSON DTO, preserving optional configuration fields. */
export function lockInfoToDto(lock: LockInfo): LockInfoDTO {
  const simpleV0 = lock.config.simpleV0;
  const grants: LockGrantDTO[] = simpleV0.grants.map((grant) => ({
    account: CborAccountAddress.toBase58(grant.account),
    capabilities: grant.roles,
  }));
  const funds: LockFundDTO[] = lock.funds.map((fund) => ({
    account: CborAccountAddress.toBase58(fund.account),
    balances: fund.amounts.map((amount): LockFundAmountDTO => ({
      tokenId: amount.token.toString(),
      decimals: amount.amount.decimals,
      amount: {
        value: amount.amount.value.toString(),
        decimals: amount.amount.decimals,
        display: formatTokenAmount(amount.amount.value, amount.amount.decimals),
      },
    })),
  }));

  const expiryUnixSeconds = simpleV0.expiry.expiry.expiryEpochSeconds.toString();
  return {
    lockId: lock.lock.toString(),
    creatorAccountIndex: lock.lock.accountIndex.toString(),
    creatorSequenceNumber: lock.lock.sequenceNumber.toString(),
    creationOrder: lock.lock.creationOrder.toString(),
    recipients: simpleV0.recipients === 'any' ? 'any' : simpleV0.recipients.map(CborAccountAddress.toBase58),
    expiryUnixSeconds,
    expiryTime: TransactionExpiry.toDate(simpleV0.expiry.expiry).toISOString(),
    grants,
    tokenIds: simpleV0.tokens.map((token) => token.toString()),
    ...(simpleV0.keepAlive !== undefined && {
      keepAlive: simpleV0.keepAlive,
    }),
    ...(simpleV0.memo !== undefined && {
      memoHex: CborMemo.instanceOf(simpleV0.memo)
        ? simpleV0.memo.toJSON()
        : Buffer.from(simpleV0.memo).toString('hex'),
    }),
    ...(simpleV0.metadata !== undefined && { metadata: lockMetadataToDto(simpleV0.metadata) }),
    funds,
  };
}
