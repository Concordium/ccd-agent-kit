#!/usr/bin/env node

import { commanderExitCode, disableHelpCommands, runCliEntrypoint } from '@ccd-agent-kit/cli-utils';
import { Command, CommanderError } from 'commander';

import { CliUsageError as DescribeUsageError, createDescribeCommandRequest, runDescribeCommand } from '../cli/describeCommand.js';
import { FinalizeCliUsageError, createFinalizeCommandRequest, runFinalizeCommand } from '../cli/finalizeCommand.js';
import { CliUsageError, createSignCommandRequest, runSignCommand } from '../cli/signCommand.js';
import { createSignMessageCommandRequest, runSignMessageCommand } from '../cli/signMessageCommand.js';
import { runListKeysCommand } from '../cli/listKeysCommand.js';

/**
 * Runs the Concordium signer CLI process.
 * The global network selector is resolved only by signing commands.
 *
 * @param argv - The process arguments to execute.
 * @returns A promise resolving to the desired process exit code.
 */
export async function runCli(argv: string[]): Promise<number> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const program = createProgram(stdout, stderr);

  if (argv[0] === 'software' || argv[0] === 'yubikey') {
    stderr.push(`error: unknown command '${argv[0]}'`);
    writeLines(stdout, stderr);
    return 2;
  }

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
    stderr.push(error instanceof Error ? error.message : String(error));
    writeLines(stdout, stderr);
    return error instanceof CliUsageError || error instanceof DescribeUsageError || error instanceof FinalizeCliUsageError ? 2 : 1;
  }

  writeLines(stdout, stderr);
  return 0;
}

function createProgram(stdout: string[], stderr: string[]): Command {
  const program = new Command();

  program
    .name('ccd-signer')
    .description('Inspect, sign, and finalize Concordium transactions with local signer keys.')
    .option('--network <network>', 'Network name. Defaults to the active network.')
    .configureHelp({ showGlobalOptions: true })
    .exitOverride()
    .configureOutput({
      writeOut: (text) => stdout.push(trimTrailingNewline(text)),
      writeErr: (text) => stderr.push(trimTrailingNewline(text)),
      outputError: (text, write) => write(text),
    });

  program
    .command('describe')
    .description('Describe serialized Concordium transaction or block item hex.')
    .option('--input <hex>', 'Serialized transaction hex.')
    .option('--input-file <path>', 'File containing serialized transaction hex.')
    .option('--stdin', 'Read serialized transaction hex from stdin.')
    .option('--output <format>', 'Output format: json or text.', 'json')
    .action(async (options: Parameters<typeof createDescribeCommandRequest>[0]) =>
      runNested(
        runDescribeCommand({
          request: createDescribeCommandRequest(options),
          stdout,
          stderr,
        }),
      ),
    );

  program
    .command('sign')
    .description('Produce detached sender or sponsor transaction signatures.')
    .option('--input <hex>', 'Unsigned transaction hex.')
    .option('--input-file <path>', 'File containing unsigned transaction hex.')
    .option('--stdin', 'Read unsigned transaction hex from stdin.')
    .requiredOption('--role <role>', 'Signing role: sender or sponsor.')
    .option('--signatures <json>', 'Existing role-separated detached signatures JSON.')
    .option('--signatures-file <path>', 'File containing existing role-separated detached signatures JSON.')
    .option('--key <credential:key>', 'Exact credential/key pair to sign. May be repeated.', collect, [])
    .option('--max-signatures <n>', 'Maximum number of available missing keys to sign.')
    .option('--signature-requirements <json>', 'Builder-compatible signature requirement metadata JSON.')
    .action(async (_options, command: Command) =>
      runNested(runSignCommand({ request: createSignCommandRequest(command.optsWithGlobals()), stdout, stderr })),
    );

  program
    .command('sign-message')
    .description('Sign arbitrary message bytes with a signer-capable account.')
    .requiredOption('--account <account>', 'Account address or public account label.')
    .option('--input <value>', 'Message text or hex value.')
    .option('--input-file <path>', 'File containing message text or hex value.')
    .option('--stdin', 'Read message text or hex value from stdin.')
    .requiredOption('--format <format>', 'Input format: text or hex.')
    .action(async (_options, command: Command) =>
      runNested(
        runSignMessageCommand({
          request: createSignMessageCommandRequest(command.optsWithGlobals()),
          stdout,
          stderr,
        }),
      ),
    );

  program
    .command('finalize')
    .description('Finalize unsigned transaction hex plus detached signatures into block item hex.')
    .option('--input <hex>', 'Unsigned transaction hex.')
    .option('--input-file <path>', 'File containing unsigned transaction hex.')
    .option('--stdin', 'Read unsigned transaction hex from stdin.')
    .option('--signatures <json>', 'Role-separated detached signatures JSON.')
    .option('--signatures-file <path>', 'File containing role-separated detached signatures JSON.')
    .requiredOption('--signature-requirements <json>', 'Builder-compatible signature requirement metadata JSON.')
    .action(async (options: Parameters<typeof createFinalizeCommandRequest>[0]) =>
      runNested(
        runFinalizeCommand({
          request: createFinalizeCommandRequest(options),
          stdout,
          stderr,
        }),
      ),
    );

  program
    .command('list-keys')
    .description('List signer-known public keys.')
    .action(async () => runNested(runListKeysCommand({ stdout, stderr })));

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

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function trimTrailingNewline(text: string): string {
  return text.replace(/\n$/, '');
}

await runCliEntrypoint(import.meta.main, runCli);
