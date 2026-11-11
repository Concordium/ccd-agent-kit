import { describe, expect, it } from 'vitest';
import {
  AccountTransactionType,
  CborAccountAddress,
  CborMemo,
  TokenAmount,
  TokenId,
  TokenOperationType,
  createTokenUpdatePayload,
  serializeAccountTransactionPayload,
} from '@concordium/web-sdk';
import { buildPlt } from '../../../../../src/mcp/transactions/internal/builders.js';
import { SENDER, TO, makePltContext } from '../../../../mcp/transactions/internal/builders.fixtures.js';

describe('buildPlt on protocol 10', () => {
  it('compiles a same-token mixed PLT batch into one tokenUpdate', async () => {
    const ctx = makePltContext({ protocolVersion: 10, governanceAccount: SENDER });
    const result = await buildPlt(ctx, {
      sender: SENDER,
      operations: [
        {
          type: 'transfer',
          tokenId: 'IMT',
          toAddress: TO,
          amountUnits: '1000000',
          memoText: 'invoice 42',
        },
        { type: 'mint', tokenId: 'IMT', amountUnits: '2000000' },
      ],
    });
    const expectedPayload = createTokenUpdatePayload({
      tokenId: TokenId.fromString('IMT'),
      operations: [
        {
          [TokenOperationType.Transfer]: {
            amount: TokenAmount.create(1000000n, 6),
            recipient: CborAccountAddress.fromBase58(TO),
            memo: CborMemo.fromString('invoice 42'),
          },
        },
        { [TokenOperationType.Mint]: { amount: TokenAmount.create(2000000n, 6) } },
      ],
    });
    expect(result.transactionHex).toContain(
      serializeAccountTransactionPayload({
        type: AccountTransactionType.TokenUpdate,
        payload: expectedPayload,
      }).toString('hex'),
    );
    expect(result.transactionType).toBe('tokenUpdate');
    expect(result.payload).toEqual({
      operations: [
        {
          type: 'transfer',
          tokenId: 'IMT',
          toAddress: TO,
          amount: { value: '1000000', decimals: 6, display: '1.000000' },
          memoText: 'invoice 42',
        },
        {
          type: 'mint',
          tokenId: 'IMT',
          amount: { value: '2000000', decimals: 6, display: '2.000000' },
        },
      ],
    });
    expect(ctx.clients.getClient().client).toMatchObject({ calls: { getTokenInfo: 1 } });
  });
});
