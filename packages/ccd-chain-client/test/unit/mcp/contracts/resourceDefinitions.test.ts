import { Buffer } from 'node:buffer';
import type { ContractInstanceLabelScopeMatch, ResolvedNetwork } from '@ccd-agent-kit/config-utils';
import type { ContractInstanceAddress } from '@ccd-agent-kit/sdk-utils';
import { describe, expect, it, vi } from 'vitest';
import { contractResourceFamilies } from '../../../../src/mcp/contracts/resourceDefinitions.js';
import type { ToolContext } from '../../../../src/mcp/toolPlumbing/toolTypes.js';
import { domainFamily, readDomainResource } from '../../../helpers/domainResources.js';
import { schemaFunction, schemaMap, schemaOption } from '../../../helpers/schema.js';
import { FakeConcordiumClient, makeContext } from '../../../helpers/fakes.js';

const MODULE_REF = 'aa'.repeat(32);
const OWNER = '32dZpZpu929J81XPFPbBxhwdig3v18U8KnBTXK3vrwdhUAk1Bp';
const NETWORK_REFS = { mainnet: '11'.repeat(16), testnet: '22'.repeat(16), empty: '33'.repeat(16) } as const;
const CONTRACT_INSTANCE = {
  index: '7', subindex: '0', moduleRef: MODULE_REF, owner: OWNER, amount: '123', name: 'counter',
};
const INSTANCE_SCHEMA_CONTEXT = {
  address: '7,0', moduleRef: MODULE_REF, contract: { name: 'counter' },
};

const mocks = vi.hoisted(() => ({
  listContractInstanceLabelsForNetwork:
    vi.fn<(network: string | ResolvedNetwork) => Record<string, { index: string; subindex: string }>>(),
  listSortedNetworks: vi.fn(() => ['mainnet', 'testnet', 'empty']),
  resolveContractInstanceLabel: vi.fn<(label: string, caip2Ref?: string) => ContractInstanceAddress | undefined>(
    () => undefined,
  ),
  findContractInstanceLabelForAddress: vi.fn<
    (address: ContractInstanceAddress, caip2Ref?: string) => string | undefined
  >(() => undefined),
  findContractInstanceLabelScopes: vi.fn<(label: string) => ContractInstanceLabelScopeMatch[]>(() => []),
  resolveNetwork: vi.fn<(network?: string) => ResolvedNetwork>((network = 'testnet') => ({
    name: network,
    config: {
      caip2: `ccd:${NETWORK_REFS[network as keyof typeof NETWORK_REFS] ?? NETWORK_REFS.testnet}`,
      genesisHash: '00'.repeat(32),
      grpc: { host: 'localhost', port: 20_000, ssl: false },
    },
  })),
}));

vi.mock('@ccd-agent-kit/config-utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ccd-agent-kit/config-utils')>()),
  getNetwork: vi.fn((network: keyof typeof NETWORK_REFS) => ({ caip2: `ccd:${NETWORK_REFS[network]}` })),
  listSortedNetworks: mocks.listSortedNetworks,
  resolveContractInstanceLabel: mocks.resolveContractInstanceLabel,
  findContractInstanceLabelForAddress: mocks.findContractInstanceLabelForAddress,
  findContractInstanceLabelScopes: mocks.findContractInstanceLabelScopes,
  resolveNetwork: mocks.resolveNetwork,
}));
vi.mock('../../../../src/mcp/contracts/contractInstanceLabels.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../src/mcp/contracts/contractInstanceLabels.js')>()),
  listContractInstanceLabelsForNetwork: mocks.listContractInstanceLabelsForNetwork,
}));

function contractSchemaHex(input: {
  init?: Buffer;
  entrypoints: Array<[string, Buffer]>;
  events?: Buffer;
}): string {
  const contract = Buffer.concat([
    schemaOption(input.init === undefined ? undefined : schemaFunction(0, input.init)),
    schemaMap(input.entrypoints),
    schemaOption(input.events),
  ]);
  return Buffer.concat([Buffer.from([255, 255, 3]), schemaMap([['counter', contract]])]).toString('hex');
}

function schemaHex(): string {
  return contractSchemaHex({
    init: Buffer.from([1]),
    entrypoints: [['get', schemaFunction(1, Buffer.from([5]))]],
    events: Buffer.from([1]),
  });
}

function schemaWithoutInitOrEventsHex(): string {
  return contractSchemaHex({ entrypoints: [['ping', schemaFunction(0, Buffer.from([1]))]] });
}

function richSchemaHex(): string {
  return contractSchemaHex({
    init: Buffer.from([1]),
    entrypoints: [
      ['zeta', schemaFunction(0, Buffer.from([2]))],
      ['alpha', schemaFunction(6, Buffer.from([1]), Buffer.from([5]), Buffer.from([2]))],
    ],
    events: Buffer.from([2]),
  });
}

function moduleInterface(entrypoints = ['get']) {
  return {
    moduleRef: MODULE_REF,
    version: 1 as const,
    sourceSizeBytes: 12,
    schemaAvailable: false,
    contracts: [{ name: 'counter', entrypoints }],
  };
}

function read(name: string, ctx: ToolContext, parameters: Record<string, string> = {}, network?: string) {
  return readDomainResource(contractResourceFamilies(), name, ctx, { parameters, ...(network && { network }) });
}

function readContract(
  name: string,
  ctx: ToolContext,
  parameters: Record<string, string> = {},
  network?: string,
) {
  return read(name, ctx, { moduleRef: MODULE_REF, contractName: 'counter', ...parameters }, network);
}

describe('contract resource definitions', () => {
  it('routes default and network-qualified schema captures to the selected schema', async () => {
    const client = new FakeConcordiumClient({ moduleSchemas: { [MODULE_REF]: schemaHex() } });
    const getSchema = vi.spyOn(client, 'getModuleSchema');
    const ctx = makeContext(client, { network: 'testnet' });

    await expect(readContract('module-contract-receive-schema', ctx, {
      entrypoint: 'get',
    })).resolves.toEqual({
      module: { moduleRef: MODULE_REF },
      schemaAvailable: true,
      contract: { name: 'counter' },
      entrypoint: 'get',
      returnValue: { kind: 'primitive', type: 'U64' },
    });
    await expect(readContract('module-contract-init-schema', ctx, {}, 'mainnet')).resolves.toMatchObject({
      parameter: { kind: 'primitive', type: 'Bool' },
    });
    expect(getSchema).toHaveBeenCalledTimes(2);
    expect(client.calls.getModuleInterface ?? 0).toBe(0);
  });

  it('reports unavailable focused schemas after validating the contract interface', async () => {
    const client = new FakeConcordiumClient({
      moduleInterfaces: {
        [MODULE_REF]: {
          moduleRef: MODULE_REF,
          version: 1,
          sourceSizeBytes: 12,
          schemaAvailable: false,
          contracts: [{ name: 'counter', entrypoints: ['get'] }],
        },
      },
    });

    const result = await readContract('module-contract-receive-schema', makeContext(client), {
      entrypoint: 'get',
    });

    expect(result).toEqual({
      module: { moduleRef: MODULE_REF },
      contract: { name: 'counter' },
      schemaAvailable: false,
      entrypoint: 'get',
    });
    expect(client.calls.getModuleInterface).toBe(1);
  });

  it('reports every unavailable focused schema and rejects an unknown receive entrypoint', async () => {
    const client = new FakeConcordiumClient({ moduleInterfaces: { [MODULE_REF]: moduleInterface(['get']) } });
    const ctx = makeContext(client);

    for (const kind of ['init', 'events'] as const) {
      await expect(readContract(`module-contract-${kind}-schema`, ctx)).resolves.toEqual({
        module: { moduleRef: MODULE_REF }, contract: { name: 'counter' }, schemaAvailable: false,
      });
    }
    await expect(
      readContract('module-contract-receive-schema', ctx, {
        entrypoint: 'missing',
      }),
    ).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    expect(client.calls.getModuleInterface).toBe(3);
  });

  it('rejects contracts missing from either the interface or embedded schema and missing schema entrypoints', async () => {
    const withoutInterfaceContract = new FakeConcordiumClient({
      moduleInterfaces: { [MODULE_REF]: { ...moduleInterface(), contracts: [] } },
    });
    await expect(
      readContract('module-contract', makeContext(withoutInterfaceContract)),
    ).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });

    const withSchema = new FakeConcordiumClient({ moduleSchemas: { [MODULE_REF]: schemaHex() } });
    await expect(
      read('module-contract-init-schema', makeContext(withSchema), {
        moduleRef: MODULE_REF, contractName: 'absent',
      }),
    ).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    await expect(
      readContract('module-contract-receive-schema', makeContext(withSchema), {
        entrypoint: 'missing',
      }),
    ).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
  });

  it('projects rich schemas and sorts receive entrypoints in contract summaries', async () => {
    const client = new FakeConcordiumClient({
      moduleSchemas: { [MODULE_REF]: richSchemaHex() },
      moduleInterfaces: { [MODULE_REF]: moduleInterface(['zeta', 'alpha']) },
    });
    const ctx = makeContext(client);

    await expect(readContract('module-contract', ctx, {}, 'mainnet')).resolves.toEqual({
      module: { moduleRef: MODULE_REF },
      contract: {
        name: 'counter',
        schemaAvailable: true,
        hasInit: true,
        hasEvents: true,
        entrypoints: [
          { name: 'alpha', hasParameter: true, hasReturnValue: true, hasError: true },
          { name: 'zeta', hasParameter: true, hasReturnValue: false, hasError: false },
        ],
      },
    });
    await expect(readContract('module-contract-events-schema', ctx)).resolves.toMatchObject({
      events: { kind: 'primitive', type: 'U8' },
    });
    await expect(readContract('module-contract-receive-schema', ctx, {
      entrypoint: 'counter.alpha',
    }, 'testnet')).resolves.toMatchObject({
      entrypoint: 'alpha',
      parameter: { kind: 'primitive', type: 'Bool' },
      returnValue: { kind: 'primitive', type: 'U64' },
      error: { kind: 'primitive', type: 'U8' },
    });
  });

  it('omits absent init and event schemas from summaries and focused resources', async () => {
    const client = new FakeConcordiumClient({
      moduleSchemas: { [MODULE_REF]: schemaWithoutInitOrEventsHex() },
      moduleInterfaces: {
        [MODULE_REF]: {
          moduleRef: MODULE_REF,
          version: 1,
          sourceSizeBytes: 12,
          schemaAvailable: true,
          contracts: [{ name: 'counter', entrypoints: ['ping'] }],
        },
      },
    });
    const ctx = makeContext(client);

    await expect(readContract('module-contract', ctx)).resolves.toMatchObject({
      contract: { name: 'counter', hasInit: false, hasEvents: false },
    });
    for (const kind of ['init', 'events'] as const) {
      await expect(readContract(`module-contract-${kind}-schema`, ctx)).resolves.toEqual({
        module: { moduleRef: MODULE_REF }, schemaAvailable: true, contract: { name: 'counter' },
      });
    }
  });

  it('projects representative module catalog, module, and labeled instance data', async () => {
    mocks.findContractInstanceLabelForAddress.mockReturnValue('local-counter');
    const client = new FakeConcordiumClient({
      moduleRefs: [MODULE_REF],
      moduleInterfaces: { [MODULE_REF]: moduleInterface() },
      instances: { '7,0': { ...CONTRACT_INSTANCE, methods: ['counter.get'] } },
    });
    const ctx = makeContext(client, { network: 'testnet' });

    await expect(read('modules', ctx)).resolves.toEqual({ modules: [MODULE_REF] });
    await expect(read('module', ctx, { moduleRef: MODULE_REF })).resolves.toEqual(moduleInterface());
    await expect(read('contract-instance', ctx, { addressOrLabel: '7,0' }, 'mainnet')).resolves.toEqual({
      address: '7,0',
      label: 'local-counter',
      moduleRef: MODULE_REF,
      owner: OWNER,
      amount: '123',
      contract: { name: 'counter', entrypoints: ['counter.get'] },
    });
    mocks.findContractInstanceLabelForAddress.mockReturnValue(undefined);
  });

  it.each([
    ['one other network', ['mainnet']],
    ['multiple other networks', ['staging', 'mainnet', 'devnet']],
  ])('diagnoses an instance label found on %s', async (_case, networks) => {
    mocks.findContractInstanceLabelScopes.mockReturnValueOnce(
      networks.map((network, index) => ({
        scope: 'network',
        network,
        caip2Ref: `${index}`.repeat(32),
        label: 'remote-counter',
        address: { index: `${index + 1}`, subindex: '0' },
      })),
    );

    const result = read('contract-instance', makeContext(new FakeConcordiumClient(), { network: 'testnet' }), {
      addressOrLabel: 'remote-counter',
    });

    await expect(result).rejects.toMatchObject({ kind: 'invalid-argument' });
    for (const network of networks)
      await expect(result).rejects.toHaveProperty('message', expect.stringContaining(network));
  });

  it('adds instance metadata to schema resources on default and explicit routes', async () => {
    const client = new FakeConcordiumClient({
      moduleSchemas: { [MODULE_REF]: richSchemaHex() },
      instances: {
        '7,0': { ...CONTRACT_INSTANCE, methods: ['counter.alpha'] },
      },
    });
    const ctx = makeContext(client, { network: 'testnet' });

    await expect(read('contract-instance-init-schema', ctx, {
      addressOrLabel: '7,0',
    })).resolves.toMatchObject({
      parameter: { kind: 'primitive', type: 'Bool' },
      instance: INSTANCE_SCHEMA_CONTEXT,
    });
    await expect(read('contract-instance-events-schema', ctx, {
      addressOrLabel: '7,0',
    }, 'mainnet')).resolves.toMatchObject({
      events: { kind: 'primitive', type: 'U8' },
      instance: INSTANCE_SCHEMA_CONTEXT,
    });
    await expect(read('contract-instance-receive-schema', ctx, {
      addressOrLabel: '7,0', entrypoint: 'alpha',
    })).resolves.toMatchObject({
      entrypoint: 'alpha',
      returnValue: { kind: 'primitive', type: 'U64' },
      instance: INSTANCE_SCHEMA_CONTEXT,
    });
  });

  it('sorts configured-label listings and expands default instance resource URIs', async () => {
    mocks.listContractInstanceLabelsForNetwork.mockImplementation((network) =>
      (typeof network === 'string' ? network : network.name) === 'testnet'
        ? { zeta: { index: '9', subindex: '1' }, alpha: { index: '7', subindex: '0' } } : {},
    );
    const ctx = makeContext(new FakeConcordiumClient(), { network: 'testnet' });

    await expect(read('contract-instance-labels', ctx, {}, 'testnet')).resolves.toMatchObject({
      labels: { alpha: { address: '7,0' }, zeta: { address: '9,1' } },
    });
    await expect(domainFamily(contractResourceFamilies(), 'contract-instance').listDefault?.(ctx)).resolves.toEqual([
      { uri: 'ccd://contract-instance/alpha', name: 'Concordium Contract Instance alpha' },
      { uri: 'ccd://contract-instance/7,0', name: 'Concordium Contract Instance 7,0' },
      { uri: 'ccd://contract-instance/alpha/init/schema', name: 'Concordium Contract Instance Init Schema alpha' },
      { uri: 'ccd://contract-instance/zeta', name: 'Concordium Contract Instance zeta' },
      { uri: 'ccd://contract-instance/9,1', name: 'Concordium Contract Instance 9,1' },
      { uri: 'ccd://contract-instance/zeta/init/schema', name: 'Concordium Contract Instance Init Schema zeta' },
    ]);
  });

});
