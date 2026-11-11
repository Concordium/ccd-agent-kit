import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Command, CommanderError } from 'commander';
import type { NetworksFile, ResolvedNetwork } from '@ccd-agent-kit/config-utils';
import type { ContractInstanceAddress } from '@ccd-agent-kit/sdk-utils';

type Config = typeof import('@ccd-agent-kit/config-utils');
const config = vi.hoisted(() => ({
  findContractInstanceLabelForAddress: vi.fn(),
  findContractInstanceLabelScopes: vi.fn(),
  loadContractInstanceLabels: vi.fn(),
  loadNetworks: vi.fn(),
  resolveContractInstanceLabel: vi.fn(),
  resolveNetworkFromRegistry: vi.fn(),
  setContractInstanceLabel: vi.fn(),
}));
const sdk = vi.hoisted(() => ({
  format: vi.fn(),
  require: vi.fn(),
}));

vi.mock('@ccd-agent-kit/config-utils', async (importOriginal) => ({
  ...await importOriginal<Config>(),
  ...config,
}));
vi.mock('@ccd-agent-kit/sdk-utils', async (importOriginal) => ({
  ...await importOriginal<typeof import('@ccd-agent-kit/sdk-utils')>(),
  contractInstance: sdk,
}));
vi.mock('../../../src/core/grpc.js', () => ({ caip2Reference: (caip2: string) => caip2.slice(4) }));

import { registerContractInstanceCliCommand } from '../../../src/cli/contractInstanceCliCommand.js';

const ADDRESS = { index: '7', subindex: '0' } as const;
const OTHER_ADDRESS = { index: '8', subindex: '1' } as const;
const networkConfig = (ref: string) => ({
  caip2: `ccd:${ref}`, genesisHash: ref.repeat(2), grpc: { host: 'node', port: 20_000, ssl: true },
});
const registry: NetworksFile = {
  default: 'mainnet',
  networks: { testnet: networkConfig('testnet-ref'), mainnet: networkConfig('mainnet-ref') },
};
const mainnet: ResolvedNetwork = { name: 'mainnet', config: registry.networks.mainnet! };

describe('contract-instance CLI', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    sdk.require.mockImplementation((value: string) => value === '8.1' ? OTHER_ADDRESS : ADDRESS);
    sdk.format.mockImplementation((value: ContractInstanceAddress) => `${value.index},${value.subindex}`);
    config.loadNetworks.mockReturnValue(registry);
    config.resolveNetworkFromRegistry.mockReturnValue(mainnet);
    config.loadContractInstanceLabels.mockReturnValue({});
    config.findContractInstanceLabelScopes.mockReturnValue([]);
  });

  it('selects the default, an explicit network, or every sorted scope without rewriting selectors', async () => {
    await run(['list']);
    expect(config.resolveNetworkFromRegistry).toHaveBeenLastCalledWith(undefined, registry);
    await run(['list', '--network', 'chosen']);
    expect(config.resolveNetworkFromRegistry).toHaveBeenLastCalledWith('chosen', registry);

    config.loadContractInstanceLabels.mockClear();
    const all = await run(['list', '--all-networks']);
    expect(all.stdout.indexOf('mainnet:')).toBeLessThan(all.stdout.indexOf('testnet:'));
    expect(config.loadContractInstanceLabels.mock.calls.map(([ref]) => ref)).toEqual(['mainnet-ref', 'testnet-ref']);
  });

  it('rejects conflicting scope flags before reading configuration state', async () => {
    const result = await run(['list', '--network', 'mainnet', '--all-networks']);
    expect(result.error).toMatchObject({ exitCode: 2 });
    expect(config.loadNetworks).not.toHaveBeenCalled();
    expect(config.loadContractInstanceLabels).not.toHaveBeenCalled();
  });

  it('lists bare hard and soft labels with canonical addresses', async () => {
    config.loadContractInstanceLabels.mockReturnValue({ operator: ADDRESS, '@agent': OTHER_ADDRESS });
    const result = await run(['list']);
    expect(result.stdout).toContain('  agent            8,1');
    expect(result.stdout).toContain('  operator         7,0');
    expect(result.stdout).not.toContain('@agent');
  });

  it('inspects a normalized selector from one catalog snapshot and prints stored spelling', async () => {
    config.loadContractInstanceLabels.mockImplementation((ref: string) =>
      ref === 'testnet-ref' ? { TOKEN: OTHER_ADDRESS } : { Token: ADDRESS });
    const single = await run(['inspect', '--label', ' token ']);
    expect(config.loadContractInstanceLabels).toHaveBeenCalledOnce();
    expect(config.loadContractInstanceLabels).toHaveBeenCalledWith('mainnet-ref');
    expect(config.resolveContractInstanceLabel).not.toHaveBeenCalled();
    expect(config.findContractInstanceLabelForAddress).not.toHaveBeenCalled();
    expect(single.stdout).toEqual(expect.arrayContaining(['Label:   Token', 'Address: 7,0']));

    config.loadContractInstanceLabels.mockClear();
    const all = await run(['inspect', '--label', ' token ', '--all-networks']);
    expect(config.loadContractInstanceLabels.mock.calls).toEqual([['mainnet-ref'], ['testnet-ref']]);
    expect(all.stdout).toContain("Contract instance label 'token':");
  });

  it('finds one bare label or all network matches from a parsed address', async () => {
    config.findContractInstanceLabelForAddress.mockImplementation((_address: typeof ADDRESS, ref: string) =>
      ref === 'mainnet-ref' ? 'operator' : undefined);
    const single = await run(['find', '--address', '7,0']);
    expect(sdk.require).toHaveBeenCalledWith('7,0');
    expect(single.stdout).toContain('Label:   operator');
    expect(config.findContractInstanceLabelForAddress).toHaveBeenCalledTimes(1);

    config.findContractInstanceLabelForAddress.mockClear();
    const all = await run(['find', '--address', '7,0', '--all-networks']);
    expect(all.stdout).toEqual(expect.arrayContaining(['mainnet:', '  operator']));
    expect(config.findContractInstanceLabelForAddress).toHaveBeenCalledTimes(2);
  });

  it('reports lookup misses with exit one and only other-network diagnostics', async () => {
    config.resolveContractInstanceLabel.mockReturnValue(undefined);
    config.findContractInstanceLabelScopes.mockReturnValue([
      { scope: 'network', network: 'mainnet', caip2Ref: 'mainnet-ref', label: 'token', address: ADDRESS },
      { scope: 'network', network: 'testnet', caip2Ref: 'testnet-ref', label: 'token', address: OTHER_ADDRESS },
    ]);
    const missing = await run(['inspect', '--label', 'token']);
    expect(missing.error).toMatchObject({ exitCode: 1 });
    expect(missing.stderr).toContain('It exists for testnet.');
    expect(missing.stderr.join('\n')).not.toContain('mainnet and');

    config.findContractInstanceLabelForAddress.mockReturnValue(undefined);
    expect((await run(['find', '--address', '7,0'])).error).toMatchObject({ exitCode: 1 });
  });

  it('maps producer failures to exit two while preserving classified command errors', async () => {
    config.loadContractInstanceLabels.mockImplementationOnce(() => { throw new Error('disk failed'); });
    const failed = await run(['list']);
    expect(failed.error).toMatchObject({ exitCode: 2 });
    expect(failed.stderr).toContain('disk failed');

    config.loadContractInstanceLabels.mockImplementationOnce(() => {
      throw new CommanderError(7, 'existing', 'already classified');
    });
    expect((await run(['inspect', '--label', 'token'])).error).toMatchObject({ exitCode: 7, code: 'existing' });
  });

  it('validates address and mode before writes', async () => {
    sdk.require.mockImplementationOnce(() => { throw new Error('Invalid contract instance address.'); });
    expect((await run(['set', '--address', 'bad', '--label', 'token', '--mode', 'hard'])).error).toBeDefined();
    expect(config.setContractInstanceLabel).not.toHaveBeenCalled();

    const mode = await run(['set', '--address', '7,0', '--label', 'token', '--mode', 'invalid']);
    expect(String(mode.error)).toContain("Mode must be 'hard' or 'soft'.");
    expect(config.setContractInstanceLabel).not.toHaveBeenCalled();
  });

  it('delegates set policy without reading the current label', async () => {
    config.setContractInstanceLabel.mockReturnValueOnce({ label: 'StoredToken', mode: 'hard' });
    const set = await run(['set', '--address', '7,0', '--label', ' token ', '--mode', 'soft']);
    expect(config.setContractInstanceLabel).toHaveBeenCalledWith({ address: ADDRESS, label: 'token', mode: 'soft' }, 'mainnet-ref');
    expect(JSON.parse(set.stdout.join('\n'))).toEqual({ address: '7,0', label: 'StoredToken', mode: 'hard' });

    config.setContractInstanceLabel.mockReturnValueOnce({ label: 'StoredToken', mode: 'hard' });
    await run(['set', '--address', '8.1', '--mode', 'hard']);
    expect(config.setContractInstanceLabel).toHaveBeenLastCalledWith({ address: OTHER_ADDRESS, mode: 'hard' }, 'mainnet-ref');

    config.setContractInstanceLabel.mockReturnValueOnce({ label: 'NewToken', mode: 'hard' });
    await run(['set', '--address', '7,0', '--label', 'NewToken']);
    expect(config.setContractInstanceLabel).toHaveBeenLastCalledWith({ address: ADDRESS, label: 'NewToken' }, 'mainnet-ref');
    expect(config.findContractInstanceLabelForAddress).not.toHaveBeenCalled();
  });

  it('prints no success on writer failure and removes by canonical address', async () => {
    config.setContractInstanceLabel.mockImplementationOnce(() => { throw new Error('write failed'); });
    const failed = await run(['set', '--address', '7,0', '--label', 'token', '--mode', 'hard']);
    expect(failed.error).toBeDefined();
    expect(failed.stdout).toEqual([]);

    const removed = await run(['remove', '--address', '8.1']);
    expect(config.setContractInstanceLabel).toHaveBeenLastCalledWith({ address: OTHER_ADDRESS, operation: 'remove' }, 'mainnet-ref');
    expect(JSON.parse(removed.stdout.join('\n'))).toEqual({ address: '8,1' });
  });

});

async function run(args: string[]) {
  return runProgram(['contract-instance', 'label', ...args]);
}

async function runProgram(args: string[]) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const program = new Command().exitOverride().configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerContractInstanceCliCommand({ program, stdout, stderr });
  let error: unknown;
  try { await program.parseAsync(args, { from: 'user' }); }
  catch (cause) { error = cause; }
  return { error, stderr, stdout };
}
