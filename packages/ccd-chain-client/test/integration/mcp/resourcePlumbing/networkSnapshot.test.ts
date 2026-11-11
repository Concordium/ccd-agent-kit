import {
  addNetwork,
  resolveNetwork,
  setDefaultNetwork,
  setSoftAccountLabel,
  setSoftContractInstanceLabel,
  updateNetwork,
} from '@ccd-agent-kit/config-utils';
import { caip2Reference } from '@ccd-agent-kit/sdk-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { parseConfig } from '../../../../src/config.js';
import { accountResourceFamilies } from '../../../../src/mcp/accounts/resourceDefinitions.js';
import { contractResourceFamilies } from '../../../../src/mcp/contracts/resourceDefinitions.js';
import { networkResourceFamilies } from '../../../../src/mcp/networks/resourceDefinitions.js';
import { createChainNetworkResourceCatalog } from '../../../../src/mcp/resourcePlumbing/networkResources.js';
import { createCachingNetworkClientProvider } from '../../../../src/mcp/toolPlumbing/networkClient.js';
import { snapshotNetworkConfig } from '../../../helpers/networkSnapshot.js';
import { useTestXdg, useUnsetEnv } from '../../../helpers/xdg.js';

const clientMocks = vi.hoisted(() => ({
  onQuery: undefined as undefined | ((host: string) => void),
}));

vi.mock('../../../../src/concordium/client.js', () => ({
  ConcordiumNodeQueries: class {
    constructor(private readonly grpc: { endpoint: { host: string } }) {}

    async getConsensusInfo() {
      const host = this.grpc.endpoint.host;
      clientMocks.onQuery?.(host);
      return { endpointHost: host };
    }

    async getAccountInfo(address: string) {
      clientMocks.onQuery?.(this.grpc.endpoint.host);
      return { address, sequenceNumber: '0', index: '0', accountType: 'Simple' };
    }

    async getInstanceInfo(index: bigint, subindex: bigint) {
      clientMocks.onQuery?.(this.grpc.endpoint.host);
      return {
        moduleRef: '11'.repeat(32),
        owner: 'owner',
        amount: '0',
        name: 'sample',
        methods: [],
        address: { index: index.toString(), subindex: subindex.toString() },
      };
    }
  },
  createConcordiumClient: vi.fn((endpoint: { host: string }) => ({ endpoint })),
}));

function context(source: Record<string, string | undefined> = { CCD_NETWORK: 'alpha' }) {
  const parsed = parseConfig(source);
  if (!parsed.ok) throw new Error(parsed.errors.join(', '));
  return { config: parsed.value, clients: createCachingNetworkClientProvider(parsed.value) };
}

function registration(
  ctx: ReturnType<typeof context>,
  families: ReturnType<typeof networkResourceFamilies>,
  name: string,
) {
  const family = families.find((candidate) => candidate.name === name);
  if (family === undefined) throw new Error(`Missing ${name} resource family.`);
  const definitions = createChainNetworkResourceCatalog(ctx, [family]);
  return {
    read: (uri: string) => definitions[uri.startsWith('ccd://*/') ? 2 : 1]!.read(uri),
  };
}

function json(result: { text: string }) {
  return JSON.parse(result.text) as {
    networks: Record<string, { caip2: string; result: { endpointHost: string } }>;
  };
}

describe('network resource snapshot client routing', () => {
  useTestXdg('network-resource-snapshot-', ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME']);
  useUnsetEnv('CCD_NETWORK');

  beforeEach(() => {
    clientMocks.onQuery = undefined;
    addNetwork('alpha', snapshotNetworkConfig('a', 'alpha.example'));
    addNetwork('zeta', snapshotNetworkConfig('c', 'zeta-old.example'));
  });

  it('keeps the default resource on the startup network while explicit selectors stay fresh', async () => {
    const ctx = context({
      CCD_NETWORK: 'mainnet',
      CCD_GRPC_ENDPOINT: 'startup.example:20000',
      CCD_GRPC_TLS: 'false',
    });
    updateNetwork('testnet', snapshotNetworkConfig('d', 'testnet-new.example'));
    setDefaultNetwork('testnet');
    const resource = registration(ctx, networkResourceFamilies(), 'consensus-status');

    const defaultResult = JSON.parse((await resource.read('ccd://consensus/status')).text) as {
      network: string;
      result: { endpointHost: string };
    };
    const explicitResult = JSON.parse((await resource.read('ccd://testnet/consensus/status')).text) as {
      network: string;
      result: { endpointHost: string };
    };

    expect(defaultResult).toMatchObject({ network: 'mainnet', result: { endpointHost: 'startup.example' } });
    expect(explicitResult).toMatchObject({ network: 'testnet', result: { endpointHost: 'testnet-new.example' } });
  });

  it('uses the wildcard snapshot config when a later name is reassigned during the read', async () => {
    const ctx = context();
    const resource = registration(ctx, networkResourceFamilies(), 'consensus-status');
    clientMocks.onQuery = (host) => {
      if (host === 'alpha.example') updateNetwork('zeta', snapshotNetworkConfig('d', 'zeta-new.example'));
    };

    const result = json(await resource.read('ccd://*/consensus/status'));

    expect(result.networks.zeta).toEqual({
      network: 'zeta',
      caip2: `ccd:${'c'.repeat(32)}`,
      result: { endpointHost: 'zeta-old.example' },
    });
  });

  it.each([
    {
      owner: 'account label',
      families: accountResourceFamilies,
      family: 'account',
      uri: 'ccd://*/account/target',
      oldValue: '32dZpZpu929J81XPFPbBxhwdig3v18U8KnBTXK3vrwdhUAk1Bp',
      newValue: '3DPgLSmDKt7tvAybE95obMXANrUChv5aBpzGPU3qjaG7ERG6JC',
      expected: '32dZpZpu929J81XPFPbBxhwdig3v18U8KnBTXK3vrwdhUAk1Bp',
      install: (label: string, value: string, reference: string) => setSoftAccountLabel(label, value, reference),
      selected: (result: Record<string, unknown>) => result.address,
    },
    {
      owner: 'contract label',
      families: contractResourceFamilies,
      family: 'contract-instance',
      uri: 'ccd://*/contract-instance/target',
      oldValue: { index: '1', subindex: '0' },
      newValue: { index: '9', subindex: '0' },
      expected: '1,0',
      install: (label: string, value: { index: string; subindex: string }, reference: string) =>
        setSoftContractInstanceLabel(label, value, reference),
      selected: (result: Record<string, unknown>) => result.address,
    },
  ])('keeps $owner lookup on the wildcard snapshot chain', async (fixture) => {
    const alphaRef = 'a'.repeat(32);
    const oldZetaRef = 'c'.repeat(32);
    fixture.install('target', fixture.oldValue as never, alphaRef);
    fixture.install('target', fixture.oldValue as never, oldZetaRef);
    const ctx = context();
    clientMocks.onQuery = (host) => {
      if (host !== 'alpha.example') return;
      clientMocks.onQuery = undefined;
      updateNetwork('zeta', snapshotNetworkConfig('d', 'zeta-new.example'));
      fixture.install('target', fixture.newValue as never, caip2Reference(`ccd:${'d'.repeat(32)}`));
    };

    const body = JSON.parse((await registration(ctx, fixture.families(), fixture.family).read(fixture.uri)).text) as {
      networks: Record<string, { result: Record<string, unknown> }>;
    };

    expect(fixture.selected(body.networks.zeta!.result)).toEqual(fixture.expected);
  });

  it('keeps the contract-label catalogue on its resolved network snapshot', async () => {
    const snapshot = resolveNetwork('zeta');
    setSoftContractInstanceLabel('target', { index: '1', subindex: '0' }, 'c'.repeat(32));
    updateNetwork('zeta', snapshotNetworkConfig('d', 'zeta-new.example'));
    setSoftContractInstanceLabel('target', { index: '9', subindex: '0' }, 'd'.repeat(32));
    const family = contractResourceFamilies().find(({ name }) => name === 'contract-instance-labels');
    if (family === undefined) throw new Error('Missing contract-instance-labels resource family.');

    const result = await family.read({ ctx: context(), network: snapshot, parameters: {} });

    expect(result).toEqual({ labels: { target: { index: '1', subindex: '0', address: '1,0' } } });
  });
});
