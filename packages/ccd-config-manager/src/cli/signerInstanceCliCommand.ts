import { stdin as input, stdout as output } from 'node:process';

import { readHiddenLine } from '@ccd-agent-kit/cli-utils';
import {
  listSignerInstances,
  requestSignerInstanceLock,
  requestSignerInstanceUnlock,
} from '@ccd-agent-kit/config-utils';
import type { Command } from 'commander';

/** Dependencies used to register config-owned signer-instance client commands. */
export interface RegisterSignerInstanceCliCommandOptions {
  program: Command;
  stderr: string[];
  stdout: string[];
  runNested: (result: Promise<number> | number) => Promise<void>;
  promptUnlockPassword?: () => Promise<string>;
}

/** Registers signer instance discovery and authenticated software lock control commands. */
export function registerSignerInstanceCliCommand(options: RegisterSignerInstanceCliCommandOptions): void {
  const service = options.program.commands.find(command => command.name() === 'service')
    ?? options.program.command('service').description('Manage CCD services.');
  const signer = service.commands.find(command => command.name() === 'signer')
    ?? service.command('signer').description('Manage signer policy and running instances.');

  signer.command('instances')
    .description('List running signer MCP instances and unlock guidance.')
    .option('--unlock-commands', 'Print only unlock commands for locked instances.')
    .action((values: { unlockCommands?: boolean }) => {
      const instances = listSignerInstances();
      if (values.unlockCommands === true) {
        options.stdout.push(...instances.filter(instance => instance.status === 'locked').map(instance => instance.unlockCommand));
      } else {
        options.stdout.push(JSON.stringify({ instances }, null, 2));
      }
    });

  signer.command('unlock')
    .description('Unlock encrypted software key storage for a running signer MCP instance.')
    .requiredOption('--instance <instance-id>', 'Signer MCP instance identifier.')
    .action((values: { instance: string }) => options.runNested(unlock(options, values.instance)));
  signer.command('lock')
    .description('Lock encrypted software key storage for a running signer MCP instance.')
    .requiredOption('--instance <instance-id>', 'Signer MCP instance identifier.')
    .action((values: { instance: string }) => options.runNested(lock(options, values.instance)));
}

async function unlock(options: RegisterSignerInstanceCliCommandOptions, instanceId: string): Promise<number> {
  if (!isRunning(instanceId)) return reportMissing(options.stderr, instanceId);
  try {
    const password = await (options.promptUnlockPassword ?? promptUnlockPassword)();
    await requestSignerInstanceUnlock({ instanceId, password });
    options.stdout.push(`Unlocked signer instance ${instanceId}.`);
    return 0;
  } catch (error) {
    options.stderr.push(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

async function lock(options: RegisterSignerInstanceCliCommandOptions, instanceId: string): Promise<number> {
  if (!isRunning(instanceId)) return reportMissing(options.stderr, instanceId);
  try {
    await requestSignerInstanceLock({ instanceId });
    options.stdout.push(`Locked signer instance ${instanceId}.`);
    return 0;
  } catch (error) {
    options.stderr.push(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

function isRunning(instanceId: string): boolean {
  return listSignerInstances().some(instance => instance.instanceId === instanceId);
}

function reportMissing(stderr: string[], instanceId: string): 1 {
  stderr.push(`Signer instance ${instanceId} is not running.`);
  return 1;
}

function promptUnlockPassword(): Promise<string> {
  return readHiddenLine(input, output, 'Signer storage password: ', 'Signer unlock requires an interactive terminal.');
}
