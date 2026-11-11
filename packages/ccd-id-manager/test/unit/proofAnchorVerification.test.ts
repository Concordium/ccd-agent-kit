import {
AccountAddress,BlockHash,RpcError,TransactionKindString,TransactionStatusEnum,
TransactionSummaryType,VerificationRequestV1,
} from '@concordium/web-sdk';
import { describe,expect,it,vi } from 'vitest';

import { verifyFinalizedProofRequestAnchor } from '../../src/core/workflowInfrastructure.js';

const GENESIS = '12'.repeat(32);

function request() {
  return VerificationRequestV1.fromJSON({
    type: 'ConcordiumVerificationRequestV1',
    context: { type: 'ConcordiumUnfilledContextInformationV1', given: [], requested: [] },
    subjectClaims: [], transactionRef: 'ab'.repeat(32),
  });
}

function client(status: unknown) {
  return {
    getConsensusStatus: vi.fn(async () => ({ genesisBlock: BlockHash.fromHexString(GENESIS) })),
    getBlockItemStatus: vi.fn(async () => status),
  };
}

describe('proof anchor verification', () => {
  it.each([TransactionStatusEnum.Received, TransactionStatusEnum.Committed])(
    'returns invalid for a non-finalized %s anchor', async status => {
      const node = client({ status, ...(status === TransactionStatusEnum.Committed ? { outcomes: [] } : {}) });
      await expect(verifyFinalizedProofRequestAnchor({ request: request(), expectedGenesisHash: GENESIS,
        client: node as never })).resolves.toMatchObject({ status: 'invalid' });
    },
  );

  it.each([null, {}])('returns invalid for a finalized transaction with mismatched transaction type', async summary => {
    const node = client({ status: TransactionStatusEnum.Finalized,
      outcome: { blockHash: BlockHash.fromHexString('cd'.repeat(32)), summary } });
    await expect(verifyFinalizedProofRequestAnchor({ request: request(), expectedGenesisHash: GENESIS,
      client: node as never })).resolves.toMatchObject({ status: 'invalid' });
  });

  it.each([true, false])('validates a matching finalized register-data anchor (sender: %s)', async withSender => {
    const input = request();
    const sender = AccountAddress.fromBuffer(new Uint8Array(32).fill(1).buffer);
    const summary = {
      type: TransactionSummaryType.AccountTransaction,
      transactionType: TransactionKindString.RegisterData,
      dataRegistered: { data: Buffer.from(VerificationRequestV1.createAnchor(
        input.context, input.subjectClaims,
      )).toString('hex') },
      ...(withSender ? { sender } : {}),
    };
    const node = client({ status: TransactionStatusEnum.Finalized,
      outcome: { blockHash: BlockHash.fromHexString('cd'.repeat(32)), summary } });
    const result = verifyFinalizedProofRequestAnchor({ request: input, expectedGenesisHash: GENESIS, client: node as never });
    if (withSender) await expect(result).resolves.toEqual({
      status: 'valid', transactionHash: 'ab'.repeat(32), blockHash: 'cd'.repeat(32), account: sender.toString(),
    });
    else await expect(result).resolves.toMatchObject({ status: 'invalid' });
  });

  it('returns invalid when the transaction lookup definitively reports RPC NOT_FOUND', async () => {
    const node = client(Promise.reject(new RpcError('missing transaction detail', 'NOT_FOUND')));
    await expect(verifyFinalizedProofRequestAnchor({ request: request(), expectedGenesisHash: GENESIS,
      client: node as never })).resolves.toMatchObject({ status: 'invalid' });
  });

  it('does not trust an arbitrary transaction error object claiming NOT_FOUND', async () => {
    const claimed = Object.assign(new Error('untrusted error'), { code: 'NOT_FOUND' });
    const node = client(Promise.reject(claimed));
    await expect(verifyFinalizedProofRequestAnchor({ request: request(), expectedGenesisHash: GENESIS,
      client: node as never })).rejects.toBe(claimed);
  });

  it.each([
    ['transport failure', () => client(Promise.reject(new Error('timeout /private/path')))],
    ['genesis mismatch', () => ({
      getConsensusStatus: vi.fn(async () => ({ genesisBlock: BlockHash.fromHexString('34'.repeat(32)) })),
      getBlockItemStatus: vi.fn(),
    })],
    ['unexpected SDK failure', () => client({ status: TransactionStatusEnum.Finalized,
      outcome: Object.defineProperty({}, 'summary', { get() { throw new Error('unexpected internal failure'); } }) })],
    ['unexpected anchor-named SDK failure', () => client({ status: TransactionStatusEnum.Finalized,
      outcome: Object.defineProperty({}, 'summary', { get() { throw new Error('anchor decoder crashed'); } }) })],
  ] as const)('raises %s instead of reporting an invalid anchor', async (_label, makeClient) => {
    const node = makeClient();
    await expect(verifyFinalizedProofRequestAnchor({ request: request(), expectedGenesisHash: GENESIS,
      client: node as never })).rejects.toBeInstanceOf(Error);
  });

  it('preserves a non-Error SDK failure value', async () => {
    const node = client({ status: TransactionStatusEnum.Finalized,
      outcome: Object.defineProperty({}, 'summary', { get() { throw 'sdk failure'; } }) });
    await expect(verifyFinalizedProofRequestAnchor({ request: request(), expectedGenesisHash: GENESIS,
      client: node as never })).rejects.toBe('sdk failure');
  });
});
