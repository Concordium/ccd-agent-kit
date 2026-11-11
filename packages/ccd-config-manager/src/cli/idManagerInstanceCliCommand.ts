import { listIdentityManagerInstances } from '@ccd-agent-kit/config-utils';
import type { Command } from 'commander';

/** Dependencies used to register identity-manager instance discovery commands. */
export interface RegisterIdManagerInstanceCliCommandOptions {
  program: Command;
  stdout: string[];
}

/** Registers read-only identity-manager instance discovery. */
export function registerIdManagerInstanceCliCommand(
  options: RegisterIdManagerInstanceCliCommandOptions,
): void {
  const service = options.program.commands.find(command => command.name() === 'service')
    ?? options.program.command('service').description('Manage CCD services.');
  const idManager = service.commands.find(command => command.name() === 'id-manager')
    ?? service.command('id-manager').description('Manage identity-manager policy and running instances.');

  idManager.command('instances')
    .description('List running identity-manager MCP instances.')
    .action(() => {
      options.stdout.push(JSON.stringify({ instances: listIdentityManagerInstances() }, null, 2));
    });
}
