import type { ServerConfig } from '../config.js';

export interface GrpcEndpoint {
  host: string;
  port: number;
  tls: boolean;
}

/**
 * Resolves the effective node gRPC endpoint for a `ServerConfig`, applying the
 * `CCD_GRPC_ENDPOINT` override when present.
 */
export function resolveEndpoint(config: ServerConfig): GrpcEndpoint {
  const { endpoint, tls } = config.grpc;
  const match = /^([^:]+)(?::(\d+))?$/.exec(endpoint.trim());
  const host = match?.[1] ?? endpoint;
  const port = match?.[2] !== undefined ? Number(match[2]) : 20000;
  return { host, port, tls };
}
