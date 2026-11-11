/** Canonical full genesis block hash for Concordium mainnet. */
export const MAINNET_GENESIS_HASH = '9dd9ca4d19e9393877d2c44b70f89acbfc0883c2243e5eeaecc0d1cd0503f478';

/** Canonical full genesis block hash for Concordium testnet. */
export const TESTNET_GENESIS_HASH = '4221332d34e1694168c2a0c0b3fd0f273809612cb13d000d5c2e00e85f50f796';

/**
 * Identifies a built-in Concordium network from its complete genesis block hash.
 *
 * @param genesisHash - Full genesis block hash to compare case-insensitively.
 * @returns The built-in network name, or `undefined` for every other string.
 */
export function getBuiltinNetworkName(genesisHash: string): 'mainnet' | 'testnet' | undefined {
  const normalizedGenesisHash = genesisHash.toLowerCase();
  if (normalizedGenesisHash === MAINNET_GENESIS_HASH) return 'mainnet';
  if (normalizedGenesisHash === TESTNET_GENESIS_HASH) return 'testnet';
  return undefined;
}
