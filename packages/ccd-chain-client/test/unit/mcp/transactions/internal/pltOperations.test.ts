import { describe, expect, it, vi } from 'vitest';
import {
  CborAccountAddress,
  CborEpoch,
  CborMemo,
  LockConfig,
  LockId,
  LockMetadata as SDKLockMetadata,
  OperationType,
  TokenAdminRole,
  TokenAmount,
  TokenId,
  TokenOperationType,
} from '@concordium/web-sdk';
import type { TokenInfoDTO } from '../../../../../src/concordium/dto.js';
import { PltLockContext } from '../../../../../src/mcp/transactions/internal/pltLockOperations.js';
import {
  PltTokenContext,
  buildTokenOperation,
} from '../../../../../src/mcp/transactions/internal/pltTokenOperations.js';
import { SENDER, TO } from '../../../../mcp/transactions/internal/builders.fixtures.js';

function tokenInfo(tokenId: string, decimals: number): TokenInfoDTO {
  return {
    tokenId,
    moduleRef: '00'.repeat(32),
    decimals,
    'total supply': { value: '0', decimals, display: '0' },
    name: undefined,
    metadataUrl: undefined,
    governanceAccount: SENDER,
    allowList: undefined,
    denyList: undefined,
    mintable: undefined,
    burnable: undefined,
    paused: undefined,
  };
}

describe('PLT operation builders', () => {
  it('shares token lookups and resolves each token amount with its own decimals', async () => {
    const getTokenInfo = vi.fn(async (tokenId: string) => tokenInfo(tokenId, tokenId === 'IMT' ? 6 : 3));
    const tokens = new PltTokenContext({ getTokenInfo });

    const transfer = await buildTokenOperation(tokens, {
      type: 'transfer',
      tokenId: 'IMT',
      toAddress: TO,
      amountUnits: '1250000',
      memoText: 'invoice',
    });
    const mint = await buildTokenOperation(tokens, { type: 'mint', tokenId: 'IMT', amountUnits: '2000000' });
    const burn = await buildTokenOperation(tokens, { type: 'burn', tokenId: 'tDKK', amountUnits: '2500' });

    expect(transfer.summary).toEqual({
      type: 'transfer',
      tokenId: 'IMT',
      toAddress: TO,
      amount: { value: '1250000', decimals: 6, display: '1.250000' },
      memoText: 'invoice',
    });
    expect(transfer.operation).toHaveProperty(TokenOperationType.Transfer);
    expect(mint.summary).toMatchObject({ amount: { display: '2.000000' } });
    expect(burn.summary).toMatchObject({ amount: { display: '2.500' } });
    expect(getTokenInfo).toHaveBeenCalledTimes(2);
  });

  it('maps access-list and availability operation families', async () => {
    const getTokenInfo = vi.fn(async (tokenId: string) => tokenInfo(tokenId, 6));
    const tokens = new PltTokenContext({ getTokenInfo });
    const operations = await Promise.all([
      buildTokenOperation(tokens, { type: 'add_allow_list', tokenId: 'IMT', target: TO }),
      buildTokenOperation(tokens, { type: 'remove_allow_list', tokenId: 'IMT', target: TO }),
      buildTokenOperation(tokens, { type: 'add_deny_list', tokenId: 'IMT', target: TO }),
      buildTokenOperation(tokens, { type: 'remove_deny_list', tokenId: 'IMT', target: TO }),
      buildTokenOperation(tokens, { type: 'pause', tokenId: 'IMT' }),
      buildTokenOperation(tokens, { type: 'unpause', tokenId: 'IMT' }),
    ]);
    const target = CborAccountAddress.fromBase58(TO);

    expect(operations.map((built) => built.operation)).toEqual([
      { [TokenOperationType.AddAllowList]: { target } },
      { [TokenOperationType.RemoveAllowList]: { target } },
      { [TokenOperationType.AddDenyList]: { target } },
      { [TokenOperationType.RemoveDenyList]: { target } },
      { [TokenOperationType.Pause]: {} },
      { [TokenOperationType.Unpause]: {} },
    ]);
    expect(operations.map((built) => built.summary)).toEqual([
      { type: 'add_allow_list', tokenId: 'IMT', target: TO },
      { type: 'remove_allow_list', tokenId: 'IMT', target: TO },
      { type: 'add_deny_list', tokenId: 'IMT', target: TO },
      { type: 'remove_deny_list', tokenId: 'IMT', target: TO },
      { type: 'pause', tokenId: 'IMT' },
      { type: 'unpause', tokenId: 'IMT' },
    ]);
    expect(getTokenInfo).not.toHaveBeenCalled();
  });

  it('maps metadata and both admin-role operation variants', async () => {
    const getTokenInfo = vi.fn(async (tokenId: string) => tokenInfo(tokenId, 6));
    const tokens = new PltTokenContext({ getTokenInfo });
    const metadataUrl = 'https://example.com/imt.json';
    const operations = await Promise.all([
      buildTokenOperation(tokens, { type: 'update_metadata', tokenId: 'IMT', metadataUrl }),
      buildTokenOperation(tokens, {
        type: 'assign_admin_roles',
        tokenId: 'IMT',
        account: TO,
        roles: ['mint', 'burn'],
      }),
      buildTokenOperation(tokens, {
        type: 'revoke_admin_roles',
        tokenId: 'IMT',
        account: TO,
        roles: ['pause', 'updateMetadata'],
      }),
    ]);

    expect(operations.map((built) => built.operation)).toEqual([
      { [TokenOperationType.UpdateMetadata]: { url: metadataUrl } },
      {
        [TokenOperationType.AssignAdminRoles]: {
          account: CborAccountAddress.fromBase58(TO),
          roles: [TokenAdminRole.Mint, TokenAdminRole.Burn],
        },
      },
      {
        [TokenOperationType.RevokeAdminRoles]: {
          account: CborAccountAddress.fromBase58(TO),
          roles: [TokenAdminRole.Pause, TokenAdminRole.UpdateMetadata],
        },
      },
    ]);
    expect(operations.map((built) => built.summary)).toEqual([
      { type: 'update_metadata', tokenId: 'IMT', metadataUrl },
      { type: 'assign_admin_roles', tokenId: 'IMT', account: TO, roles: ['mint', 'burn'] },
      { type: 'revoke_admin_roles', tokenId: 'IMT', account: TO, roles: ['pause', 'updateMetadata'] },
    ]);
    expect(getTokenInfo).not.toHaveBeenCalled();
  });

  it('builds every lock operation with direct and newly created lock references', async () => {
    const getAccountInfo = vi.fn(async () => ({ index: '57' }));
    const getTokenInfo = vi.fn(async (tokenId: string) => tokenInfo(tokenId, 6));
    const tokens = new PltTokenContext({ getTokenInfo });
    const locks = new PltLockContext({ getAccountInfo }, SENDER, '5', tokens);
    const directLockId = LockId.create(44n, 3n, 2n).toString();
    const firstCreatedLockId = LockId.create(57n, 5n, 0n).toString();
    const secondCreatedLockId = LockId.create(57n, 5n, 1n).toString();
    const metadataJson = {
      name: 'Escrow',
      description: 'Release after delivery',
      reference: 42,
      custom: { enabled: true, stages: ['funded', 'released'] },
    };

    const funded = await locks.buildOperation({
      type: 'lock_fund',
      lockId: directLockId,
      tokenId: 'IMT',
      amountUnits: '1000000',
      memoText: 'deposit',
    });
    expect(getAccountInfo).not.toHaveBeenCalled();

    const created = await locks.buildOperation({
      type: 'lock_create',
      ref: 'main',
      recipients: [TO],
      lockExpiryUnixSeconds: '1787073000',
      grants: [{ account: SENDER, capabilities: ['fund', 'send', 'cancel', 'release'] }],
      tokenIds: ['IMT'],
      keepAlive: false,
      controllerMemoText: 'escrow',
      metadataJson,
    });
    const secondCreated = await locks.buildOperation({
      type: 'lock_create',
      ref: 'secondary',
      recipients: 'any',
      lockExpiryUnixSeconds: '1787076000',
      grants: [],
      tokenIds: ['IMT'],
    });
    const sent = await locks.buildOperation({
      type: 'lock_send',
      lockRef: 'main',
      tokenId: 'IMT',
      sourceAddress: SENDER,
      toAddress: TO,
      amountUnits: '500000',
      memoJson: { purpose: 'payment' },
    });
    const cancelled = await locks.buildOperation({
      type: 'lock_cancel',
      lockId: directLockId,
      memoText: 'void',
    });
    const released = await locks.buildOperation({
      type: 'lock_release',
      lockRef: 'secondary',
      tokenId: 'IMT',
      sourceAddress: SENDER,
      amountUnits: '250000',
      memoJson: { reason: 'refund' },
    });

    expect([
      funded.operation,
      created.operation,
      secondCreated.operation,
      sent.operation,
      cancelled.operation,
      released.operation,
    ]).toEqual([
      {
        [OperationType.LockFund]: {
          token: TokenId.fromString('IMT'),
          lock: LockId.fromString(directLockId),
          amount: TokenAmount.create(1000000n, 6),
          memo: CborMemo.fromString('deposit'),
        },
      },
      {
        [OperationType.LockCreate]: LockConfig.simpleV0(
          [CborAccountAddress.fromBase58(TO)],
          CborEpoch.fromEpochSeconds(1787073000),
          [
            {
              account: CborAccountAddress.fromBase58(SENDER),
              roles: [
                LockConfig.SimpleV0Capability.Fund,
                LockConfig.SimpleV0Capability.Send,
                LockConfig.SimpleV0Capability.Cancel,
                LockConfig.SimpleV0Capability.Release,
              ],
            },
          ],
          [TokenId.fromString('IMT')],
          false,
          CborMemo.fromString('escrow'),
          SDKLockMetadata.encode(metadataJson),
        ),
      },
      {
        [OperationType.LockCreate]: LockConfig.simpleV0(
          'any',
          CborEpoch.fromEpochSeconds(1787076000),
          [],
          [TokenId.fromString('IMT')],
        ),
      },
      {
        [OperationType.LockSend]: {
          token: TokenId.fromString('IMT'),
          lock: LockId.fromString(firstCreatedLockId),
          source: CborAccountAddress.fromBase58(SENDER),
          amount: TokenAmount.create(500000n, 6),
          recipient: CborAccountAddress.fromBase58(TO),
          memo: CborMemo.fromAny({ purpose: 'payment' }),
        },
      },
      {
        [OperationType.LockCancel]: {
          lock: LockId.fromString(directLockId),
          memo: CborMemo.fromString('void'),
        },
      },
      {
        [OperationType.LockRelease]: {
          token: TokenId.fromString('IMT'),
          lock: LockId.fromString(secondCreatedLockId),
          source: CborAccountAddress.fromBase58(SENDER),
          amount: TokenAmount.create(250000n, 6),
          memo: CborMemo.fromAny({ reason: 'refund' }),
        },
      },
    ]);
    expect([
      funded.summary,
      created.summary,
      secondCreated.summary,
      sent.summary,
      cancelled.summary,
      released.summary,
    ]).toEqual([
      {
        type: 'lock_fund',
        lockId: directLockId,
        tokenId: 'IMT',
        amount: { value: '1000000', decimals: 6, display: '1.000000' },
        memoText: 'deposit',
      },
      {
        type: 'lock_create',
        ref: 'main',
        lockId: firstCreatedLockId,
        recipients: [TO],
        lockExpiryUnixSeconds: '1787073000',
        grants: [{ account: SENDER, capabilities: ['fund', 'send', 'cancel', 'release'] }],
        tokenIds: ['IMT'],
        keepAlive: false,
        controllerMemoText: 'escrow',
        metadataJson,
      },
      {
        type: 'lock_create',
        ref: 'secondary',
        lockId: secondCreatedLockId,
        recipients: 'any',
        lockExpiryUnixSeconds: '1787076000',
        grants: [],
        tokenIds: ['IMT'],
      },
      {
        type: 'lock_send',
        lockRef: 'main',
        lockId: firstCreatedLockId,
        tokenId: 'IMT',
        sourceAddress: SENDER,
        toAddress: TO,
        amount: { value: '500000', decimals: 6, display: '0.500000' },
        memoJson: { purpose: 'payment' },
      },
      { type: 'lock_cancel', lockId: directLockId, memoText: 'void' },
      {
        type: 'lock_release',
        lockRef: 'secondary',
        lockId: secondCreatedLockId,
        tokenId: 'IMT',
        sourceAddress: SENDER,
        amount: { value: '250000', decimals: 6, display: '0.250000' },
        memoJson: { reason: 'refund' },
      },
    ]);
    expect(getAccountInfo).toHaveBeenCalledOnce();
    expect(getAccountInfo).toHaveBeenCalledWith(SENDER);
    expect(getTokenInfo).toHaveBeenCalledOnce();
  });

  it('rejects a lock reference that was not created earlier in the build', async () => {
    const tokens = new PltTokenContext({ getTokenInfo: async (tokenId) => tokenInfo(tokenId, 6) });
    const locks = new PltLockContext({ getAccountInfo: async () => ({ index: '57' }) }, SENDER, '5', tokens);

    await expect(
      locks.buildOperation({
        type: 'lock_cancel',
        lockRef: 'later',
      }),
    ).rejects.toMatchObject({ kind: 'invalid-argument', message: "Unknown lockRef 'later'." });
  });
});
