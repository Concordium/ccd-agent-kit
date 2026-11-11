import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Command, CommanderError } from 'commander';
import type { AccountLabelMap, AccountLabelScopeMatch, NetworksFile, ResolvedNetwork } from '@ccd-agent-kit/config-utils';

type Config = typeof import('@ccd-agent-kit/config-utils');
const config = vi.hoisted(() => ({
  findAccountLabelForAddress: vi.fn<Config['findAccountLabelForAddress']>(),
  findAccountLabelScopes: vi.fn<Config['findAccountLabelScopes']>(),
  loadAccountLabels: vi.fn<Config['loadAccountLabels']>(),
  loadNetworks: vi.fn<Config['loadNetworks']>(),
  resolveAccountLabel: vi.fn<Config['resolveAccountLabel']>(),
  resolveNetworkFromRegistry: vi.fn<Config['resolveNetworkFromRegistry']>(),
  setAccountLabel: vi.fn<Config['setAccountLabel']>(),
}));

vi.mock('@ccd-agent-kit/config-utils', async (importOriginal) => ({
  ...await importOriginal<Config>(),
  ...config,
}));
vi.mock('../../../src/core/grpc.js', () => ({ caip2Reference: (caip2: string) => caip2.slice(4) }));

import { registerAccountLabelCliCommand } from '../../../src/cli/accountLabelCliCommand.js';

const ADDRESS = '32dZpZpu929J81XPFPbBxhwdig3v18U8KnBTXK3vrwdhUAk1Bp';
const OTHER_ADDRESS = '3DPgLSmDKt7tvAybE95obMXANrUChv5aBpzGPU3qjaG7ERG6JC';
const networkConfig = (ref: string) => ({
  caip2: `ccd:${ref}`, genesisHash: ref.repeat(2), grpc: { host: 'node', port: 20_000, ssl: true },
});
const registry: NetworksFile = {
  default: 'mainnet',
  networks: { testnet: networkConfig('testnet-ref'), mainnet: networkConfig('mainnet-ref') },
};
const mainnet: ResolvedNetwork = { name: 'mainnet', config: registry.networks.mainnet! };

describe('account-label CLI', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    config.loadNetworks.mockReturnValue(registry);
    config.resolveNetworkFromRegistry.mockReturnValue(mainnet);
    config.loadAccountLabels.mockReturnValue({});
    config.findAccountLabelScopes.mockReturnValue([]);
  });

  it('selects the default, an explicit network, or every sorted scope without rewriting selectors', async () => {
    await run(['list']);
    expect(config.resolveNetworkFromRegistry).toHaveBeenLastCalledWith(undefined, registry);
    await run(['list', '--network', 'chosen']);
    expect(config.resolveNetworkFromRegistry).toHaveBeenLastCalledWith('chosen', registry);

    config.loadAccountLabels.mockClear();
    const all = await run(['list', '--all-networks']);
    expect(all.stdout.indexOf('mainnet:')).toBeLessThan(all.stdout.indexOf('testnet:'));
    expect(config.loadAccountLabels.mock.calls.map(([ref]) => ref)).toEqual(['mainnet-ref', 'testnet-ref']);
  });

  it('rejects conflicting scope flags before reading any configuration state', async () => {
    const result = await run(['list', '--network', 'mainnet', '--all-networks']);
    expect(result.error).toMatchObject({ exitCode: 2 });
    expect(config.loadNetworks).not.toHaveBeenCalled();
    expect(config.loadAccountLabels).not.toHaveBeenCalled();
  });

  it('lists bare hard and soft labels while preserving addresses', async () => {
    config.loadAccountLabels.mockReturnValue({ operator: ADDRESS, '@agent': OTHER_ADDRESS });
    const result = await run(['list']);
    expect(result.stdout).toContain(`  agent            ${OTHER_ADDRESS}`);
    expect(result.stdout).toContain(`  operator         ${ADDRESS}`);
    expect(result.stdout).not.toContain('@agent');
  });

  it('inspects one catalog snapshot and retains the selected stored label when targets are duplicated', async () => {
    config.loadAccountLabels.mockImplementation((ref): AccountLabelMap => ref === 'testnet-ref'
      ? { ALICE: OTHER_ADDRESS }
      : { First: ADDRESS, Second: ADDRESS });
    const single = await run(['inspect', '--label', ' second ']);
    expect(config.loadAccountLabels).toHaveBeenCalledOnce();
    expect(config.loadAccountLabels).toHaveBeenCalledWith('mainnet-ref');
    expect(config.resolveAccountLabel).not.toHaveBeenCalled();
    expect(config.findAccountLabelForAddress).not.toHaveBeenCalled();
    expect(single.stdout).toEqual(expect.arrayContaining(['Label:   Second', `Address: ${ADDRESS}`]));

    config.loadAccountLabels.mockClear();
    const all = await run(['inspect', '--label', ' alice ', '--all-networks']);
    expect(config.loadAccountLabels.mock.calls).toEqual([['mainnet-ref'], ['testnet-ref']]);
    expect(all.stdout).toContain("Account label 'alice':");
  });

  it('finds one scalar bare label or all matches without fallback lookups', async () => {
    config.findAccountLabelForAddress.mockImplementation((_address, ref) => ref === 'mainnet-ref' ? 'operator' : undefined);
    const single = await run(['find', '--address', ADDRESS]);
    expect(single.stdout).toContain('Label:   operator');
    expect(config.findAccountLabelForAddress).toHaveBeenCalledTimes(1);

    config.findAccountLabelForAddress.mockClear();
    const all = await run(['find', '--address', ADDRESS, '--all-networks']);
    expect(all.stdout).toEqual(expect.arrayContaining(['mainnet:', '  operator']));
    expect(config.findAccountLabelForAddress).toHaveBeenCalledTimes(2);
  });

  it('reports lookup misses with exit one and only other-network diagnostics', async () => {
    const scopes: AccountLabelScopeMatch[] = [
      { scope: 'network', network: 'mainnet', caip2Ref: 'mainnet-ref', label: 'alice', address: ADDRESS },
      { scope: 'network', network: 'testnet', caip2Ref: 'testnet-ref', label: 'alice', address: OTHER_ADDRESS },
    ];
    config.resolveAccountLabel.mockReturnValue(undefined);
    config.findAccountLabelScopes.mockReturnValue(scopes);
    const missing = await run(['inspect', '--label', 'alice']);
    expect(missing.error).toMatchObject({ exitCode: 1 });
    expect(missing.stderr).toContain('It exists for testnet.');
    expect(missing.stderr.join('\n')).not.toContain('mainnet and');

    config.findAccountLabelForAddress.mockReturnValue(undefined);
    expect((await run(['find', '--address', ADDRESS])).error).toMatchObject({ exitCode: 1 });
  });

  it('maps producer failures to exit two while preserving existing command errors', async () => {
    config.loadAccountLabels.mockImplementationOnce(() => { throw new Error('disk failed'); });
    const failed = await run(['list']);
    expect(failed.error).toMatchObject({ exitCode: 2 });
    expect(failed.stderr).toContain('disk failed');

    config.loadAccountLabels.mockImplementationOnce(() => {
      throw new CommanderError(7, 'existing', 'already classified');
    });
    expect((await run(['inspect', '--label', 'alice'])).error).toMatchObject({ exitCode: 7, code: 'existing' });
  });

  it('validates mode before writes and gives existing guidance', async () => {
    const result = await run(['set', '--address', ADDRESS, '--label', 'alice', '--mode', 'invalid']);
    expect(result.error).toBeDefined();
    expect(String(result.error)).toContain("Mode must be 'hard' or 'soft'.");
    expect(config.setAccountLabel).not.toHaveBeenCalled();
  });

  it('delegates set policy without reading the current label', async () => {
    config.setAccountLabel.mockReturnValueOnce({ label: 'StoredAlice', mode: 'hard' });
    const set = await run(['set', '--address', ADDRESS, '--label', ' alice ', '--mode', 'soft']);
    expect(config.setAccountLabel).toHaveBeenCalledWith({ address: ADDRESS, label: 'alice', mode: 'soft' }, 'mainnet-ref');
    expect(JSON.parse(set.stdout.join('\n'))).toEqual({ address: ADDRESS, label: 'StoredAlice', mode: 'hard' });

    config.setAccountLabel.mockReturnValueOnce({ label: 'StoredAlice', mode: 'hard' });
    await run(['set', '--address', ADDRESS, '--mode', 'hard']);
    expect(config.setAccountLabel).toHaveBeenLastCalledWith({ address: ADDRESS, mode: 'hard' }, 'mainnet-ref');

    config.setAccountLabel.mockReturnValueOnce({ label: 'NewLabel', mode: 'hard' });
    await run(['set', '--address', OTHER_ADDRESS, '--label', 'NewLabel']);
    expect(config.setAccountLabel).toHaveBeenLastCalledWith({ address: OTHER_ADDRESS, label: 'NewLabel' }, 'mainnet-ref');
    expect(config.findAccountLabelForAddress).not.toHaveBeenCalled();
  });

  it('prints no success for writer failure and preserves remove address JSON', async () => {
    config.setAccountLabel.mockImplementationOnce(() => { throw new Error('write failed'); });
    const failed = await run(['set', '--address', ADDRESS, '--label', 'alice', '--mode', 'hard']);
    expect(failed.error).toBeDefined();
    expect(failed.stdout).toEqual([]);

    const removed = await run(['remove', '--address', ADDRESS]);
    expect(config.setAccountLabel).toHaveBeenLastCalledWith({ address: ADDRESS, operation: 'remove' }, 'mainnet-ref');
    expect(JSON.parse(removed.stdout.join('\n'))).toEqual({ address: ADDRESS });
  });
});

async function run(args: string[]) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const program = new Command().exitOverride().configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerAccountLabelCliCommand({ program, stdout, stderr });
  let error: unknown;
  try { await program.parseAsync(['account', 'label', ...args], { from: 'user' }); }
  catch (cause) { error = cause; }
  return { error, stderr, stdout };
}
