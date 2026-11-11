import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NetworkConfig } from '@ccd-agent-kit/config-utils';

type ConfigModule = typeof import('@ccd-agent-kit/config-utils');
type GrpcModule = typeof import('../../../src/core/grpc.js');

const config = vi.hoisted(() => ({
  addNetwork: vi.fn<ConfigModule['addNetwork']>(),
  getActiveNetworkFromRegistry: vi.fn<ConfigModule['getActiveNetworkFromRegistry']>(),
  getNetwork: vi.fn<ConfigModule['getNetwork']>(),
  loadNetworks: vi.fn<ConfigModule['loadNetworks']>(),
  removeNetwork: vi.fn<ConfigModule['removeNetwork']>(),
  resolveNetworkFromRegistry: vi.fn<ConfigModule['resolveNetworkFromRegistry']>(),
  setDefaultNetwork: vi.fn<ConfigModule['setDefaultNetwork']>(),
  updateNetwork: vi.fn<ConfigModule['updateNetwork']>(),
}));
const grpc = vi.hoisted(() => ({
  caip2FromGenesis: vi.fn<GrpcModule['caip2FromGenesis']>(),
  queryNodeGenesis: vi.fn<GrpcModule['autoDetectConnection']>(),
}));

vi.mock('@ccd-agent-kit/config-utils', async (importOriginal) => ({
  ...(await importOriginal<ConfigModule>()),
  ...config,
}));
vi.mock('../../../src/core/grpc.js', () => ({
  autoDetectConnection: grpc.queryNodeGenesis,
  caip2FromGenesis: grpc.caip2FromGenesis,
  GrpcConnectionError: class GrpcConnectionError extends Error {},
}));

import { runNetworkCommand } from '../../../src/cli/networkCommand.js';
import { GrpcConnectionError } from '../../../src/core/grpc.js';

const MAINNET_GENESIS = '9dd9ca4d19e9393877d2c44b70f89acbfc0883c2243e5eeaecc0d1cd0503f478';
const mainnet: NetworkConfig = {
  caip2: 'ccd:9dd9ca4d19e9393877d2c44b70f89acb',
  genesisHash: MAINNET_GENESIS,
  grpc: { host: 'node.example', port: 20_000, ssl: true },
};
const DEV_GENESIS = 'aa'.repeat(32);
const ccdDev: NetworkConfig = {
  caip2: `ccd:${DEV_GENESIS.slice(0, 32)}`,
  genesisHash: DEV_GENESIS,
  grpc: { host: 'dev.example', port: 20_001, ssl: false },
};

describe('runNetworkCommand', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    config.loadNetworks.mockReturnValue({ default: 'mainnet', networks: { mainnet } });
    config.getActiveNetworkFromRegistry.mockReturnValue({ config: mainnet, name: 'mainnet', source: 'config' });
    config.resolveNetworkFromRegistry.mockReturnValue({ config: mainnet, name: 'mainnet' });
    config.getNetwork.mockReturnValue(mainnet);
    grpc.caip2FromGenesis.mockImplementation((genesis) => `ccd:${genesis.slice(0, 32)}`);
  });

  it.each<{ source: 'config' | 'session'; activeName: 'mainnet' | 'ccdDev'; activeHeading: string; inactiveHeading: string }>([
    { source: 'config', activeName: 'mainnet', activeHeading: 'mainnet (default)', inactiveHeading: 'ccdDev' },
    { source: 'session', activeName: 'ccdDev', activeHeading: 'ccdDev (default, session)', inactiveHeading: 'mainnet' },
  ])('renders producer-owned built-in and custom data with a $source default', async ({ source, activeName, activeHeading, inactiveHeading }) => {
    config.loadNetworks.mockReturnValue({ default: 'mainnet', networks: { mainnet, ccdDev } });
    config.getActiveNetworkFromRegistry.mockReturnValue({ config: activeName === 'mainnet' ? mainnet : ccdDev, name: activeName, source });

    const result = await run({ kind: 'list' });
    expect(result).toMatchObject({ code: 0, stderr: [] });
    expect(result.stdout).toContain(`  ${activeHeading}`);
    expect(result.stdout).toContain(`  ${inactiveHeading}`);
    expect(result.stdout).toContain('    gRPC:   dev.example:20001 (no-tls)');
    expect(result.stdout).toContain('    gRPC:   node.example:20000 (tls)');
  });

  it('reports an invalid CCD_NETWORK value from the config producer', async () => {
    config.getActiveNetworkFromRegistry.mockImplementationOnce(() => { throw new Error('Invalid CCD_NETWORK'); });

    expect(await run({ kind: 'list' })).toEqual({ code: 1, stderr: ['Invalid CCD_NETWORK'], stdout: [] });
  });

  it.each([
    { name: 'mainnet', network: mainnet, heading: 'Network: mainnet (built-in)', grpcLine: 'gRPC:    node.example:20000 (tls)' },
    { name: 'ccdDev', network: ccdDev, heading: 'Network: ccdDev', grpcLine: 'gRPC:    dev.example:20001 (no-tls)' },
  ])('shows $name details without an update-policy reminder', async ({ name, network, heading, grpcLine }) => {
    config.getNetwork.mockReturnValueOnce(network);
    const result = await run({ kind: 'show', name });

    expect(result).toMatchObject({ code: 0, stderr: [] });
    expect(result.stdout).toContain(heading);
    expect(result.stdout).toContain(grpcLine);
    expect(result.stdout.join('\n')).not.toContain('Identity fields cannot');
  });

  it('maps absent networks and producer failures to command exit codes', async () => {
    config.getNetwork.mockReturnValueOnce(undefined);
    expect(await run({ kind: 'show', name: 'missing' })).toEqual({
      code: 1,
      stderr: ["Network 'missing' not found."],
      stdout: [],
    });

    config.removeNetwork.mockImplementationOnce(() => {
      throw new Error('cannot remove built-in network');
    });
    expect(await run({ kind: 'remove', name: 'mainnet' })).toMatchObject({
      code: 1,
      stderr: ['cannot remove built-in network'],
    });
  });

  it('renders and persists a successful discovery result', async () => {
    grpc.queryNodeGenesis.mockResolvedValue({
      genesisBlock: 'aa'.repeat(32),
      host: 'new.example',
      port: 20_001,
      ssl: false,
    });
    const result = await run({ kind: 'add', name: ' ccdDev ', grpcHost: 'new.example', grpcPort: '20001' });
    expect(result.code).toBe(0);
    expect(config.addNetwork).toHaveBeenCalledWith('ccdDev', {
      caip2: `ccd:${'aa'.repeat(16)}`,
      genesisHash: 'aa'.repeat(32),
      grpc: { host: 'new.example', port: 20_001, ssl: false },
    });
    expect(result.stdout.join('\n')).toContain("Network 'ccdDev' added successfully (ssl: false).");
  });

  it('persists an endpoint update after the node identity matches', async () => {
    grpc.queryNodeGenesis.mockResolvedValue({
      genesisBlock: MAINNET_GENESIS,
      host: 'replacement.example',
      port: 20_001,
      ssl: false,
    });

    const result = await run({ kind: 'update', name: 'mainnet', grpcHost: 'replacement.example', grpcPort: '20001' });

    expect(result).toMatchObject({ code: 0, stderr: [] });
    expect(config.updateNetwork).toHaveBeenCalledWith('mainnet', {
      grpc: { host: 'replacement.example', port: 20_001, ssl: false },
    });
    expect(result.stdout).toContain("Network 'mainnet' updated successfully.");
  });

  it('uses the existing host for a port-only endpoint update', async () => {
    grpc.queryNodeGenesis.mockResolvedValue({
      genesisBlock: MAINNET_GENESIS, host: mainnet.grpc.host, port: 20_002, ssl: false,
    });

    expect((await run({ kind: 'update', name: 'mainnet', grpcPort: '20002' })).code).toBe(0);
    expect(grpc.queryNodeGenesis).toHaveBeenCalledWith(mainnet.grpc.host, 20_002);
    expect(config.updateNetwork).toHaveBeenCalledWith('mainnet', {
      grpc: { host: mainnet.grpc.host, port: 20_002, ssl: false },
    });
  });

  it('does not query or persist when an update has no endpoint options', async () => {
    expect(await run({ kind: 'update', name: 'mainnet', grpcHost: undefined, grpcPort: undefined })).toEqual({
      code: 0,
      stderr: [],
      stdout: ['No changes specified. Use --grpc-host and/or --grpc-port to update.'],
    });
    expect(grpc.queryNodeGenesis).not.toHaveBeenCalled();
    expect(config.updateNetwork).not.toHaveBeenCalled();
  });

  it.each([
    { request: { kind: 'add', name: 'devnet', grpcHost: 'offline.example', grpcPort: '20000' } as const, producer: config.addNetwork },
    { request: { kind: 'update', name: 'mainnet', grpcHost: 'offline.example' } as const, producer: config.updateNetwork },
  ])('does not mutate configuration when $request.kind connection fails', async ({ request, producer }) => {
    grpc.queryNodeGenesis.mockRejectedValueOnce(new GrpcConnectionError('offline'));

    expect(await run(request)).toMatchObject({ code: 1, stderr: ['offline'] });
    expect(producer).not.toHaveBeenCalled();
  });

  it('rejects an update for a missing network before connection or persistence', async () => {
    config.getNetwork.mockReturnValueOnce(undefined);

    expect(await run({ kind: 'update', name: 'missing', grpcPort: '20001' })).toEqual({
      code: 1, stderr: ["Network 'missing' not found."], stdout: [],
    });
    expect(grpc.queryNodeGenesis).not.toHaveBeenCalled();
    expect(config.updateNetwork).not.toHaveBeenCalled();
  });

  it.each([
    { kind: 'add' as const, failure: 'add persistence failed' },
    { kind: 'update' as const, failure: 'update persistence failed' },
  ])('reports $kind persistence failure without success output', async ({ kind, failure }) => {
    grpc.queryNodeGenesis.mockResolvedValue({
      genesisBlock: kind === 'add' ? 'aa'.repeat(32) : MAINNET_GENESIS,
      host: 'node.example', port: 20_001, ssl: true,
    });
    const producer = kind === 'add' ? config.addNetwork : config.updateNetwork;
    producer.mockImplementationOnce(() => { throw new Error(failure); });
    const result = kind === 'add'
      ? await run({ kind, name: 'devnet', grpcHost: 'node.example', grpcPort: '20001' })
      : await run({ kind, name: 'mainnet', grpcHost: 'node.example', grpcPort: '20001' });

    expect(result).toMatchObject({ code: 1, stderr: [failure] });
    expect(result.stdout.join('\n')).not.toMatch(/successfully/i);
  });

  it('rejects an endpoint update when the full genesis hash differs after the CAIP-2 prefix', async () => {
    grpc.queryNodeGenesis.mockResolvedValue({
      genesisBlock: `${MAINNET_GENESIS.slice(0, 32)}${'00'.repeat(16)}`,
      host: 'replacement.example',
      port: 20_001,
      ssl: false,
    });

    const result = await run({ kind: 'update', name: 'mainnet', grpcHost: 'replacement.example' });

    expect(result.code).toBe(1);
    expect(result.stderr.join('\n')).toContain('Genesis hash mismatch');
    expect(result.stderr.join('\n')).toContain(`expected ${MAINNET_GENESIS}, got ${MAINNET_GENESIS.slice(0, 32)}${'00'.repeat(16)}`);
    expect(config.updateNetwork).not.toHaveBeenCalled();
  });

  it('selects the requested default through the config producer', async () => {
    const result = await run({ kind: 'default', name: 'mainnet' });

    expect(result).toEqual({ code: 0, stderr: [], stdout: ["Default network set to 'mainnet'."] });
    expect(config.setDefaultNetwork).toHaveBeenCalledWith('mainnet');
  });

  it.each([
    ['mainnet', { mainnet }],
    ['ccdDev', { mainnet, ccdDev }],
  ] as const)('shows only the persisted %s default without applying environment/session overrides', async (name, networks) => {
    config.loadNetworks.mockReturnValue({ default: name, networks });
    config.getActiveNetworkFromRegistry.mockImplementation(() => {
      throw new Error('CCD_NETWORK must not affect persisted default display');
    });

    expect(await run({ kind: 'default-show' })).toEqual({
      code: 0,
      stderr: [],
      stdout: [`Default network: ${name}`],
    });
    expect(config.getActiveNetworkFromRegistry).not.toHaveBeenCalled();
    expect(config.getNetwork).not.toHaveBeenCalled();
  });

  it('reports a default-network persistence failure', async () => {
    config.setDefaultNetwork.mockImplementationOnce(() => { throw new Error('default persistence failed'); });

    expect(await run({ kind: 'default', name: 'mainnet' })).toEqual({
      code: 1, stderr: ['default persistence failed'], stdout: [],
    });
  });

  it('removes a named network through the config producer', async () => {
    expect(await run({ kind: 'remove', name: 'ccdDev' })).toEqual({
      code: 0, stderr: [], stdout: ["Network 'ccdDev' removed."],
    });
    expect(config.removeNetwork).toHaveBeenCalledWith('ccdDev');
  });

  it('reports a healthy doctor result when the queried node identity matches', async () => {
    grpc.queryNodeGenesis.mockResolvedValue({
      genesisBlock: MAINNET_GENESIS,
      host: mainnet.grpc.host,
      port: mainnet.grpc.port,
      ssl: true,
    });

    const result = await run({ kind: 'doctor' });

    expect(result).toMatchObject({ code: 0, stderr: [] });
    expect(config.resolveNetworkFromRegistry).toHaveBeenCalledWith(undefined, expect.any(Object));
    expect(grpc.queryNodeGenesis).toHaveBeenCalledWith(mainnet.grpc.host, mainnet.grpc.port);
    expect(result.stdout).toContain('Network endpoint looks healthy.');
  });

  it('rejects a doctor result whose queried node identity differs', async () => {
    const otherGenesis = '42'.repeat(32);
    grpc.queryNodeGenesis.mockResolvedValue({
      genesisBlock: otherGenesis,
      host: mainnet.grpc.host,
      port: mainnet.grpc.port,
      ssl: true,
    });

    const result = await run({ kind: 'doctor', name: 'mainnet' });

    expect(result.code).toBe(1);
    expect(result.stderr.join('\n')).toContain('Genesis hash mismatch');
    expect(result.stderr.join('\n')).toContain(`got ${otherGenesis}`);
  });

  it('reports doctor unhealthy when the full genesis hash differs after the CAIP-2 prefix', async () => {
    grpc.queryNodeGenesis.mockResolvedValue({
      genesisBlock: `${MAINNET_GENESIS.slice(0, 32)}${'00'.repeat(16)}`,
      host: mainnet.grpc.host,
      port: mainnet.grpc.port,
      ssl: true,
    });

    const result = await run({ kind: 'doctor', name: 'mainnet' });

    expect(result.code).toBe(1);
    expect(result.stderr.join('\n')).toContain('Genesis hash mismatch');
    expect(result.stdout).not.toContain('Network endpoint looks healthy.');
  });

  it('reports default-network resolution errors before querying a node', async () => {
    config.resolveNetworkFromRegistry.mockImplementationOnce(() => { throw new Error('default network is invalid'); });

    expect(await run({ kind: 'doctor' })).toEqual({ code: 2, stderr: ['default network is invalid'], stdout: [] });
    expect(grpc.queryNodeGenesis).not.toHaveBeenCalled();
  });

  it('reports an explicitly requested network missing from the registry', async () => {
    expect(await run({ kind: 'doctor', name: 'missing' })).toEqual({
      code: 1, stderr: ["Network 'missing' not found."], stdout: [],
    });
    expect(grpc.queryNodeGenesis).not.toHaveBeenCalled();
  });

  it.each([
    { request: { kind: 'show', name: 'bad name' } as const, producer: config.getNetwork },
    { request: { kind: 'add', name: 'bad name', grpcHost: 'node.example', grpcPort: '20000' } as const, producer: config.addNetwork },
    { request: { kind: 'update', name: 'bad name' } as const, producer: config.getNetwork },
    { request: { kind: 'remove', name: 'bad name' } as const, producer: config.removeNetwork },
    { request: { kind: 'default', name: 'bad name' } as const, producer: config.setDefaultNetwork },
    { request: { kind: 'doctor', name: 'bad name' } as const, producer: grpc.queryNodeGenesis },
  ])('rejects an invalid raw name for $request.kind before domain work', async ({ request, producer }) => {
    const result = await run(request);

    expect(result.code).toBe(2);
    expect(result.stderr.join('\n')).toContain('letters, digits, underscores, or hyphens');
    expect(producer).not.toHaveBeenCalled();
  });

  it.each([
    { request: { kind: 'add', name: 'ccdDev', grpcHost: '   ', grpcPort: '20000' } as const, producer: config.addNetwork },
    { request: { kind: 'update', name: 'mainnet', grpcHost: '' } as const, producer: config.updateNetwork },
  ])('rejects a blank host for $request.kind before connecting or writing', async ({ request, producer }) => {
    const result = await run(request);

    expect(result.code).toBe(2);
    expect(grpc.queryNodeGenesis).not.toHaveBeenCalled();
    expect(producer).not.toHaveBeenCalled();
  });

  it('rejects an invalid update port before connecting or writing', async () => {
    const result = await run({ kind: 'update', name: 'mainnet', grpcPort: '65536' });

    expect(result.code).toBe(2);
    expect(result.stderr.join('\n')).toContain('Invalid port number');
    expect(grpc.queryNodeGenesis).not.toHaveBeenCalled();
    expect(config.updateNetwork).not.toHaveBeenCalled();
  });

  it('renders validation and connection failures without calling mutation producers', async () => {
    const invalid = await run({ kind: 'add', name: 'devnet', grpcHost: 'node.example', grpcPort: '0' });
    expect(invalid.code).toBe(2);
    expect(invalid.stderr.join('\n')).toContain('Invalid port number');

    grpc.queryNodeGenesis.mockRejectedValueOnce(new GrpcConnectionError('offline'));
    const offline = await run({ kind: 'doctor', name: 'mainnet' });
    expect(offline).toMatchObject({ code: 1, stderr: ['offline'] });
  });

});

async function run(request: Parameters<typeof runNetworkCommand>[0]['request']) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await runNetworkCommand({ request, stdout, stderr });
  return { code, stderr, stdout };
}
