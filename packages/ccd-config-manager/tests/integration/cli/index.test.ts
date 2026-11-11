import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';

import { runCli } from '../../../src/bin/ccd-config-manager.js';
import { loadAccountLabels, loadContractInstanceLabels, loadChainClientConfig } from '@ccd-agent-kit/config-utils';
import { setupCliTestEnv, type CliTestEnv } from '../../helpers/testEnv.js';

describe('ccd-config-manager CLI', () => {
  let env: CliTestEnv;

  beforeEach(() => {
    env = setupCliTestEnv('ccd-config-manager-index-');
  });

  afterEach(() => {
    env.restore();
  });

  it.each([
    [[], 'Usage: ccd-config-manager'],
    [['--help'], 'Usage: ccd-config-manager'],
    [['-h'], 'Usage: ccd-config-manager'],
    [['network', '--help'], 'Usage: ccd-config-manager network'],
    [['network', '-h'], 'Usage: ccd-config-manager network'],
    [['network', 'default', '--help'], 'Usage: ccd-config-manager network default'],
    [['network', 'default', '-h'], 'Usage: ccd-config-manager network default'],
  ] as const)('renders real Commander help successfully without changing configuration: %j', async (argv, usage) => {
    const before = loadChainClientConfig();

    await withProcessOutputSpies(async ({ stdoutWrite, stderrWrite }) => {
      expect(await runCli([...argv])).toBe(0);
      expect(stdoutWrite.mock.calls.flat().join('')).toContain(usage);
      expect(stderrWrite).not.toHaveBeenCalled();
    });

    expect(loadChainClientConfig()).toEqual(before);
  });

  it.each([
    ['help'],
    ['help', 'network'],
    ['network', 'help'],
    ['network', 'default', 'help', 'show'],
  ])('rejects generated help subcommands without changing configuration: %j', async (...argv) => {
    const before = loadChainClientConfig();

    await withProcessOutputSpies(async ({ stdoutWrite, stderrWrite }) => {
      expect(await runCli(argv)).toBe(2);
      expect(stdoutWrite).not.toHaveBeenCalled();
      expect(stderrWrite).toHaveBeenCalled();
    });

    expect(loadChainClientConfig()).toEqual(before);
  });

  it.each([
    ['unknown'],
    ['network', 'inspect'],
  ])('keeps real Commander usage failures at exit code 2 without changing configuration: %j', async (...argv) => {
    const before = loadChainClientConfig();

    await withProcessOutputSpies(async ({ stderrWrite }) => {
      expect(await runCli(argv)).toBe(2);
      expect(stderrWrite).toHaveBeenCalled();
    });

    expect(loadChainClientConfig()).toEqual(before);
  });

  it('dispatches network, account-label, account-credentials, and paths commands', async () => {
    await expect(runCli(['network', 'list'])).resolves.toBe(0);
    await expect(runCli(['account', 'label', 'list'])).resolves.toBe(0);
    await expect(runCli(['account', 'credentials', 'list'])).resolves.toBe(0);
    await expect(runCli(['paths'])).resolves.toBe(0);
    await expect(runCli(['paths', '--network', 'mainnet'])).resolves.toBe(0);
    await expect(runCli(['paths', '--network', 'missing'])).resolves.toBe(2);
  });

  it.each([
    ['network', 'rename'],
    ['contract-instance', 'rename'],
    ['account', 'credentials', 'rename'],
    ['chain-client', 'start'],
    ['network', 'add', '--name', 'dev'],
    ['network', 'inspect'],
    ['network', 'update', '--name'],
    ['network', 'remove'],
    ['network', 'default'],
    ['account', 'label', 'find'],
    ['contract-instance', 'label', 'set', '--label', 'saved'],
    ['contract-instance', 'label', 'find', '--address'],
    ['contract-instance', 'label', 'list', 'extra'],
    ['account', 'credentials', 'refresh'],
    ['account', 'credentials', 'inspect'],
    ['account', 'credentials', 'remove'],
    ['service', 'chain-client', 'startup-refresh', 'set', '--enabled'],
    ['service', 'chain-client', 'startup-refresh', 'reset', '--enabled', 'true'],
  ])('rejects public syntax before dispatch: %j', async (...args) => {
    const before = loadChainClientConfig();
    await withProcessOutputSpies(async ({ stdoutWrite, stderrWrite }) => {
      expect(await runCli(args)).toBe(2);
      expect(stdoutWrite).not.toHaveBeenCalled();
      expect(stderrWrite).toHaveBeenCalledWith(expect.stringContaining('error:'));
    });
    expect(loadChainClientConfig()).toEqual(before);
    expect(loadAccountLabels('9dd9ca4d19e9393877d2c44b70f89acb')).toEqual({});
    expect(loadContractInstanceLabels('9dd9ca4d19e9393877d2c44b70f89acb')).toEqual({});
  });

  it.each([
    [['account', 'label'], '--address', '3DPgLSmDKt7tvAybE95obMXANrUChv5aBpzGPU3qjaG7ERG6JC'],
    [['contract-instance', 'label'], '--address', '42.7'],
  ] as const)('maps network and all-networks options for %j', async (command, valueOption, value) => {
    await withProcessOutputSpies(async ({ stdoutWrite, stderrWrite }) => {
      for (const name of ['zulu', 'alpha']) {
        const namedValue = name === 'alpha'
          ? command[0] === 'account'
            ? '3A8MFWYYSf88CX1vN7stxAgaV5KCwhuVPwRc6J5zTTjyKZLZ3u'
            : '43.7'
          : value;
        const mutation = [
          ...command, 'set', '--label', name, valueOption, namedValue,
          '--mode', 'hard', '--network', 'testnet',
        ];
        expect(await runCli(mutation)).toBe(0);
      }
      for (const scope of [['--network', 'testnet'], ['--all-networks']]) {
        stdoutWrite.mockClear();
        expect(await runCli([...command, 'list', ...scope])).toBe(0);
        const listing = stdoutWrite.mock.calls.map(([text]) => String(text)).join('');
        expect(listing.indexOf('alpha')).toBeLessThan(listing.indexOf('zulu'));
        expect(listing).toContain('testnet');
        expect(await runCli([...command, 'inspect', '--label', 'alpha', ...scope])).toBe(0);
        expect(await runCli([...command, 'find', valueOption, value, ...scope])).toBe(0);
      }
      const removalAddress = command[0] === 'account'
        ? '3A8MFWYYSf88CX1vN7stxAgaV5KCwhuVPwRc6J5zTTjyKZLZ3u'
        : '43.7';
      const removal = [...command, 'remove', '--address', removalAddress, '--network', 'testnet'];
      expect(await runCli(removal)).toBe(0);
      expect(await runCli([...command, 'inspect', '--label', 'alpha', '--network', 'testnet'])).toBe(1);
      expect(stderrWrite).toHaveBeenCalledWith(expect.stringContaining('not configured'));
    });
  });

  it('dispatches account-credentials subcommands through Commander', async () => {
    await expect(
      runCli([
        'account',
        'credentials',
        'refresh',
        '--address',
        '3DPgLSmDKt7tvAybE95obMXANrUChv5aBpzGPU3qjaG7ERG6JC',
        '--network',
        'missing',
      ]),
    ).resolves.toBe(2);
    await expect(
      runCli(['account', 'credentials', 'inspect', '--address', '3DPgLSmDKt7tvAybE95obMXANrUChv5aBpzGPU3qjaG7ERG6JC']),
    ).resolves.toBe(1);
    await expect(
      runCli(['account', 'credentials', 'remove', '--address', '3DPgLSmDKt7tvAybE95obMXANrUChv5aBpzGPU3qjaG7ERG6JC']),
    ).resolves.toBe(1);
  });

  it('dispatches chain-client startup-refresh subcommands through Commander', async () => {
    await expect(runCli(['service', 'chain-client', 'inspect'])).resolves.toBe(0);
    await expect(
      runCli([
        'service',
        'chain-client',
        'startup-refresh',
        'set',
        '--enabled',
        'false',
        '--max-age',
        '7d',
        '--failure-retry',
        '10m',
        '--concurrency',
        '5',
      ]),
    ).resolves.toBe(0);
    expect(loadChainClientConfig().accountCredentials.startupRefresh).toEqual({
      enabled: false,
      maxAge: '7d',
      failureRetry: '10m',
      concurrency: 5,
    });
    await expect(runCli(['service', 'chain-client', 'startup-refresh', 'reset'])).resolves.toBe(0);
    expect(loadChainClientConfig().accountCredentials.startupRefresh).toEqual({
      enabled: true,
      maxAge: '24h',
      failureRetry: '5m',
      concurrency: 3,
    });
  });

  it('dispatches additional network and account-label subcommands safely', async () => {
    await expect(
      runCli(['network', 'add', '--name', 'offline', '--grpc-host', 'localhost', '--grpc-port', '0']),
    ).resolves.toBe(2);
    await expect(runCli(['network', 'inspect', '--name', 'mainnet'])).resolves.toBe(0);
    await expect(runCli(['network', 'default', 'show'])).resolves.toBe(0);
    await expect(runCli(['network', 'update', '--name', 'mainnet'])).resolves.toBe(0);
    await expect(runCli(['network', 'remove', '--name', 'mainnet'])).resolves.toBe(1);
    await expect(runCli(['network', 'default', 'set', '--name', 'missing'])).resolves.toBe(1);
    await expect(runCli(['network', 'doctor', '--name', 'missing'])).resolves.toBe(1);
    await expect(
      runCli([
        'account',
        'label',
        'set',
        '--label',
        'created',
        '--mode',
        'hard',
        '--address',
        '3DPgLSmDKt7tvAybE95obMXANrUChv5aBpzGPU3qjaG7ERG6JC',
      ]),
    ).resolves.toBe(0);
    await expect(runCli(['account', 'label', 'inspect', '--label', 'missing'])).resolves.toBe(1);
    await expect(
      runCli(['account', 'label', 'find', '--address', '3DPgLSmDKt7tvAybE95obMXANrUChv5aBpzGPU3qjaG7ERG6JC']),
    ).resolves.toBe(0);
  });

  it('applies partial startup refresh updates and leaves omitted settings unchanged', async () => {
    const before = loadChainClientConfig();
    await withProcessOutputSpies(async ({ stdoutWrite, stderrWrite }) => {
      expect(await runCli(['service', 'chain-client', 'startup-refresh', 'set', '--enabled', 'false'])).toBe(0);
      const updated = loadChainClientConfig();
      expect(updated.accountCredentials.startupRefresh).toEqual({
        ...before.accountCredentials.startupRefresh,
        enabled: false,
      });
      stdoutWrite.mockClear();
      expect(await runCli(['service', 'chain-client', 'startup-refresh', 'set'])).toBe(0);
      expect(stdoutWrite).toHaveBeenCalledWith('No changes specified.\n');
      expect(loadChainClientConfig()).toEqual(updated);
      expect(stderrWrite).not.toHaveBeenCalled();
    });
  });
});

async function withProcessOutputSpies(
  callback: (spies: { stdoutWrite: MockInstance; stderrWrite: MockInstance }) => Promise<void>,
): Promise<void> {
  const stdoutWrite = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  const stderrWrite = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  try {
    await callback({ stdoutWrite, stderrWrite });
  } finally {
    stdoutWrite.mockRestore();
    stderrWrite.mockRestore();
  }
}
