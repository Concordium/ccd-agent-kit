import { BlockHash, ConcordiumGRPCClient, Duration, type ConsensusStatus } from '@concordium/web-sdk';
import { describe, expect, it, vi } from 'vitest';
import { resolveBlockHash } from '../../../src/concordium/blocks.js';

const bestBlock = BlockHash.fromHexString('ab'.repeat(32));
const lastFinalizedBlock = BlockHash.fromHexString('cd'.repeat(32));

const consensusStatus = {
  version: 0,
  bestBlock,
  genesisBlock: BlockHash.fromHexString('01'.repeat(32)),
  currentEraGenesisBlock: BlockHash.fromHexString('02'.repeat(32)),
  lastFinalizedBlock,
  epochDuration: Duration.fromMillis(3_600_000),
  bestBlockHeight: 12n,
  lastFinalizedBlockHeight: 11n,
  finalizationCount: 10n,
  blocksVerifiedCount: 12n,
  blocksReceivedCount: 13n,
  blockArriveLatencyEMA: 0.1,
  blockArriveLatencyEMSD: 0.01,
  blockReceiveLatencyEMA: 0.2,
  blockReceiveLatencyEMSD: 0.02,
  transactionsPerBlockEMA: 2,
  transactionsPerBlockEMSD: 0.5,
  genesisTime: new Date('2024-01-01T00:00:00.000Z'),
  currentEraGenesisTime: new Date('2024-01-01T00:00:00.000Z'),
  genesisIndex: 0,
  protocolVersion: 5n,
  slotDuration: Duration.fromMillis(2_000),
} satisfies ConsensusStatus;

function sdkClient(): ConcordiumGRPCClient {
  return Object.create(ConcordiumGRPCClient.prototype) as ConcordiumGRPCClient;
}

describe('resolveBlockHash', () => {
  it('leaves an omitted block selector unresolved', async () => {
    const grpc = sdkClient();
    const getConsensusStatus = vi.spyOn(grpc, 'getConsensusStatus');
    const getBlocksAtHeight = vi.spyOn(grpc, 'getBlocksAtHeight');

    await expect(resolveBlockHash(grpc, undefined)).resolves.toBeUndefined();
    expect(getConsensusStatus).not.toHaveBeenCalled();
    expect(getBlocksAtHeight).not.toHaveBeenCalled();
  });

  it.each([
    ['best', bestBlock],
    ['last_final', lastFinalizedBlock],
  ] as const)('resolves the %s block from consensus status', async (type, expected) => {
    const grpc = sdkClient();
    const getConsensusStatus = vi.spyOn(grpc, 'getConsensusStatus').mockResolvedValue(consensusStatus);

    await expect(resolveBlockHash(grpc, { type })).resolves.toBe(expected);
    expect(getConsensusStatus).toHaveBeenCalledOnce();
  });

  it('converts a hash selector to an SDK block hash', async () => {
    const grpc = sdkClient();
    const getConsensusStatus = vi.spyOn(grpc, 'getConsensusStatus');
    const getBlocksAtHeight = vi.spyOn(grpc, 'getBlocksAtHeight');

    await expect(resolveBlockHash(grpc, { type: 'hash', hash: String(bestBlock) })).resolves.toStrictEqual(bestBlock);
    expect(getConsensusStatus).not.toHaveBeenCalled();
    expect(getBlocksAtHeight).not.toHaveBeenCalled();
  });

  it.each([
    ['absolute', { type: 'height', height: 42n } as const, 42n],
    [
      'genesis-relative',
      { type: 'height', height: 7n, genesisIndex: 0 } as const,
      { genesisIndex: 0, height: 7n, restrict: true },
    ],
  ])('resolves an %s height and returns the sole SDK hash', async (_name, selector, expectedRequest) => {
    const grpc = sdkClient();
    const hash = BlockHash.fromHexString('ef'.repeat(32));
    const getBlocksAtHeight = vi.spyOn(grpc, 'getBlocksAtHeight').mockResolvedValue([hash]);

    await expect(resolveBlockHash(grpc, selector)).resolves.toBe(hash);
    expect(getBlocksAtHeight).toHaveBeenCalledWith(expectedRequest);
  });

  it.each([
    ['no', [], 'No blocks found'],
    ['multiple', [bestBlock, lastFinalizedBlock], 'Multiple live blocks'],
  ] as const)('rejects when a height has %s matching blocks', async (_name, hashes, message) => {
    const grpc = sdkClient();
    vi.spyOn(grpc, 'getBlocksAtHeight').mockResolvedValue([...hashes]);

    await expect(resolveBlockHash(grpc, { type: 'height', height: 9n })).rejects.toMatchObject({
      kind: 'invalid-argument',
      message: expect.stringContaining(message),
    });
  });

  it('propagates an SDK rejection unchanged', async () => {
    const grpc = sdkClient();
    const sdkError = new Error('SDK unavailable');
    vi.spyOn(grpc, 'getBlocksAtHeight').mockRejectedValue(sdkError);

    await expect(resolveBlockHash(grpc, { type: 'height', height: 9n })).rejects.toBe(sdkError);
  });
});
