import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runCliEntrypoint } from '../../src/index.js';

describe('runCliEntrypoint', () => {
  let originalArgv: string[];
  let originalExitCode: typeof process.exitCode;

  beforeEach(() => {
    originalArgv = process.argv;
    originalExitCode = process.exitCode;
  });

  afterEach(() => {
    process.argv = originalArgv;
    process.exitCode = originalExitCode;
  });

  it('leaves the runner and process state untouched when the module is not the entrypoint', async () => {
    const argv = ['node', 'ccd-command', '--network', 'testnet'];
    const run = vi.fn(async () => 7);
    process.argv = argv;
    process.exitCode = 4;

    await runCliEntrypoint(false, run);

    expect(run).not.toHaveBeenCalled();
    expect(process.argv).toBe(argv);
    expect(process.exitCode).toBe(4);
  });

  it.each([0, 3])('forwards process arguments and records exit code %i', async (exitCode) => {
    const commandArgv = ['--network', 'testnet', 'describe'];
    const argv = ['node', 'ccd-command', ...commandArgv];
    const run = vi.fn(async () => exitCode);
    process.argv = argv;
    process.exitCode = 9;

    await runCliEntrypoint(true, run);

    expect(run).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledWith(commandArgv);
    expect(process.argv).toBe(argv);
    expect(process.exitCode).toBe(exitCode);
  });

  it('propagates synchronous and rejected runner failures unchanged without replacing the prior exit code', async () => {
    const failure = new Error('runner failed');
    process.argv = ['node', 'ccd-command', 'status'];

    const runners: Array<() => Promise<number>> = [
      () => {
        throw failure;
      },
      async () => {
        throw failure;
      },
    ];
    for (const runner of runners) {
      process.exitCode = 6;
      await expect(runCliEntrypoint(true, runner)).rejects.toBe(failure);
      expect(process.exitCode).toBe(6);
    }
  });
});
