import { Command, CommanderError } from 'commander';
import { describe, expect, it } from 'vitest';

import { commanderExitCode, disableHelpCommands } from '../../src/index.js';

function commandTree(): Command {
  const root = new Command('root')
    .exitOverride()
    .configureOutput({ writeOut: () => {}, writeErr: () => {} });
  const child = root.command('child');
  const grandchild = child.command('grandchild');
  grandchild.command('leaf');
  return root;
}

async function parseExitCode(program: Command, argv: string[]): Promise<number> {
  try {
    await program.parseAsync(argv, { from: 'user' });
    return 0;
  } catch (error) {
    expect(error).toBeInstanceOf(CommanderError);
    return commanderExitCode(error as CommanderError);
  }
}

describe('disableHelpCommands', () => {
  it('recursively removes generated help commands while preserving help flags', () => {
    const root = commandTree();
    const child = root.commands[0]!;
    const grandchild = child.commands[0]!;

    disableHelpCommands(root);

    for (const command of [root, child, grandchild]) {
      expect(command.helpInformation()).not.toContain('help [command]');
      expect(command.helpInformation()).toContain('-h, --help');
    }
  });

  it.each([
    ['help'],
    ['child', 'help'],
    ['child', 'grandchild', 'help'],
  ])('rejects generated help syntax as a usage failure: %j', async (...argv) => {
    const program = commandTree();
    disableHelpCommands(program);

    await expect(parseExitCode(program, argv)).resolves.toBe(2);
  });

  it.each([
    ['--help'],
    ['-h'],
    ['child', '--help'],
    ['child', '-h'],
    ['child', 'grandchild', '--help'],
    ['child', 'grandchild', '-h'],
  ])('keeps help flags successful: %j', async (...argv) => {
    const program = commandTree();
    disableHelpCommands(program);

    await expect(parseExitCode(program, argv)).resolves.toBe(0);
  });
});
