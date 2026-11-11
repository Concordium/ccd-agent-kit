import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Command, CommanderError } from 'commander';

import { addNetwork, setAccountLabel } from '@ccd-agent-kit/config-utils';
import { registerAccountLabelCliCommand } from '../../../src/cli/accountLabelCliCommand.js';
import { setupCliTestEnv, type CliTestEnv } from '../../helpers/testEnv.js';

const MAINNET_REF = '9dd9ca4d19e9393877d2c44b70f89acb';
const TESTNET_REF = '4221332d34e1694168c2a0c0b3fd0f27';
const DEVNET_REF = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const accountLabelCommandMessages = {
  addressNotLabeled: (scope: string) => `Address has no account label for ${scope}.`,
  addressNotLabeledAnywhere: 'Address has no account label on any network.',
  labelNotConfigured: (label: string, scope: string) => `Account label '${label}' is not configured for ${scope}.`,
  labelNotConfiguredAnywhere: (label: string) => `Account label '${label}' is not configured on any network.`,
  networkAndAllNetworks: 'Use either --network <name> or --all-networks, not both.',
};

describe('runAccountLabelCommand', () => {
  let env: CliTestEnv;

  beforeEach(() => {
    env = setupCliTestEnv('ccd-config-manager-account-label-');
  });

  afterEach(() => {
    env.restore();
  });

  it('lists, inspects, and finds account labels for the active network', async () => {
    setAccountLabel({ address: '4MyAccount', label: 'alice' }, MAINNET_REF);
    expect(await runAccountLabelCommand({ request: { kind: 'list' }, stdout: env.stdout, stderr: env.stderr })).toBe(0);
    expect(env.stdout.join('\n')).toContain('Account labels for mainnet:');
    expect(env.stdout.join('\n')).toContain('alice');

    env.stdout.length = 0;
    expect(
      await runAccountLabelCommand({ request: { kind: 'inspect', label: 'alice' }, stdout: env.stdout, stderr: env.stderr }),
    ).toBe(0);
    expect(env.stdout.join('\n')).toContain('Label:   alice');
    expect(env.stdout.join('\n')).toContain('Network: mainnet');

    env.stdout.length = 0;
    expect(
      await runAccountLabelCommand({
        request: { kind: 'find', address: '4MyAccount' },
        stdout: env.stdout,
        stderr: env.stderr,
      }),
    ).toBe(0);
    expect(env.stdout.join('\n')).toContain('Label:   alice');
  });

  it('lists, inspects, and finds account labels across all networks', async () => {
    setAccountLabel({ address: '4MainnetAccount', label: 'alice' }, MAINNET_REF);
    setAccountLabel({ address: '3TestnetAccount', label: 'alice' }, TESTNET_REF);
    setAccountLabel({ address: '3BobAccount', label: 'bob' }, TESTNET_REF);

    expect(
      await runAccountLabelCommand({
        request: { kind: 'list', allNetworks: true },
        stdout: env.stdout,
        stderr: env.stderr,
      }),
    ).toBe(0);
    expect(env.stdout.join('\n')).toContain('Account labels by network:');
    expect(env.stdout.join('\n')).toContain('mainnet:');
    expect(env.stdout.join('\n')).toContain('testnet:');
    expect(env.stdout.join('\n')).toContain('4MainnetAccount');
    expect(env.stdout.join('\n')).toContain('3TestnetAccount');

    env.stdout.length = 0;
    expect(
      await runAccountLabelCommand({
        request: { kind: 'inspect', allNetworks: true, label: 'alice' },
        stdout: env.stdout,
        stderr: env.stderr,
      }),
    ).toBe(0);
    expect(env.stdout.join('\n')).toContain("Account label 'alice':");
    expect(env.stdout.join('\n')).toContain('mainnet:');
    expect(env.stdout.join('\n')).toContain('testnet:');

    env.stdout.length = 0;
    expect(
      await runAccountLabelCommand({
        request: { kind: 'find', allNetworks: true, address: '3BobAccount' },
        stdout: env.stdout,
        stderr: env.stderr,
      }),
    ).toBe(0);
    expect(env.stdout.join('\n')).toContain('Address matches:');
    expect(env.stdout.join('\n')).toContain('testnet:');
    expect(env.stdout.join('\n')).toContain('bob');
  });

  it('rejects combining --all-networks and --network', async () => {
    const exitCode = await runAccountLabelCommand({
      request: { kind: 'list', allNetworks: true, network: 'mainnet' },
      stdout: env.stdout,
      stderr: env.stderr,
    });

    expect(exitCode).toBe(2);
    expect(env.stderr.join('\n')).toContain(accountLabelCommandMessages.networkAndAllNetworks);
  });

  it('prints command-owned help', async () => {
    expect(await runAccountLabelCli(['account', 'label', '--help'], env.stdout, env.stderr)).toBe(0);
    expect(env.stdout.join('\n')).toContain('Usage: program account label');
  });

  it('rejects unknown networks', async () => {
    await expectExit({ kind: 'list', network: 'missing' }, 2, "Network 'missing' not found.");
    await expectExit({ kind: 'inspect', label: 'alice', network: 'missing' }, 2, "Network 'missing' not found.");
    await expectExit({ kind: 'find', address: '4MyAccount', network: 'missing' }, 2, "Network 'missing' not found.");
  });

  it('reports missing labels and addresses', async () => {
    await expectExit(
      { kind: 'inspect', label: 'alice' },
      1,
      accountLabelCommandMessages.labelNotConfigured('alice', 'mainnet'),
    );
    await expectExit({ kind: 'find', address: '4MyAccount' }, 1, accountLabelCommandMessages.addressNotLabeled('mainnet'));
    await expectExit(
      { kind: 'inspect', allNetworks: true, label: 'alice' },
      1,
      accountLabelCommandMessages.labelNotConfiguredAnywhere('alice'),
    );
    await expectExit(
      { kind: 'find', allNetworks: true, address: '4MyAccount' },
      1,
      accountLabelCommandMessages.addressNotLabeledAnywhere,
    );
  });

  it('reports the networks where a missing name exists', async () => {
    setAccountLabel({ address: '4MainnetAccount', label: 'alice' }, MAINNET_REF);

    const exitCode = await runAccountLabelCommand({
      request: { kind: 'inspect', label: 'alice', network: 'testnet' },
      stdout: env.stdout,
      stderr: env.stderr,
    });

    expect(exitCode).toBe(1);
    expect(env.stderr.join('\n')).toContain(accountLabelCommandMessages.labelNotConfigured('alice', 'testnet'));
    expect(env.stderr.join('\n')).toContain('It exists for mainnet.');
  });

  it('formats multiple networks where a missing name exists', async () => {
    addNetwork('devnet', {
      caip2: `ccd:${DEVNET_REF}`,
      genesisHash: DEVNET_REF.padEnd(64, 'a'),
      grpc: { host: 'localhost', port: 20000, ssl: false },
    });
    setAccountLabel({ address: '4MainnetAccount', label: 'alice' }, MAINNET_REF);
    setAccountLabel({ address: '4DevnetAccount', label: 'alice' }, DEVNET_REF);

    const exitCode = await runAccountLabelCommand({
      request: { kind: 'inspect', label: 'alice', network: 'testnet' },
      stdout: env.stdout,
      stderr: env.stderr,
    });

    expect(exitCode).toBe(1);
    expect(env.stderr.join('\n')).toContain('It exists for devnet and mainnet.');
  });

  async function expectExit(
    request: Parameters<typeof runAccountLabelCommand>[0]['request'],
    exitCode: number,
    stderrIncludes: string,
  ) {
    env.stdout.length = 0;
    env.stderr.length = 0;
    expect(await runAccountLabelCommand({ request, stdout: env.stdout, stderr: env.stderr })).toBe(exitCode);
    expect(env.stderr.join('\n')).toContain(stderrIncludes);
  }

  async function runAccountLabelCommand(options: {
    request: { kind: string; label?: string; address?: string; network?: string; allNetworks?: boolean };
    stdout: string[]; stderr: string[];
  }): Promise<number> {
    const request = options.request;
    const argv = ['account', 'label', request.kind];
    if (request.label) argv.push('--label', request.label);
    if (request.address) argv.push('--address', request.address);
    if (request.network) argv.push('--network', request.network);
    if (request.allNetworks) argv.push('--all-networks');
    return runAccountLabelCli(argv, options.stdout, options.stderr);
  }

  async function runAccountLabelCli(argv: string[], stdout: string[], stderr: string[]): Promise<number> {
    const program = new Command().exitOverride().configureOutput({
      writeOut: (text) => stdout.push(text), writeErr: () => {},
    });
    registerAccountLabelCliCommand({ program, stdout, stderr });
    try { await program.parseAsync(argv, { from: 'user' }); return 0; }
    catch (error) { return error instanceof CommanderError ? error.exitCode : 1; }
  }
});
