import { runStorageCommand } from './storageCommand.js';
import type { Command } from 'commander';

/** Registers software storage commands on their object root. */
export function registerSoftwareCliCommand(input: {
  program: Command; stderr: string[]; stdout: string[];
  runNested(result: Promise<number> | number): Promise<void>;
}): void {
  const { program, stderr, stdout, runNested } = input;
  const softwareStorage = program.command('storage').description('Manage software key-storage modules.');
  const storage = (request: Parameters<typeof runStorageCommand>[0]['request']) => runNested(runStorageCommand({ request, stdout, stderr }));
  softwareStorage.command('list').description('List software storage modules.').action(() => storage({ action: 'status' }));
  softwareStorage.command('inspect').description('Inspect a software storage module.').requiredOption('--storage <storage>')
    .action(({ storage: selected }: { storage: string }) => storage({ action: 'inspect', backend: selected }));
  for (const action of ['enable', 'disable', 'init', 'change-password'] as const) {
    softwareStorage.command(action).requiredOption('--storage <storage>')
      .action(({ storage: selected }: { storage: string }) => storage({ action, backend: selected }));
  }
  softwareStorage.command('integrity').requiredOption('--storage <storage>').option('--fix')
    .action(({ storage: selected, fix }: { storage: string; fix?: boolean }) => storage({ action: 'integrity', backend: selected, fix: fix === true }));
}
