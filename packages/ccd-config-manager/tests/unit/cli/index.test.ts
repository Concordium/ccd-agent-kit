import { describe, expect, it, type MockInstance, vi } from 'vitest';

import { runCli } from '../../../src/bin/ccd-config-manager.js';
import * as config from '@ccd-agent-kit/config-utils';

describe('ccd-config-manager CLI', () => {
  it('prints help when no command is provided', async () => {
    await withProcessOutputSpies(async ({ stdoutWrite, stderrWrite }) => {
      const exitCode = await runCli([]);

      expect(exitCode).toBe(0);
      expect(stdoutWrite).toHaveBeenCalledWith(expect.stringContaining('Usage: ccd-config-manager [options] [command]'));
      expect(stdoutWrite).toHaveBeenCalledWith(expect.stringContaining('Commands:'));
      expect(stderrWrite).not.toHaveBeenCalled();
    });
  });

  it('returns a usage error for unknown commands', async () => {
    await withProcessOutputSpies(async ({ stdoutWrite, stderrWrite }) => {
      const exitCode = await runCli(['unknown']);

      expect(exitCode).toBe(2);
      expect(stdoutWrite).not.toHaveBeenCalled();
      expect(stderrWrite).toHaveBeenCalledWith("error: unknown command 'unknown'\n");
    });
  });

  it('prints command help for nested commands', async () => {
    await withProcessOutputSpies(async ({ stdoutWrite, stderrWrite }) => {
      const exitCode = await runCli(['network', 'add', '--help']);

      expect(exitCode).toBe(0);
      expect(stdoutWrite).toHaveBeenCalledWith(expect.stringContaining('Usage: ccd-config-manager network add'));
      expect(stdoutWrite).toHaveBeenCalledWith(expect.stringContaining('--grpc-host <host>'));
      expect(stderrWrite).not.toHaveBeenCalled();
    });
  });

  it('returns a usage error for missing required nested options', async () => {
    await withProcessOutputSpies(async ({ stdoutWrite, stderrWrite }) => {
      const exitCode = await runCli(['account', 'label', 'set', '--label', 'created', '--mode', 'hard']);

      expect(exitCode).toBe(2);
      expect(stdoutWrite).not.toHaveBeenCalled();
      expect(stderrWrite).toHaveBeenCalledWith(
        expect.stringContaining("error: required option '--address <address>' not specified"),
      );
    });
  });

  it('returns Commander usage errors for command syntax failures', async () => {
    await withProcessOutputSpies(async ({ stdoutWrite, stderrWrite }) => {
      await expect(runCli(['network', 'list', 'extra'])).resolves.toBe(2);
      await expect(runCli(['account', 'label', 'list', '--bogus'])).resolves.toBe(2);
      await expect(runCli(['account', 'credentials', 'refresh', '--address', 'addr', '--block', 'best'])).resolves.toBe(2);
      await expect(runCli(['service', 'chain-client', 'inspect', 'extra'])).resolves.toBe(2);
      await expect(runCli(['paths', '--unknown'])).resolves.toBe(2);
      expect(stdoutWrite).not.toHaveBeenCalled();
      expect(stderrWrite).toHaveBeenCalledWith(expect.stringContaining('error:'));
    });
  });
  it('reports uncaught persisted-config read failures at the public boundary', async () => {
    const read = vi.spyOn(config, 'loadChainClientConfig').mockImplementation(() => {
      throw new Error('read failed');
    });
    try {
      await withProcessOutputSpies(async ({ stdoutWrite, stderrWrite }) => {
        expect(await runCli(['service', 'chain-client', 'inspect'])).toBe(1);
        expect(stdoutWrite).not.toHaveBeenCalled();
        expect(stderrWrite).toHaveBeenCalledWith(expect.stringContaining('read failed'));
      });
    } finally {
      read.mockRestore();
    }
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
