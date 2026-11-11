import type { NetworkConfig } from '@ccd-agent-kit/config-utils';

export function snapshotNetworkConfig(digit: string, host = `${digit}.example`): NetworkConfig {
  const genesisHash = digit.repeat(64);
  return {
    caip2: `ccd:${genesisHash.slice(0, 32)}`,
    genesisHash,
    grpc: { host, port: 20000, ssl: false },
  };
}
