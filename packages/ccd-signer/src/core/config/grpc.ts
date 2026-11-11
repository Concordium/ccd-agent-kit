import { BlockHash } from '@concordium/web-sdk';
import { ConcordiumGRPCNodeClient, credentials } from '@concordium/web-sdk/nodejs';

export { caip2FromGenesis, caip2Reference } from '@ccd-agent-kit/sdk-utils';

/**
 * Connection details for a Concordium gRPC node.
 */
export interface GrpcConnection {
  /** gRPC server hostname or IP. */
  host: string;
  /** gRPC server port. */
  port: number;
  /** Whether to use TLS. */
  ssl: boolean;
}

/**
 * Consensus information from a Concordium node.
 */
export interface ConsensusInfo {
  /** The genesis block hash (hex-encoded, 64 characters). */
  genesisBlock: string;
}

/**
 * Error thrown when a gRPC connection cannot be established.
 */
export class GrpcConnectionError extends Error {
  /**
   * Creates a gRPC connection error.
   *
   * @param message - The error message.
   */
  public constructor(message: string) {
    super(message);
    this.name = 'GrpcConnectionError';
  }
}

/**
 * Connects to a Concordium gRPC node and queries consensus info.
 *
 * @param connection - The gRPC connection details.
 * @param timeoutMs - Connection timeout in milliseconds (default: 5000).
 * @returns The consensus info including genesis block hash.
 * @throws {GrpcConnectionError} If the connection fails.
 */
export function queryConsensusInfo(connection: GrpcConnection, timeoutMs = 5000): Promise<ConsensusInfo> {
  return new Promise((resolve, reject) => {
    const channelCredentials = connection.ssl ? credentials.createSsl() : credentials.createInsecure();

    const client = new ConcordiumGRPCNodeClient(connection.host, connection.port, channelCredentials);

    const timer = setTimeout(() => {
      reject(new GrpcConnectionError(`gRPC call failed: deadline exceeded after ${timeoutMs}ms`));
    }, timeoutMs);

    void client
      .getConsensusStatus()
      .then((status) => {
        const genesisBlock = BlockHash.toHexString(status.genesisBlock);
        resolve({ genesisBlock });
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        reject(new GrpcConnectionError(`gRPC call failed: ${message}`));
      })
      .finally(() => {
        clearTimeout(timer);
      });
  });
}

/**
 * Auto-detects SSL connectivity by attempting SSL first, then non-SSL.
 *
 * Returns the connection details that succeeded, including the auto-detected SSL setting.
 *
 * @param host - The gRPC server hostname.
 * @param port - The gRPC server port.
 * @param timeoutMs - Connection timeout per attempt in milliseconds (default: 5000).
 * @returns The working connection details with genesis info.
 * @throws {GrpcConnectionError} If both SSL and non-SSL connections fail.
 */
export async function autoDetectConnection(
  host: string,
  port: number,
  timeoutMs = 5000,
): Promise<GrpcConnection & ConsensusInfo> {
  // Try SSL first
  try {
    const sslConnection: GrpcConnection = { host, port, ssl: true };
    const info = await queryConsensusInfo(sslConnection, timeoutMs);
    return { ...sslConnection, ...info };
  } catch {
    // SSL failed, try non-SSL
  }

  // Try non-SSL
  try {
    const insecureConnection: GrpcConnection = { host, port, ssl: false };
    const info = await queryConsensusInfo(insecureConnection, timeoutMs);
    return { ...insecureConnection, ...info };
  } catch {
    // Both failed
  }

  throw new GrpcConnectionError(`Could not connect to gRPC node at ${host}:${port} (tried tls and no-tls)`);
}
