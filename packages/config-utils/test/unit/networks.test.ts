import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAINNET_GENESIS_HASH, TESTNET_GENESIS_HASH } from '@ccd-agent-kit/sdk-utils';

import {
  getActiveNetwork,
  getDefaultNetwork,
  getActiveNetworkFromRegistry,
  getNetwork,
  getNetworkByCaip2Reference,
  getNetworksFilePath,
  addNetwork,
  findNetworkByCaip2,
  listSortedNetworks,
  loadNetworks,
  removeNetwork,
  resolveNetwork,
  resolveNetworkFromRegistry,
  saveNetworks,
  setDefaultNetwork,
  updateNetwork,
  createNetworkResourceAdapter,
  type NetworksFile,
  type NetworkConfig,
} from '../../src/index.js';
import { makeTestTempDir } from '../helpers/tempDir.js';

const originalEnv = { ...process.env };

function networkConfig(hexDigit: string, port = 20000): NetworkConfig {
  const genesisHash = hexDigit.repeat(64);
  return {
    caip2: `ccd:${genesisHash.slice(0, 32)}`,
    genesisHash,
    grpc: { host: `${hexDigit}.example`, port, ssl: false },
  };
}

describe('network registry', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTestTempDir('ccd-config-');
    process.env = { ...originalEnv, XDG_CONFIG_HOME: tempDir };
    delete process.env.CCD_NETWORK;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('loads built-in networks when the file is missing, invalid JSON, or invalid shape', () => {
    expect(Object.keys(loadNetworks().networks)).toEqual(['mainnet', 'testnet']);

    mkdirSync(dirname(getNetworksFilePath()), { recursive: true });
    writeFileSync(getNetworksFilePath(), '{', 'utf8');
    expect(Object.keys(loadNetworks().networks)).toEqual(['mainnet', 'testnet']);

    writeFileSync(getNetworksFilePath(), JSON.stringify({ default: 12, networks: [] }), 'utf8');
    expect(Object.keys(loadNetworks().networks)).toEqual(['mainnet', 'testnet']);
  });

  it.each([
    ['malformed genesis', { caip2: `ccd:${'a'.repeat(32)}`, genesisHash: 'a'.repeat(63) }],
    ['uppercase genesis', { caip2: `ccd:${'a'.repeat(32)}`, genesisHash: 'A'.repeat(64) }],
    ['malformed CAIP-2', { caip2: `other:${'a'.repeat(32)}`, genesisHash: 'a'.repeat(64) }],
    ['uppercase CAIP-2', { caip2: `ccd:${'A'.repeat(32)}`, genesisHash: 'a'.repeat(64) }],
    ['mismatched CAIP-2', { caip2: `ccd:${'b'.repeat(32)}`, genesisHash: 'a'.repeat(64) }],
  ])('falls back to built-ins for a registry with %s', (_name, identity) => {
    mkdirSync(dirname(getNetworksFilePath()), { recursive: true });
    writeFileSync(getNetworksFilePath(), JSON.stringify({
      default: 'localnet',
      networks: { localnet: { ...identity, grpc: { host: 'localhost', port: 20000, ssl: false } } },
    }), 'utf8');

    expect(Object.keys(loadNetworks().networks)).toEqual(['mainnet', 'testnet']);
  });

  it('uses canonical genesis hashes for coherent built-in network identities', () => {
    expect(loadNetworks().networks).toMatchObject({
      mainnet: {
        caip2: `ccd:${MAINNET_GENESIS_HASH.slice(0, 32)}`,
        genesisHash: MAINNET_GENESIS_HASH,
      },
      testnet: {
        caip2: `ccd:${TESTNET_GENESIS_HASH.slice(0, 32)}`,
        genesisHash: TESTNET_GENESIS_HASH,
      },
    });
  });

  it('saves formatted network JSON and creates the parent directory', () => {
    const config: NetworksFile = {
      default: 'localnet',
      networks: {
        localnet: {
          caip2: 'ccd:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          genesisHash: `${'a'.repeat(32)}${'0'.repeat(32)}`,
          grpc: { host: 'localhost', port: 20000, ssl: false },
        },
      },
    };

    saveNetworks(config);

    expect(readFileSync(getNetworksFilePath(), 'utf8')).toBe(`${JSON.stringify(config, null, 2)}\n`);
  });

  it.each([
    ['a non-canonical stored key', ' localnet ', 'mainnet'],
    ['an invalid stored key', 'local:net', 'mainnet'],
    ['an overlong stored key', 'a'.repeat(50), 'mainnet'],
    ['an invalid default name', 'localnet', ' bad default '],
  ])('falls back without rewriting a registry with %s', (_case, key, defaultName) => {
    mkdirSync(dirname(getNetworksFilePath()), { recursive: true });
    const stored = `${JSON.stringify({
      default: defaultName,
      networks: { [key]: networkConfig('a') },
    }, null, 2)}\n`;
    writeFileSync(getNetworksFilePath(), stored, 'utf8');

    expect(Object.keys(loadNetworks().networks)).toEqual(['mainnet', 'testnet']);
    expect(readFileSync(getNetworksFilePath(), 'utf8')).toBe(stored);
  });

  it.each([
    ['a non-canonical stored key', { default: 'localnet', networks: { ' localnet ': networkConfig('a') } }],
    ['an invalid stored key', { default: 'localnet', networks: { 'local:net': networkConfig('b') } }],
    ['an overlong stored key', { default: 'localnet', networks: { ['a'.repeat(50)]: networkConfig('d') } }],
    ['an invalid default name', { default: 'bad default', networks: { localnet: networkConfig('c') } }],
  ])('rejects saving a registry with %s without replacing the file', (_case, registry) => {
    saveNetworks({ default: 'mainnet', networks: {} });
    const before = readFileSync(getNetworksFilePath(), 'utf8');

    expect(() => saveNetworks(registry)).toThrow();
    expect(readFileSync(getNetworksFilePath(), 'utf8')).toBe(before);
  });

  it.each([
    ['malformed genesis', { caip2: `ccd:${'a'.repeat(32)}`, genesisHash: 'a'.repeat(63) }],
    ['uppercase genesis', { caip2: `ccd:${'a'.repeat(32)}`, genesisHash: 'A'.repeat(64) }],
    ['malformed CAIP-2', { caip2: `other:${'a'.repeat(32)}`, genesisHash: 'a'.repeat(64) }],
    ['uppercase CAIP-2', { caip2: `ccd:${'A'.repeat(32)}`, genesisHash: 'a'.repeat(64) }],
    ['mismatched CAIP-2', { caip2: `ccd:${'b'.repeat(32)}`, genesisHash: 'a'.repeat(64) }],
  ])('rejects saving a registry with %s without replacing the file', (_name, identity) => {
    saveNetworks({ default: 'mainnet', networks: {} });
    const before = readFileSync(getNetworksFilePath(), 'utf8');

    expect(() => saveNetworks({
      default: 'localnet',
      networks: { localnet: { ...identity, grpc: { host: 'localhost', port: 20000, ssl: false } } },
    })).toThrow('Invalid network config');
    expect(readFileSync(getNetworksFilePath(), 'utf8')).toBe(before);
  });

  it('lists network names in sorted order', () => {
    saveNetworks({
      default: 'zeta',
      networks: {
        zeta: {
          caip2: 'ccd:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          genesisHash: `${'a'.repeat(32)}${'0'.repeat(32)}`,
          grpc: { host: 'localhost', port: 20000, ssl: false },
        },
        alpha: {
          caip2: 'ccd:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          genesisHash: `${'b'.repeat(32)}${'0'.repeat(32)}`,
          grpc: { host: 'localhost', port: 20001, ssl: false },
        },
      },
    });

    expect(listSortedNetworks()).toEqual(['alpha', 'mainnet', 'testnet', 'zeta']);
  });

  it('falls back to mainnet when the configured default is missing', () => {
    saveNetworks({ default: 'missing', networks: {} });

    expect(getDefaultNetwork().name).toBe('mainnet');
  });

  it('honors network names and non-name selectors in CCD_NETWORK', () => {
    for (const selector of [
      ' testnet ',
      '4221332d34e1694168c2a0c0b3fd0f27',
      'ccd:4221332d34e1694168c2a0c0b3fd0f27',
    ]) {
      process.env.CCD_NETWORK = selector;
      expect(getActiveNetwork()).toMatchObject({ name: 'testnet', source: 'session' });
    }
  });

  it('throws when CCD_NETWORK names an unknown network', () => {
    process.env.CCD_NETWORK = 'missing';

    expect(() => getActiveNetwork()).toThrow("Session network 'missing' from CCD_NETWORK not found.");
  });

  it('resolves explicit and default networks', () => {
    expect(resolveNetwork(' testnet ').name).toBe('testnet');
    expect(resolveNetwork('4221332d34e1694168c2a0c0b3fd0f27').name).toBe('testnet');
    expect(resolveNetwork('ccd:4221332d34e1694168c2a0c0b3fd0f27').name).toBe('testnet');
    expect(resolveNetwork().name).toBe('mainnet');
    expect(() => resolveNetwork('missing')).toThrow("Network 'missing' not found.");
  });

  it('resolves active and explicit networks from a loaded registry snapshot', () => {
    const registry = loadNetworks();
    registry.default = 'custom';
    registry.networks.custom = {
      caip2: 'ccd:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      genesisHash: 'a'.repeat(64),
      grpc: { host: 'custom.example', port: 20000, ssl: true },
    };

    expect(getActiveNetworkFromRegistry(registry)).toMatchObject({ name: 'custom', source: 'config' });
    expect(resolveNetworkFromRegistry('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', registry).name).toBe('custom');
    expect(resolveNetworkFromRegistry('ccd:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', registry).name).toBe('custom');

    process.env.CCD_NETWORK = 'mainnet';
    expect(resolveNetworkFromRegistry(undefined, registry)).toMatchObject({ name: 'mainnet', source: 'session' });
    expect(() => resolveNetworkFromRegistry('missing', registry)).toThrow("Network 'missing' not found.");

    process.env.CCD_NETWORK = 'missing';
    expect(() => getActiveNetworkFromRegistry(registry)).toThrow("Session network 'missing' from CCD_NETWORK not found.");

    delete process.env.CCD_NETWORK;
    expect(getActiveNetworkFromRegistry({ ...loadNetworks(), default: 'missing' })).toMatchObject({
      name: 'mainnet',
      source: 'config',
    });
  });

  it('adapts the registry into sorted resource networks', () => {
    addNetwork('alpha', networkConfig('a'));
    const adapter = createNetworkResourceAdapter();
    expect(adapter.list().map(({ name }) => name)).toEqual(['alpha', 'mainnet', 'testnet']);
    expect(adapter.list()[0]).toEqual({ name: 'alpha', caip2: `ccd:${'a'.repeat(32)}`, value: networkConfig('a') });
    expect(adapter.resolve('alpha')).toEqual(adapter.list()[0]);
  });

  it('uses the active default and maps unknown selectors to a safe resource code', () => {
    process.env.CCD_NETWORK = 'testnet';
    const adapter = createNetworkResourceAdapter();

    expect(adapter.resolveDefault()).toMatchObject({ name: 'testnet' });
    process.env.CCD_NETWORK = '/Users/operator/default-secret';
    for (const read of [() => adapter.resolveDefault(), () => adapter.resolve('/Users/operator/secret')]) {
      expect(read).toThrow(expect.objectContaining({
        code: 'NETWORK_NOT_FOUND',
        message: expect.not.stringContaining('/Users/operator'),
      }));
    }
  });

  it('resolves networks by CAIP-2 reference', () => {
    expect(getNetworkByCaip2Reference('4221332d34e1694168c2a0c0b3fd0f27')?.name).toBe('testnet');
    expect(getNetworkByCaip2Reference('00000000000000000000000000000000')).toBeUndefined();
    expect(getNetwork(' testnet ')).toEqual(loadNetworks().networks.testnet);
    expect(getNetwork('ccd:4221332d34e1694168c2a0c0b3fd0f27')).toBeUndefined();
    expect(getNetwork('invalid:name')).toBeUndefined();
    expect(getNetwork('missing')).toBeUndefined();
  });

  it('adds ccd-prefixed networks and rejects duplicate names or genesis hashes', () => {
    const localnet = networkConfig('a');

    addNetwork('ccdlocal', localnet);
    addNetwork('ccdDev', networkConfig('b'));

    expect(resolveNetwork('ccdlocal').config).toEqual(localnet);
    expect(resolveNetwork('ccdDev').config).toEqual(networkConfig('b'));
    expect(() => addNetwork('ccdlocal', networkConfig('c'))).toThrow("Network 'ccdlocal' already exists");
    expect(() => addNetwork('other', localnet)).toThrow(
      'already uses this genesis hash',
    );
  });

  it('normalizes network names before every registry mutation', () => {
    const config = networkConfig('a');
    addNetwork(' localnet ', config);
    expect(loadNetworks().networks).toHaveProperty('localnet', config);

    updateNetwork(' localnet ', { grpc: { host: 'updated.example', port: 20001, ssl: true } });
    expect(getNetwork(' localnet ')?.grpc.host).toBe('updated.example');

    setDefaultNetwork(' localnet ');
    expect(getDefaultNetwork().name).toBe('localnet');

    removeNetwork(' localnet ');
    expect(getNetwork('localnet')).toBeUndefined();
    expect(getDefaultNetwork().name).toBe('mainnet');
  });

  it.each([
    ['add', () => addNetwork('1invalid', networkConfig('b'))],
    ['update', () => updateNetwork('invalid:name', { grpc: { host: 'x', port: 1, ssl: false } })],
    ['remove', () => removeNetwork('invalid:name')],
    ['set-default', () => setDefaultNetwork('invalid:name')],
  ])('rejects an invalid name before %s writes or changes registry state', (_operation, mutation) => {
    addNetwork('localnet', networkConfig('a'));
    const before = readFileSync(getNetworksFilePath(), 'utf8');

    expect(mutation).toThrow(/1-49 ASCII/);
    expect(readFileSync(getNetworksFilePath(), 'utf8')).toBe(before);
    expect(loadNetworks().networks.localnet).toEqual(networkConfig('a'));
  });

  it('rejects invalid network identities on add without writing them', () => {
    expect(() => addNetwork('localnet', {
      caip2: `ccd:${'b'.repeat(32)}`,
      genesisHash: 'a'.repeat(64),
      grpc: { host: 'localhost', port: 20000, ssl: false },
    })).toThrow('Invalid network config');

    expect(loadNetworks().networks.localnet).toBeUndefined();
  });

  it('updates networks and rejects unknown names or genesis conflicts', () => {
    const localnet: NetworkConfig = {
      caip2: 'ccd:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      genesisHash: `${'a'.repeat(32)}${'0'.repeat(32)}`,
      grpc: { host: 'localhost', port: 20000, ssl: false },
    };
    addNetwork('localnet', localnet);

    updateNetwork('localnet', { grpc: { host: '127.0.0.1', port: 20001, ssl: false } });

    expect(resolveNetwork('localnet').config.grpc.host).toBe('127.0.0.1');
    expect(() => updateNetwork('missing', { grpc: { host: 'x', port: 1, ssl: false } })).toThrow(
      "Network 'missing' not found",
    );
    expect(() =>
      updateNetwork('localnet', {
        caip2: `ccd:${MAINNET_GENESIS_HASH.slice(0, 32)}`,
        genesisHash: MAINNET_GENESIS_HASH,
      }),
    ).toThrow('already uses this genesis hash');
  });

  it('rejects invalid network identities on update without changing the stored record', () => {
    const localnet: NetworkConfig = {
      caip2: `ccd:${'a'.repeat(32)}`,
      genesisHash: 'a'.repeat(64),
      grpc: { host: 'localhost', port: 20000, ssl: false },
    };
    addNetwork('localnet', localnet);

    expect(() => updateNetwork('localnet', { caip2: `ccd:${'A'.repeat(32)}` })).toThrow('Invalid network config');
    expect(loadNetworks().networks.localnet).toEqual(localnet);
  });

  it('removes non-built-in networks and resets the default when needed', () => {
    addNetwork('localnet', {
      caip2: 'ccd:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      genesisHash: `${'a'.repeat(32)}${'0'.repeat(32)}`,
      grpc: { host: 'localhost', port: 20000, ssl: false },
    });
    setDefaultNetwork('localnet');

    removeNetwork('localnet');

    expect(resolveNetwork().name).toBe('mainnet');
    expect(() => resolveNetwork('localnet')).toThrow("Network 'localnet' not found.");
    expect(() => removeNetwork('mainnet')).toThrow('Cannot remove built-in network');
    expect(() => removeNetwork('missing')).toThrow("Network 'missing' not found");
  });

  it('sets defaults and finds networks by CAIP-2 identifier or genesis hash', () => {
    setDefaultNetwork('testnet');

    expect(resolveNetwork().name).toBe('testnet');
    expect(findNetworkByCaip2('ccd:4221332d34e1694168c2a0c0b3fd0f27')?.name).toBe('testnet');
    expect(findNetworkByCaip2(TESTNET_GENESIS_HASH)?.name).toBe('testnet');
    expect(findNetworkByCaip2('ccd:00000000000000000000000000000000')).toBeUndefined();
    expect(() => setDefaultNetwork('missing')).toThrow("Network 'missing' not found");
  });
});
