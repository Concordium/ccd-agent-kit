import { Command } from 'commander';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { registerSoftwareCliCommand } from '../../../src/cli/softwareCliCommand.js';
import { runStorageCommand } from '../../../src/cli/storageCommand.js';

vi.mock('../../../src/cli/storageCommand.js', () => ({ runStorageCommand: vi.fn(() => 0) }));

function softwareProgram() {
  const program = new Command().exitOverride();
  const runNested = vi.fn(async (result: Promise<number> | number) => { await result; });
  registerSoftwareCliCommand({ program, stderr: [], stdout: [], runNested });
  return { program, runNested };
}

describe('software CLI registration', () => {
  beforeEach(() => vi.clearAllMocks());

  it('registers only the storage root without configurable default operations', async () => {
    const { program, runNested } = softwareProgram();

    expect(program.commands.map(command => command.name())).toEqual(['storage']);

    await program.parseAsync(['storage', 'integrity', '--storage', 'encrypted-file', '--fix'], { from: 'user' });

    expect(runStorageCommand).toHaveBeenNthCalledWith(1, {
      request: { action: 'integrity', backend: 'encrypted-file', fix: true }, stdout: [], stderr: [],
    });
    expect(runNested).toHaveBeenCalledOnce();
    expect(program.commands[0]?.commands.map(command => command.name())).not.toContain('default');
  });

  it.each([
    ['inspect'],
    ['integrity'],
  ])('rejects storage %s without its required selector before invoking a runner', async (...args) => {
    const { program, runNested } = softwareProgram();

    await expect(program.parseAsync(['storage', ...args], { from: 'user' })).rejects.toMatchObject({
      code: 'commander.missingMandatoryOptionValue',
    });

    expect(runStorageCommand).not.toHaveBeenCalled();
    expect(runNested).not.toHaveBeenCalled();
  });
});
