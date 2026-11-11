import { describe, expect, it } from 'vitest';

import { getBuiltinNetworkName, MAINNET_GENESIS_HASH, TESTNET_GENESIS_HASH } from '../../src/index.js';

const EXPECTED_MAINNET_GENESIS_HASH = '9dd9ca4d19e9393877d2c44b70f89acbfc0883c2243e5eeaecc0d1cd0503f478';
const EXPECTED_TESTNET_GENESIS_HASH = '4221332d34e1694168c2a0c0b3fd0f273809612cb13d000d5c2e00e85f50f796';

describe('built-in network helpers', () => {
  it('exports the canonical full genesis hashes', () => {
    expect(MAINNET_GENESIS_HASH).toBe(EXPECTED_MAINNET_GENESIS_HASH);
    expect(TESTNET_GENESIS_HASH).toBe(EXPECTED_TESTNET_GENESIS_HASH);
  });

  it('classifies official genesis hashes case-insensitively', () => {
    expect(getBuiltinNetworkName(EXPECTED_MAINNET_GENESIS_HASH)).toBe('mainnet');
    expect(getBuiltinNetworkName(EXPECTED_TESTNET_GENESIS_HASH)).toBe('testnet');
    expect(getBuiltinNetworkName(EXPECTED_MAINNET_GENESIS_HASH.toUpperCase())).toBe('mainnet');
    expect(getBuiltinNetworkName(EXPECTED_TESTNET_GENESIS_HASH.toUpperCase())).toBe('testnet');
  });

  it('does not classify non-canonical or invalid values as built-in networks', () => {
    expect(getBuiltinNetworkName(`${EXPECTED_MAINNET_GENESIS_HASH.slice(0, 32)}${'0'.repeat(32)}`)).toBeUndefined();
    expect(getBuiltinNetworkName('a'.repeat(64))).toBeUndefined();
    expect(getBuiltinNetworkName(EXPECTED_TESTNET_GENESIS_HASH.slice(0, 32))).toBeUndefined();
    expect(getBuiltinNetworkName(`ccd:${EXPECTED_TESTNET_GENESIS_HASH.slice(0, 32)}`)).toBeUndefined();
    expect(getBuiltinNetworkName('not-a-genesis-hash')).toBeUndefined();
  });
});
