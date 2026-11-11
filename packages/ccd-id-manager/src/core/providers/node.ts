import { resolveNetwork, setIdentityContextSnapshot } from '@ccd-agent-kit/config-utils';
import { getBuiltinNetworkName, parseIdentityContextSnapshot } from '@ccd-agent-kit/sdk-utils';
import { BlockHash } from '@concordium/web-sdk';
import { ConcordiumGRPCNodeClient, credentials } from '@concordium/web-sdk/nodejs';
import { IdentityProviderError } from './error.js';
import type { CanonicalNetwork, FinalizedIdentityProviderContext } from './types.js';

const REQUEST_TIMEOUT_MS = 10_000;

async function collect<T>(items: AsyncIterable<T>, signal: AbortSignal): Promise<T[]> {
  const result: T[] = [];
  for await (const item of items) {
    if (signal.aborted) throw new Error();
    result.push(item);
  }
  return result;
}

/**
 * Read and persist identity-provider context plus finalized-block provenance from one captured block.
 * This node boundary verifies the configured namespace, observed full genesis, and finalized block origin
 * before the validated SDK snapshot is made available to consumers.
 */
export async function readFinalizedIdentityProviderContext(
  network: CanonicalNetwork,
): Promise<FinalizedIdentityProviderContext> {
  try {
    const genesisHash = network.genesisHash.toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(network.genesisHash) || network.genesisHash !== genesisHash
      || network.caip2 !== `ccd:${genesisHash.slice(0, 32)}`) {
      throw new IdentityProviderError('CONTEXT_MISMATCH');
    }
    const resolved = resolveNetwork(network.caip2);
    if (resolved.config.caip2 !== network.caip2 || resolved.config.genesisHash !== genesisHash) {
      throw new IdentityProviderError('CONTEXT_MISMATCH');
    }
    const channelCredentials = resolved.config.grpc.ssl ? credentials.createSsl() : credentials.createInsecure();
    const client = new ConcordiumGRPCNodeClient(
      resolved.config.grpc.host, resolved.config.grpc.port, channelCredentials, { timeout: REQUEST_TIMEOUT_MS },
    );
    const status = await client.getConsensusStatus();
    const observedGenesis = BlockHash.toHexString(status.genesisBlock).toLowerCase();
    if (observedGenesis !== genesisHash) throw new IdentityProviderError('CONTEXT_MISMATCH');
    const finalized = status.lastFinalizedBlock;
    const finalizedHash = BlockHash.toHexString(finalized).toLowerCase();
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), REQUEST_TIMEOUT_MS);
    try {
      const [block, globalContext, identityProviders, anonymityRevokers] = await Promise.all([
        client.getBlockInfo(finalized),
        client.getCryptographicParameters(finalized),
        collect(client.getIdentityProviders(finalized, abort.signal), abort.signal),
        collect(client.getAnonymityRevokers(finalized, abort.signal), abort.signal),
      ]);
      let snapshot;
      try {
        const sourceHash = BlockHash.toHexString(block.blockHash).toLowerCase();
        if (sourceHash !== finalizedHash) throw new Error();
        snapshot = parseIdentityContextSnapshot({
          version: 1,
          network,
          sourceBlock: {
            hash: sourceHash,
            height: block.blockHeight.toString(),
            time: block.blockSlotTime.toISOString(),
          },
          observedAt: new Date().toISOString(),
          globalContext,
          identityProviders,
          anonymityRevokers,
        });
      } catch {
        throw new IdentityProviderError('CONTEXT_MISMATCH');
      }
      setIdentityContextSnapshot(genesisHash.slice(0, 32), snapshot);
      return {
        ...snapshot,
        sdkNetwork: getBuiltinNetworkName(genesisHash) === 'mainnet' ? 'Mainnet' : 'Testnet',
      };
    } finally {
      clearTimeout(timer);
      abort.abort();
    }
  } catch (error) {
    if (error instanceof IdentityProviderError) throw error;
    throw new IdentityProviderError('NODE_FAILED');
  }
}
