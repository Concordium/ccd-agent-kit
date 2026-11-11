import { AccountAddress, BlockHash, type AccountInfo } from '@concordium/web-sdk';
import { ConcordiumGRPCNodeClient, credentials } from '@concordium/web-sdk/nodejs';
import type { AccountCredentialObservation } from '@ccd-agent-kit/config-utils';
import { extractAccountCredentials as readAccountCredentials } from '@ccd-agent-kit/sdk-utils';

export { caip2FromGenesis, caip2Reference } from '@ccd-agent-kit/sdk-utils';

/** Connection details for a Concordium gRPC node. */
export interface GrpcConnection {
  /** gRPC server hostname or IP. */
  host: string;
  /** gRPC server port. */
  port: number;
  /** Whether to use TLS. */
  ssl: boolean;
}

/** Consensus information from a Concordium node. */
export interface ConsensusInfo {
  /** The genesis block hash, hex-encoded. */
  genesisBlock: string;
}

/** Error thrown when a gRPC connection cannot be established. */
export class GrpcConnectionError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'GrpcConnectionError';
  }
}

export interface AccountCredentialsQueryResult {
  canonicalAddress: string;
  observation: AccountCredentialObservation;
}

/** Connects to a Concordium gRPC node and queries consensus info. */
export async function queryConsensusInfo(connection: GrpcConnection, timeoutMs = 5000): Promise<ConsensusInfo> {
  try {
    const channelCredentials = connection.ssl ? credentials.createSsl() : credentials.createInsecure();
    const client = new ConcordiumGRPCNodeClient(connection.host, connection.port, channelCredentials, { timeout: timeoutMs });
    const status = await client.getConsensusStatus();
    return { genesisBlock: BlockHash.toHexString(status.genesisBlock) };
  } catch (error) {
    throw new GrpcConnectionError(`gRPC call failed: ${formatGrpcError(error, timeoutMs)}`);
  }
}

function formatGrpcError(error: unknown, timeoutMs: number): string {
  const message = error instanceof Error ? error.message : String(error);
  const code = typeof error === 'object' && error !== null && 'code' in error ? (error as { code?: unknown }).code : undefined;
  if (code === 'DEADLINE_EXCEEDED' || code === 4 || /deadline|timeout/i.test(message)) {
    return `Timed out after ${timeoutMs}ms: ${message}`;
  }
  return message;
}

/** Auto-detects SSL connectivity by attempting SSL first, then non-SSL. */
export async function autoDetectConnection(
  host: string,
  port: number,
  timeoutMs = 5000,
): Promise<GrpcConnection & ConsensusInfo> {
  try {
    const sslConnection: GrpcConnection = { host, port, ssl: true };
    const info = await queryConsensusInfo(sslConnection, timeoutMs);
    return { ...sslConnection, ...info };
  } catch {
    // Try non-SSL below.
  }

  try {
    const insecureConnection: GrpcConnection = { host, port, ssl: false };
    const info = await queryConsensusInfo(insecureConnection, timeoutMs);
    return { ...insecureConnection, ...info };
  } catch {
    // Report one clear failure below.
  }

  throw new GrpcConnectionError(`Could not connect to gRPC node at ${host}:${port} (tried tls and no-tls)`);
}

/** Queries finalized account credential public keys from the configured node. */
export async function queryFinalizedAccountCredentials(
  connection: GrpcConnection,
  address: string,
): Promise<AccountCredentialsQueryResult> {
  try {
    const channelCredentials = connection.ssl ? credentials.createSsl() : credentials.createInsecure();
    const client = new ConcordiumGRPCNodeClient(connection.host, connection.port, channelCredentials);
    const status = await client.getConsensusStatus();
    const lastFinalized = status.lastFinalizedBlock;
    const [info, blockInfo] = await Promise.all([
      client.getAccountInfo(AccountAddress.fromBase58(address), lastFinalized),
      client.getBlockInfo(lastFinalized),
    ]);
    return {
      canonicalAddress: info.accountAddress.address,
      observation: {
        accountThreshold: info.accountThreshold.toString(),
        credentials: extractAccountCredentials(info),
        sourceBlock: {
          hash: BlockHash.toHexString(lastFinalized),
          height: blockInfo.blockHeight.toString(),
          time: blockInfo.blockSlotTime.toISOString(),
        },
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new GrpcConnectionError(`gRPC call failed: ${message}`);
  }
}

/** Extracts public account credential keys from an SDK AccountInfo object. */
export function extractAccountCredentials(
  raw: Pick<AccountInfo, 'accountCredentials'>,
): AccountCredentialObservation['credentials'] {
  // CLI observations historically omit credential IDs; preserve that persisted shape.
  return Object.fromEntries(
    Object.entries(readAccountCredentials(raw)).map(([index, data]) => [
      index,
      {
        keys: data.keys,
        threshold: data.threshold,
      },
    ]),
  );
}
