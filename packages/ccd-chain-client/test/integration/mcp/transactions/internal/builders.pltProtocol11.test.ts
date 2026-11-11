import { describe, expect, it } from 'vitest';
import {
  AccountTransactionType,
  CborAccountAddress,
  CborEpoch,
  LockConfig,
  LockId,
  LockMetadata as SDKLockMetadata,
  OperationType,
  TokenAmount,
  TokenId,
  TokenOperationType,
  createTokenOperationWithId,
  createTokenUpdatePayload,
  serializeAccountTransactionPayload,
} from '@concordium/web-sdk';
import { buildPlt } from '../../../../../src/mcp/transactions/internal/builders.js';
import { installAccountLabelsFixture } from '../../../../helpers/accountLabels.js';
import { FakeConcordiumClient } from '../../../../helpers/fakes.js';
import { SENDER, TO, makePltContext } from '../../../../mcp/transactions/internal/builders.fixtures.js';

describe('buildPlt on protocol 11+', () => {
  it('builds a sponsored transfer as an unscoped tokenUpdate', async () => {
    const ctx = makePltContext({ protocolVersion: 11 });
    const result = await buildPlt(ctx, {
      sender: SENDER,
      sponsor: TO,
      operations: [{ type: 'transfer', tokenId: 'IMT', toAddress: TO, amountUnits: '925000000' }],
    });
    const expectedPayload = createTokenUpdatePayload({
      operations: createTokenOperationWithId(TokenId.fromString('IMT'), {
        [TokenOperationType.Transfer]: {
          amount: TokenAmount.create(925000000n, 6),
          recipient: CborAccountAddress.fromBase58(TO),
        },
      }),
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
          amount: { value: '925000000', decimals: 6, display: '925.000000' },
        },
      ],
    });
    expect(result.metadata).toMatchObject({
      sponsor: TO,
      sponsorNumSignatures: '2',
      totalSignatureCount: '3',
    });
    const client = ctx.clients.getClient().client as FakeConcordiumClient;
    expect(client).toMatchObject({ calls: { getTokenInfo: 1 } });
    expect(client.calls.getAccountInfo).toBeUndefined();
  });

  it('resolves account labels inside mixed PLT operations while keeping canonical payload addresses', async () => {
    const restore = installAccountLabelsFixture('9dd9ca4d19e9393877d2c44b70f89acb', {
      senderLabel: SENDER,
      recipientLabel: TO,
    });
    try {
      const metadataJson = {
        name: 'Escrow',
        description: 'Release after delivery',
        reference: 42,
      };
      const result = await buildPlt(makePltContext({ protocolVersion: 11 }), {
        sender: 'senderLabel',
        operations: [
          {
            type: 'lock_create',
            ref: 'send-lock',
            recipients: ['recipientLabel'],
            lockExpiryUnixSeconds: '1787073000',
            grants: [{ account: 'senderLabel', capabilities: ['fund', 'send'] }],
            tokenIds: ['IMT'],
            metadataJson,
          },
          {
            type: 'lock_send',
            lockRef: 'send-lock',
            tokenId: 'IMT',
            sourceAddress: 'senderLabel',
            toAddress: 'recipientLabel',
            amountUnits: '500000',
          },
        ],
      });
      const lockId = LockId.create(57n, 5n, 0n);
      const expectedPayload = createTokenUpdatePayload({
        operations: [
          {
            [OperationType.LockCreate]: LockConfig.simpleV0(
              [CborAccountAddress.fromBase58(TO)],
              CborEpoch.fromEpochSeconds(1787073000),
              [
                {
                  account: CborAccountAddress.fromBase58(SENDER),
                  roles: [LockConfig.SimpleV0Capability.Fund, LockConfig.SimpleV0Capability.Send],
                },
              ],
              [TokenId.fromString('IMT')],
              undefined,
              undefined,
              SDKLockMetadata.encode(metadataJson),
            ),
          },
          {
            [OperationType.LockSend]: {
              token: TokenId.fromString('IMT'),
              lock: lockId,
              source: CborAccountAddress.fromBase58(SENDER),
              amount: TokenAmount.create(500000n, 6),
              recipient: CborAccountAddress.fromBase58(TO),
            },
          },
        ],
      });
      expect(result.transactionHex).toContain(
        serializeAccountTransactionPayload({
          type: AccountTransactionType.TokenUpdate,
          payload: expectedPayload,
        }).toString('hex'),
      );
      expect(result.payload).toMatchObject({
        operations: [
          {
            type: 'lock_create',
            recipients: [TO],
            grants: [{ account: SENDER, capabilities: ['fund', 'send'] }],
            metadataJson,
          },
          {
            type: 'lock_send',
            sourceAddress: SENDER,
            toAddress: TO,
            amount: { display: '0.500000' },
          },
        ],
      });
      expect(result.metadata.sender).toBe(SENDER);
    } finally {
      restore();
    }
  });
});
