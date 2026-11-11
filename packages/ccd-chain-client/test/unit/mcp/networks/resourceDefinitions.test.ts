import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  encodeCatalogLabel,
  type loadAccountLabels,
  type loadNetworks,
  type resolveNetwork,
} from '@ccd-agent-kit/config-utils';
import { caip2FromGenesis, MAINNET_GENESIS_HASH, TESTNET_GENESIS_HASH } from '@ccd-agent-kit/sdk-utils';
import type { resolveChainCapabilities } from '../../../../src/concordium/protocol.js';
import { globalNetworkResourceDefinitions, networkResourceFamilies } from '../../../../src/mcp/networks/resourceDefinitions.js';
import { readDomainResource } from '../../../helpers/domainResources.js';
import { FakeConcordiumClient, makeContext } from '../../../helpers/fakes.js';

const mocks = vi.hoisted(() => ({
  loadAccountLabels: vi.fn<typeof loadAccountLabels>(),
  loadNetworks: vi.fn<typeof loadNetworks>(),
  resolveChainCapabilities: vi.fn<typeof resolveChainCapabilities>(),
  resolveNetwork: vi.fn<typeof resolveNetwork>(),
}));

const NETWORKS = {
  default: 'mainnet',
  networks: {
    mainnet: {
      caip2: caip2FromGenesis(MAINNET_GENESIS_HASH),
      genesisHash: MAINNET_GENESIS_HASH,
      grpc: { host: 'mainnet.example', port: 20000, ssl: true },
    },
    testnet: {
      caip2: caip2FromGenesis(TESTNET_GENESIS_HASH),
      genesisHash: TESTNET_GENESIS_HASH,
      grpc: { host: 'testnet.example', port: 20000, ssl: true },
    },
  },
};

vi.mock('@ccd-agent-kit/config-utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ccd-agent-kit/config-utils')>()),
  loadAccountLabels: mocks.loadAccountLabels,
  loadNetworks: mocks.loadNetworks,
  resolveNetwork: mocks.resolveNetwork,
}));
vi.mock('../../../../src/concordium/protocol.js', () => ({ resolveChainCapabilities: mocks.resolveChainCapabilities }));

describe('globalNetworkResourceDefinitions and networkResourceFamilies', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadNetworks.mockReturnValue(NETWORKS);
    mocks.resolveNetwork.mockImplementation((network) => {
      const name = network === 'testnet' ? 'testnet' : 'mainnet';
      return { name, config: NETWORKS.networks[name] };
    });
    mocks.loadAccountLabels.mockImplementation((ref = '') => ref.startsWith('9dd9') ? {
      [encodeCatalogLabel('Alice', 'hard')]: 'a',
      [encodeCatalogLabel('Bot', 'soft')]: 'b',
    } : {});
  });

  it('projects a sorted network catalogue with the startup-captured default', async () => {
    const ctx = makeContext(new FakeConcordiumClient(), { network: 'testnet', defaultNetworkSource: 'session' });

    const content = await globalNetworkResourceDefinitions(ctx)[0]!.read('ccd://networks');
    expect(JSON.parse(content.text)).toEqual({
      defaultNetwork: 'testnet', defaultNetworkSource: 'session',
      networks: [
        { name: 'mainnet', caip2: NETWORKS.networks.mainnet.caip2 },
        { name: 'testnet', caip2: NETWORKS.networks.testnet.caip2 },
      ],
    });
  });

  it('routes capabilities and consensus reads to their selected network clients', async () => {
    const consensus = {
      bestBlockHash: 'best', lastFinalizedBlockHash: 'finalized', lastFinalizedBlockHeight: '1',
      genesisTime: '2026-01-01T00:00:00.000Z', currentEraGenesisTime: '2026-01-01T00:00:00.000Z', currentEra: 0,
    };
    const queryClient = new FakeConcordiumClient({ consensus });
    mocks.resolveChainCapabilities.mockResolvedValue({
      network: 'testnet', protocolVersion: 10, capabilities: ['ccd.transfer'],
    });
    const ctx = makeContext(queryClient);
    const getClient = vi.spyOn(ctx.clients, 'getClient');

    await expect(readDomainResource(networkResourceFamilies(), 'chain-capabilities', ctx, {
      network: 'testnet',
    })).resolves.toEqual({ protocolVersion: 10, capabilities: ['ccd.transfer'] });
    expect(mocks.resolveChainCapabilities).toHaveBeenCalledWith(queryClient, 'testnet');
    expect(getClient).toHaveBeenCalledWith(expect.objectContaining({ name: 'testnet' }));

    getClient.mockClear();
    await expect(readDomainResource(networkResourceFamilies(), 'consensus-status', ctx, {
      network: 'testnet',
    })).resolves.toEqual(consensus);
    expect(getClient).toHaveBeenCalledWith(expect.objectContaining({ name: 'testnet' }));
  });

  it('projects bare sorted account labels for a selected network', async () => {
    const ctx = makeContext(new FakeConcordiumClient());

    await expect(readDomainResource(networkResourceFamilies(), 'account-labels', ctx, {
      network: '9dd9ca4d19e9393877d2c44b70f89acb',
    })).resolves.toEqual({
      labels: [{ label: 'Alice', address: 'a' }, { label: 'Bot', address: 'b' }],
    });
  });
});
