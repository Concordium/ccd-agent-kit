import { fileURLToPath } from 'node:url';
import { afterEach,describe,expect,it,vi } from 'vitest';

const { runIdentityMcpServer } = vi.hoisted(() => ({
  runIdentityMcpServer: vi.fn<() => Promise<void>>(),
}));

vi.mock('../../src/mcp/server.js', () => ({ runIdentityMcpServer }));

import {
identityMcpHelpText,
runCcdIdentityManagerMcp,
} from '../../src/bin/ccd-id-manager-mcp.js';

describe('ccd-id-manager-mcp executable', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each(['--help', '-h'])('prints help for %s without starting native services', async (flag) => {
    const stdout = vi.fn<(text: string) => void>();
    const stderr = vi.fn<(text: string) => void>();
    expect(await runCcdIdentityManagerMcp([flag], { stdout, stderr })).toBe(0);
    expect(stdout).toHaveBeenCalledWith(identityMcpHelpText());
    expect(stderr).not.toHaveBeenCalled();
    expect(runIdentityMcpServer).not.toHaveBeenCalled();
  });

  it('rejects unexpected arguments without loading native services', async () => {
    const stdout = vi.fn<(text: string) => void>();
    const stderr = vi.fn<(text: string) => void>();
    expect(await runCcdIdentityManagerMcp(['--unknown'], { stdout, stderr })).toBe(2);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('Invalid command usage'));
    expect(stdout).not.toHaveBeenCalled();
    expect(runIdentityMcpServer).not.toHaveBeenCalled();
  });

  it('starts the stdio server and reports a sanitized startup failure', async () => {
    const io = { stdout: vi.fn<(text: string) => void>(), stderr: vi.fn<(text: string) => void>() };
    runIdentityMcpServer.mockResolvedValueOnce();
    await expect(runCcdIdentityManagerMcp([], io)).resolves.toBe(0);
    expect(runIdentityMcpServer).toHaveBeenCalledOnce();

    runIdentityMcpServer.mockRejectedValueOnce(new Error('secret /Users/alice/private-state'));
    await expect(runCcdIdentityManagerMcp([], io)).resolves.toBe(1);
    expect(io.stderr).toHaveBeenLastCalledWith('ccd-id-manager-mcp: startup failed.');
    expect(JSON.stringify(io.stderr.mock.calls)).not.toContain('/Users/alice');
  });

  it('uses process stdout and stderr when I/O is omitted', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await expect(runCcdIdentityManagerMcp(['--help'])).resolves.toBe(0);
    await expect(runCcdIdentityManagerMcp(['bad'])).resolves.toBe(2);
    expect(stdout).toHaveBeenCalledWith(`${identityMcpHelpText()}\n`);
    expect(stderr).toHaveBeenCalledWith('Invalid command usage. Run ccd-id-manager-mcp --help.\n');
  });

  it('does not start the server when imported even if argv names this module', async () => {
    const originalArgv = process.argv;
    const originalExitCode = process.exitCode;
    try {
      runIdentityMcpServer.mockClear();
      process.argv = [process.execPath, fileURLToPath(new URL('../../src/bin/ccd-id-manager-mcp.ts', import.meta.url))];
      process.exitCode = undefined;
      vi.resetModules();
      await import('../../src/bin/ccd-id-manager-mcp.js');
      expect(process.exitCode).toBeUndefined();
      expect(runIdentityMcpServer).not.toHaveBeenCalled();
    } finally {
      process.argv = originalArgv;
      process.exitCode = originalExitCode;
    }
  });
});
