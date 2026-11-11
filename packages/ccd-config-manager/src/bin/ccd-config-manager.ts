#!/usr/bin/env node

import { commanderExitCode, disableHelpCommands, runCliEntrypoint } from '@ccd-agent-kit/cli-utils';
import { Command, CommanderError } from 'commander';
import { z } from 'zod';

import { runAccountCredentialsCommand } from '../cli/accountCredentialsCommand.js';
import { registerContractInstanceCliCommand } from '../cli/contractInstanceCliCommand.js';
import { runChainClientCommand } from '../cli/chainClientCommand.js';
import { runNetworkCommand } from '../cli/networkCommand.js';
import { runPathsCommand } from '../cli/pathsCommand.js';
import { registerSoftwareCliCommand } from '../cli/softwareCliCommand.js';
import { registerYubiKeyCliCommand } from '../cli/yubikeyCliCommand.js';
import { registerSourceCliCommand } from '../cli/sourceCliCommand.js';
import { registerSigningKeyCliCommand } from '../cli/signingKeyCliCommand.js';
import { registerAccountLabelCliCommand } from '../cli/accountLabelCliCommand.js';
import { renderCliError } from '../cli/renderCliError.js';
import { registerModuleCliCommand } from '../cli/moduleCliCommand.js';
import { registerSignerInstanceCliCommand } from '../cli/signerInstanceCliCommand.js';
import { registerIdManagerInstanceCliCommand } from '../cli/idManagerInstanceCliCommand.js';
import { registerMcpConfigRefreshHook } from '../cli/mcpConfigRefresh.js';

const accountCredentialsNetworkOptionsSchema = z.object({ network: z.string().optional() });
const accountCredentialsAddressOptionsSchema = accountCredentialsNetworkOptionsSchema.extend({
  address: z.string(),
});

/** Runs the human-facing CCD configuration CLI process. */
export async function runCli(argv: string[]): Promise<number> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const program = createProgram(stdout, stderr);

  if (argv.length === 0) {
    stdout.push(trimTrailingNewline(program.helpInformation()));
    writeLines(stdout, stderr);
    return 0;
  }

  try {
    await program.parseAsync(argv, { from: 'user' });
  } catch (error) {
    if (error instanceof CommanderError) {
      writeLines(stdout, stderr);
      return commanderExitCode(error);
    }
    stderr.push(...renderCliError(error));
    writeLines(stdout, stderr);
    return 1;
  }

  writeLines(stdout, stderr);
  return 0;
}

function createProgram(stdout: string[], stderr: string[]): Command {
  const program = new Command();

  program
    .name('ccd-config-manager')
    .description('Manage shared CCD configuration, signing keys, and identity roots.')
    .exitOverride()
    .configureOutput({
      writeOut: (text) => stdout.push(trimTrailingNewline(text)),
      writeErr: (text) => stderr.push(trimTrailingNewline(text)),
      outputError: (text, write) => write(text),
    });

  registerSigningKeyCliCommand({ program, stdout, stderr });
  registerSourceCliCommand({ program, stdout });
  registerYubiKeyCliCommand({ program, stderr, stdout, runNested });
  registerSoftwareCliCommand({ program, stderr, stdout, runNested });
  registerAccountLabelCliCommand({ program, stdout, stderr });
  registerContractInstanceCliCommand({ program, stdout, stderr });
  registerModuleCliCommand({ program, stdout });
  registerSignerInstanceCliCommand({ program, stdout, stderr, runNested });
  registerIdManagerInstanceCliCommand({ program, stdout });
  registerMcpConfigRefreshHook(program);

  const network = program.command('network').description('Manage shared network configurations.');
  network
    .command('list')
    .description('List configured networks.')
    .action(() => runNested(runNetworkCommand({ request: { kind: 'list' }, stdout, stderr })));
  network
    .command('inspect')
    .description('Show one configured network.')
    .requiredOption('--name <name>', 'Network name.')
    .action((options: { name: string }) => runNested(runNetworkCommand({ request: { kind: 'show', name: options.name }, stdout, stderr })));
  network
    .command('add')
    .description('Add a network after auto-detecting its genesis hash and TLS mode.')
    .requiredOption('--name <name>', 'Network name to add.')
    .requiredOption('--grpc-host <host>', 'gRPC host to connect to.')
    .option('--grpc-port <port>', 'gRPC port.', '20000')
    .action((options: { name: string; grpcHost: string; grpcPort: string }) =>
      runNested(
        runNetworkCommand({ request: { kind: 'add', name: options.name, grpcHost: options.grpcHost, grpcPort: options.grpcPort }, stdout, stderr }),
      ),
    );
  network
    .command('update')
    .description('Update a network endpoint after validating it matches the configured genesis hash.')
    .requiredOption('--name <name>', 'Network name to update.')
    .option('--grpc-host <host>', 'New gRPC host.')
    .option('--grpc-port <port>', 'New gRPC port.')
    .action((options: { name: string; grpcHost?: string; grpcPort?: string }) =>
      runNested(runNetworkCommand({ request: { kind: 'update', name: options.name, grpcHost: options.grpcHost, grpcPort: options.grpcPort }, stdout, stderr })),
    );
  network
    .command('remove')
    .description('Remove a configured network.')
    .requiredOption('--name <name>', 'Network name to remove.')
    .action((options: { name: string }) => runNested(runNetworkCommand({ request: { kind: 'remove', name: options.name }, stdout, stderr })));
  const networkDefault = network.command('default').description('Manage the default network.')
    .action((_options, command) => command.error('error: specify default show or default set.', { exitCode: 2 }));
  networkDefault.command('show').description('Show the default network.')
    .action(() => runNested(runNetworkCommand({ request: { kind: 'default-show' }, stdout, stderr })));
  networkDefault.command('set').description('Set the default network.')
    .requiredOption('--name <name>', 'Network name to use by default.')
    .action((options: { name: string }) => runNested(runNetworkCommand({ request: { kind: 'default', name: options.name }, stdout, stderr })));
  network
    .command('doctor')
    .description('Check whether a configured network endpoint is reachable and matches its genesis hash.')
    .option('--name <name>', 'Network name to check. Defaults to the active network.')
    .action((options: { name?: string }) =>
      runNested(runNetworkCommand({ request: { kind: 'doctor', name: options.name }, stdout, stderr })),
    );

  const account = program.commands.find(command => command.name() === 'account')
    ?? program.command('account').description('Manage accounts.');
  const accountCredentials = account.command('credentials').description('Manage finalized account credential observations.');
  accountCredentials
    .command('refresh')
    .description('Refresh finalized account credentials from chain state.')
    .requiredOption('--address <address>', 'Account address.')
    .option('--network <name>', 'Network name. Defaults to the active network.')
    .action((rawOptions: unknown) => {
      const options = accountCredentialsAddressOptionsSchema.parse(rawOptions);
      return runNested(runAccountCredentialsCommand({ request: { kind: 'refresh', address: options.address, network: options.network }, stdout, stderr }));
    });
  accountCredentials
    .command('inspect')
    .description('Show cached finalized account credentials for an address.')
    .requiredOption('--address <address>', 'Account address.')
    .option('--network <name>', 'Network name. Defaults to the active network.')
    .action((rawOptions: unknown) => {
      const options = accountCredentialsAddressOptionsSchema.parse(rawOptions);
      return runNested(runAccountCredentialsCommand({ request: { kind: 'show', address: options.address, network: options.network }, stdout, stderr }));
    });
  accountCredentials
    .command('list')
    .description('List cached finalized account credentials for a network.')
    .option('--network <name>', 'Network name. Defaults to the active network.')
    .action((rawOptions: unknown) => {
      const options = accountCredentialsNetworkOptionsSchema.parse(rawOptions);
      return runNested(runAccountCredentialsCommand({ request: { kind: 'list', network: options.network }, stdout, stderr }));
    });
  accountCredentials
    .command('remove')
    .description('Remove cached finalized account credentials for an address.')
    .requiredOption('--address <address>', 'Account address.')
    .option('--network <name>', 'Network name. Defaults to the active network.')
    .action((rawOptions: unknown) => {
      const options = accountCredentialsAddressOptionsSchema.parse(rawOptions);
      return runNested(runAccountCredentialsCommand({ request: { kind: 'remove', address: options.address, network: options.network }, stdout, stderr }));
    });

  const service = program.commands.find(command => command.name() === 'service')
    ?? program.command('service').description('Manage CCD services.');
  const chainClient = service.command('chain-client').description('Manage ccd-chain-client configuration.');
  chainClient
    .command('inspect')
    .description('Show ccd-chain-client configuration.')
    .action(() => runNested(runChainClientCommand({ request: { kind: 'show' }, stdout, stderr })));
  const startupRefresh = chainClient.command('startup-refresh').description('Manage startup account-credential refresh settings.');
  startupRefresh
    .command('set')
    .description('Set startup account-credential refresh settings.')
    .option('--enabled <true|false>', 'Enable or disable startup refresh.')
    .option('--max-age <duration>', 'Refresh entries older than this, e.g. 24h or 7d.')
    .option('--failure-retry <duration>', 'Retry failed startup refreshes after this duration, e.g. 5m.')
    .option('--concurrency <count>', 'Maximum concurrent startup refresh requests.')
    .action((options: { enabled?: string; maxAge?: string; failureRetry?: string; concurrency?: string }) =>
      runNested(
        runChainClientCommand({ request: { kind: 'startup-refresh-set', enabled: options.enabled, maxAge: options.maxAge, failureRetry: options.failureRetry, concurrency: options.concurrency }, stdout, stderr }),
      ),
    );
  startupRefresh
    .command('reset')
    .description('Reset startup refresh settings to defaults.')
    .action(() => runNested(runChainClientCommand({ request: { kind: 'startup-refresh-reset' }, stdout, stderr })));

  program
    .command('paths')
    .description('Print shared configuration, state, and signer data paths.')
    .option('--network <name>', 'Network name. Defaults to the active network.')
    .action((options: { network?: string }) => runNested(runPathsCommand({ request: { network: options.network }, stdout, stderr })));

  disableHelpCommands(program);
  return program;
}

async function runNested(result: Promise<number> | number): Promise<void> {
  const exitCode = await result;
  if (exitCode !== 0) throw new CommanderError(exitCode, 'ccd.commandFailed', 'Command failed.');
}

function writeLines(stdout: string[], stderr: string[]): void {
  for (const line of stdout) {
    process.stdout.write(`${line}\n`);
  }

  for (const line of stderr) {
    process.stderr.write(`${line}\n`);
  }
}

function trimTrailingNewline(text: string): string {
  return text.replace(/\n$/, '');
}

await runCliEntrypoint(import.meta.main, runCli);
