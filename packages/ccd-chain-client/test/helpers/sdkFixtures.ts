import {
  AccountAddress,
  AccountInfoType,
  CcdAmount,
  CborAccountAddress,
  CborEpoch,
  ContractAddress,
  Energy,
  LockConfig,
  LockId,
  Parameter,
  ReceiveName,
  RejectReasonTag,
  ReturnValue,
  SequenceNumber,
  TokenAmount,
  TokenId,
  type AccountInfo,
  type AccountInfoSimple,
  type InvokeContractResult,
  type LockInfo,
} from '@concordium/web-sdk';
import { accountCredential } from './accountCredentials.js';

type SimpleAccountInfoOverrides = Partial<
  Pick<
    AccountInfoSimple,
    | 'accountNonce'
    | 'accountAmount'
    | 'accountIndex'
    | 'accountEncryptionKey'
    | 'accountEncryptedAmount'
    | 'accountReleaseSchedule'
    | 'accountCooldowns'
    | 'accountAvailableBalance'
    | 'accountTokens'
  >
>;

export function sdkRejectedReceiveFailure(): InvokeContractResult {
  return {
    tag: 'failure',
    usedEnergy: Energy.create(100n),
    reason: {
      tag: RejectReasonTag.RejectedReceive,
      contractAddress: ContractAddress.create(7n, 0n),
      receiveName: ReceiveName.fromString('counter.set'),
      rejectReason: -2147483648,
      parameter: Parameter.fromHexString('0102'),
    },
    returnValue: ReturnValue.fromHexString('040506'),
  };
}

export function sdkSimpleAccountInfo(address: string, overrides: SimpleAccountInfoOverrides = {}): AccountInfoSimple {
  return {
    type: AccountInfoType.Simple,
    accountAddress: AccountAddress.fromBase58(address),
    accountNonce: SequenceNumber.create(8n),
    accountAmount: CcdAmount.fromMicroCcd(1234567n),
    accountIndex: 42n,
    accountThreshold: 1,
    accountEncryptionKey: '',
    accountEncryptedAmount: { selfAmount: '', startIndex: 0n, incomingAmounts: [] },
    accountReleaseSchedule: { total: CcdAmount.zero(), schedule: [] },
    accountCredentials: { 0: accountCredential('initial') },
    accountCooldowns: [],
    accountAvailableBalance: CcdAmount.fromMicroCcd(1234567n),
    accountTokens: [],
    ...overrides,
  } satisfies AccountInfo;
}

export function sdkLockInfo(address: string, memo: NonNullable<LockConfig.SimpleV0['memo']>): LockInfo {
  const account = CborAccountAddress.fromBase58(address);
  return {
    lock: LockId.create(42n, 5n, 9n),
    config: {
      simpleV0: {
        recipients: [account],
        expiry: CborEpoch.fromEpochSeconds(1_700_000_000n),
        grants: [
          { account, roles: [LockConfig.SimpleV0Capability.Fund, LockConfig.SimpleV0Capability.Send] },
          { account, roles: [LockConfig.SimpleV0Capability.Release, LockConfig.SimpleV0Capability.Cancel] },
        ],
        tokens: [TokenId.fromString('TOKEN'), TokenId.fromString('OTHER')],
        keepAlive: true,
        memo,
      },
    },
    funds: [
      {
        account,
        amounts: [
          { token: TokenId.fromString('TOKEN'), amount: TokenAmount.create(123456n, 3) },
          { token: TokenId.fromString('OTHER'), amount: TokenAmount.create(50n, 0) },
        ],
      },
    ],
  };
}
