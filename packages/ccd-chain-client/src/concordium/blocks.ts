import { BlockHash, type BlocksAtHeightRequest, type ConcordiumGRPCClient } from '@concordium/web-sdk';
import type { BlockIdentifier } from './client.js';

/** Resolve a selector once; heights with multiple live blocks require an explicit hash. */
export async function resolveBlockHash(
  grpc: ConcordiumGRPCClient,
  block: BlockIdentifier | undefined,
): Promise<BlockHash.Type | undefined> {
  if (block === undefined) return undefined;
  switch (block.type) {
    case 'best':
      return (await grpc.getConsensusStatus()).bestBlock;
    case 'last_final':
      return (await grpc.getConsensusStatus()).lastFinalizedBlock;
    case 'hash':
      return BlockHash.fromHexString(block.hash);
    case 'height': {
      const request: BlocksAtHeightRequest =
        block.genesisIndex === undefined
          ? block.height
          : { genesisIndex: block.genesisIndex, height: block.height, restrict: true };
      const hashes = await grpc.getBlocksAtHeight(request);
      const first = hashes[0];
      if (first === undefined) throw { kind: 'invalid-argument', message: `No blocks found at height ${block.height}` };
      if (hashes.length > 1)
        throw {
          kind: 'invalid-argument',
          message: `Multiple live blocks found at height ${block.height}; use a block hash to disambiguate.`,
        };
      return first;
    }
  }
}
