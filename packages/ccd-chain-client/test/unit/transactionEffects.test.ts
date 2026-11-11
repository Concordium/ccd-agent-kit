import {
  AccountAddress,
  CcdAmount,
  Cbor,
  CborMemo,
  Energy,
  LockId,
  TokenAmount,
  TokenHolder,
  TokenId,
  TransactionEventTag,
  TransactionHash,
  TransactionKindString,
  TransactionSummaryType,
  UpdateType,
  type BlockItemSummary,
} from '@concordium/web-sdk';
import { describe, expect, it } from 'vitest';
import { blockItemSummaryToEventDto } from '../../src/concordium/transactionEffects.js';

describe('blockItemSummaryToEventDto', () => {
  const sender = '4StnMEQCKtfDRuHJfsY6eZL9KJWqdYoqRVRoDSSAz35LsmHcmg';
  const recipient = '4QkqdUnrjShrUrHpE96odLM6J77nWzEryifzqNnwNk4FYNge8a';
  const sponsor = '4soVbMFX1vu7evzS4mhLTh1qscPiCgJFztNnHTTKF3yydvKMEm';

  it('maps a typed SDK transfer, memo, and sponsor to the concrete JSON DTO', () => {
    const summary = {
      type: TransactionSummaryType.AccountTransaction,
      index: 3n,
      energyCost: Energy.create(500n),
      hash: TransactionHash.fromHexString('de'.repeat(32)),
      cost: 1000n,
      sender: AccountAddress.fromBase58(sender),
      sponsor: {
        sponsor: AccountAddress.fromBase58(sponsor),
        cost: CcdAmount.fromMicroCcd(17n),
      },
      transactionType: TransactionKindString.TransferWithMemo,
      transfer: {
        tag: TransactionEventTag.Transferred,
        to: AccountAddress.fromBase58(recipient),
        amount: CcdAmount.fromMicroCcd(12345n),
      },
      memo: { tag: TransactionEventTag.TransferMemo, memo: '6568656c6c6f' },
    } satisfies BlockItemSummary;

    expect(blockItemSummaryToEventDto(summary)).toEqual({
      type: 'accountTransaction',
      summary: {
        transactionType: 'transferWithMemo',
        sender,
        sponsor: { address: sponsor, cost: '17' },
        cost: '1000',
        energyCost: '500',
        hash: 'de'.repeat(32),
        ccdTransfer: {
          from: { type: 'account', address: sender },
          to: { type: 'account', address: recipient },
          amount: { microCcdAmount: '12345', display: '0.012345 CCD' },
          memo: { hex: '6568656c6c6f', text: 'hello' },
        },
        index: '3',
      },
    });
  });

  it.each([
    ['empty', ''],
    ['opaque', 'ff'],
  ])('preserves %s memo hex without inventing text', (_case, memo) => {
    const summary = {
      type: TransactionSummaryType.AccountTransaction,
      index: 3n,
      energyCost: Energy.create(5n),
      hash: TransactionHash.fromHexString('fa'.repeat(32)),
      cost: 10n,
      sender: AccountAddress.fromBase58(sender),
      transactionType: TransactionKindString.TransferWithMemo,
      transfer: {
        tag: TransactionEventTag.Transferred,
        to: AccountAddress.fromBase58(recipient),
        amount: CcdAmount.fromMicroCcd(1n),
      },
      memo: { tag: TransactionEventTag.TransferMemo, memo },
    } satisfies BlockItemSummary;

    expect(blockItemSummaryToEventDto(summary)).toMatchObject({
      summary: { ccdTransfer: { memo: { hex: memo } } },
    });
    expect(blockItemSummaryToEventDto(summary)).not.toMatchObject({
      summary: { ccdTransfer: { memo: { text: expect.any(String) } } },
    });
  });

  it('preserves schedule and memo fields for a non-projected transfer variant', () => {
    const timestamp = new Date('2026-10-24T12:00:00.000Z');
    const summary = {
      type: TransactionSummaryType.AccountTransaction,
      index: 6n,
      energyCost: Energy.create(9n),
      hash: TransactionHash.fromHexString('bc'.repeat(32)),
      cost: 11n,
      sender: AccountAddress.fromBase58(sender),
      transactionType: TransactionKindString.TransferWithScheduleAndMemo,
      transfer: {
        tag: TransactionEventTag.TransferredWithSchedule,
        to: AccountAddress.fromBase58(recipient),
        amount: [{ timestamp, amount: CcdAmount.fromMicroCcd(42n) }],
      },
      memo: { tag: TransactionEventTag.TransferMemo, memo: 'ff' },
    } satisfies BlockItemSummary;

    expect(blockItemSummaryToEventDto(summary)).toMatchObject({
      summary: {
        transfer: {
          tag: 'TransferredWithSchedule',
          to: { address: recipient },
          amount: [{ timestamp: timestamp.toISOString(), amount: { microCcdAmount: '42' } }],
        },
        memo: { tag: 'TransferMemo', memo: 'ff' },
      },
    });
  });

  it('maps typed token transfers, lock amounts, nullable holders, and unknown events', () => {
    const lockId = LockId.create(0n, 0n, 0n);
    const summary = {
      type: TransactionSummaryType.AccountTransaction,
      index: 4n,
      energyCost: Energy.create(8n),
      hash: TransactionHash.fromHexString('ab'.repeat(32)),
      cost: 10n,
      sender: AccountAddress.fromBase58(sender),
      transactionType: TransactionKindString.TokenUpdate,
      events: [
        {
          tag: TransactionEventTag.TokenTransfer,
          tokenId: TokenId.fromString('IMT'),
          from: TokenHolder.fromAccountAddress(AccountAddress.fromBase58(sender)),
          to: TokenHolder.fromBase58(recipient),
          amount: TokenAmount.create(12345n, 3),
          memo: CborMemo.fromString('token memo'),
        },
        {
          tag: TransactionEventTag.LockAmount,
          tokenId: TokenId.fromString('IMT'),
          lockId,
          tokenHolder: TokenHolder.fromBase58(sender),
          amount: TokenAmount.create(500n, 3),
        },
        {
          tag: TransactionEventTag.UnlockAmount,
          tokenId: TokenId.fromString('IMT'),
          lockId,
          tokenHolder: null,
          amount: TokenAmount.create(250n, 3),
        },
        null,
        {
          tag: TransactionEventTag.TokenTransfer,
          tokenId: TokenId.fromString('IMT'),
          from: null,
          to: null,
          amount: TokenAmount.create(1n, 3),
        },
        {
          tag: TransactionEventTag.TokenMint,
          tokenId: TokenId.fromString('IMT'),
          target: TokenHolder.fromBase58(recipient),
          amount: TokenAmount.create(2n, 3),
        },
      ],
    } satisfies BlockItemSummary;

    expect(blockItemSummaryToEventDto(summary)).toEqual({
      type: 'accountTransaction',
      summary: {
        transactionType: 'tokenUpdate',
        sender,
        cost: '10',
        energyCost: '8',
        hash: 'ab'.repeat(32),
        tokenEvents: [
          {
            type: 'tokenTransfer',
            tokenId: 'IMT',
            from: sender,
            to: recipient,
            amount: { value: '12345', decimals: 3, display: '12.345' },
            memo: { hex: CborMemo.fromString('token memo').toString(), text: 'token memo' },
          },
          {
            type: 'lockAmount',
            tokenId: 'IMT',
            lockId: lockId.toString(),
            tokenHolder: sender,
            amount: { value: '500', decimals: 3, display: '0.500' },
          },
          {
            type: 'unlockAmount',
            tokenId: 'IMT',
            lockId: lockId.toString(),
            amount: { value: '250', decimals: 3, display: '0.250' },
          },
          null,
          {
            type: 'tokenTransfer',
            tokenId: 'IMT',
            amount: { value: '1', decimals: 3, display: '0.001' },
          },
          {
            tag: 'TokenMint',
            tokenId: { value: 'IMT' },
            target: { type: 'account', address: { address: recipient } },
            amount: { value: '2', decimals: 3 },
          },
        ],
        index: '4',
      },
    });
  });

  it('maps lock destruction and token transfer through the unified token-update event projection', () => {
    const lockId = LockId.create(7n, 8n, 9n);
    const summary = {
      type: TransactionSummaryType.AccountTransaction,
      index: 5n,
      energyCost: Energy.create(11n),
      hash: TransactionHash.fromHexString('cd'.repeat(32)),
      cost: 12n,
      sender: AccountAddress.fromBase58(sender),
      transactionType: TransactionKindString.TokenUpdate,
      events: [
        { tag: TransactionEventTag.LockCreated, lockId, lockConfig: Cbor.encode({ simpleV0: {} }) },
        { tag: TransactionEventTag.LockDestroyed, lockId },
        {
          tag: TransactionEventTag.TokenTransfer,
          tokenId: TokenId.fromString('IMT'),
          from: TokenHolder.fromBase58(sender),
          to: TokenHolder.fromBase58(recipient),
          amount: TokenAmount.create(123n, 2),
          memo: CborMemo.fromString('meta memo'),
        },
        null,
      ],
    } satisfies BlockItemSummary;

    const dto = blockItemSummaryToEventDto(summary);
    expect(dto).toEqual({
      type: 'accountTransaction',
      summary: {
        transactionType: 'tokenUpdate',
        sender,
        cost: '12',
        energyCost: '11',
        hash: 'cd'.repeat(32),
        index: '5',
        tokenEvents: [
          {
            type: 'lockCreated',
            lockId: lockId.toString(),
            lockConfig: Buffer.from(Cbor.encode({ simpleV0: {} }).bytes).toString('hex'),
          },
          { type: 'lockDestroyed', lockId: lockId.toString() },
          {
            type: 'tokenTransfer',
            tokenId: 'IMT',
            from: sender,
            to: recipient,
            amount: { value: '123', decimals: 2, display: '1.23' },
            memo: { hex: CborMemo.fromString('meta memo').toString(), text: 'meta memo' },
          },
          null,
        ],
      },
    });
    expect(() => JSON.stringify(dto)).not.toThrow();
  });

  it('preserves a typed failed summary with an unknown reject reason', () => {
    const summary = {
      type: TransactionSummaryType.AccountTransaction,
      index: 7n,
      energyCost: Energy.create(13n),
      hash: TransactionHash.fromHexString('ad'.repeat(32)),
      cost: 14n,
      sender: AccountAddress.fromBase58(sender),
      transactionType: TransactionKindString.Failed,
      failedTransactionType: TransactionKindString.Update,
      rejectReason: null,
    } satisfies BlockItemSummary;

    expect(blockItemSummaryToEventDto(summary)).toEqual({
      type: 'accountTransaction',
      summary: {
        transactionType: 'failed',
        failedTransactionType: 'update',
        rejectReason: null,
        sender,
        cost: '14',
        energyCost: '13',
        hash: 'ad'.repeat(32),
        index: '7',
      },
    });
  });

  it('terminally serializes a typed update summary without invoking SDK wrapper JSON methods', () => {
    const summary = {
      type: TransactionSummaryType.UpdateTransaction,
      index: 8n,
      energyCost: Energy.create(15n),
      hash: TransactionHash.fromHexString('be'.repeat(32)),
      effectiveTime: 123n,
      payload: {
        updateType: UpdateType.Protocol,
        update: {
          message: 'upgrade',
          specificationUrl: 'https://example.com/spec',
          specificationHash: 'ca'.repeat(32),
          specificationAuxiliaryData: '00ff',
        },
      },
    } satisfies BlockItemSummary;

    expect(blockItemSummaryToEventDto(summary)).toEqual({
      type: 'updateTransaction',
      summary: {
        type: 'updateTransaction',
        index: '8',
        energyCost: { value: '15' },
        hash: { buffer: 'be'.repeat(32) },
        effectiveTime: '123',
        payload: {
          updateType: 'protocol',
          update: {
            message: 'upgrade',
            specificationUrl: 'https://example.com/spec',
            specificationHash: 'ca'.repeat(32),
            specificationAuxiliaryData: '00ff',
          },
        },
      },
    });
  });

  it('maps a typed account-creation summary to JSON data', () => {
    const summary = {
      type: TransactionSummaryType.AccountCreation,
      index: 0n,
      energyCost: Energy.create(0n),
      hash: TransactionHash.fromHexString('ef'.repeat(32)),
      credentialType: 'normal',
      address: AccountAddress.fromBase58(recipient),
      regId: 'reg123',
    } satisfies BlockItemSummary;

    expect(blockItemSummaryToEventDto(summary)).toEqual({
      type: 'accountCreation',
      summary: {
        type: 'accountCreation',
        index: '0',
        energyCost: { value: '0' },
        hash: { buffer: 'ef'.repeat(32) },
        credentialType: 'normal',
        address: { address: recipient },
        regId: 'reg123',
      },
    });
  });
});
