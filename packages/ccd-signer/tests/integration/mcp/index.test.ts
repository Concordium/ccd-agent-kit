import { describe, expect, it, vi } from 'vitest';
import { testScratchPath } from '../../helpers/tempDir.js';

const runMcpServerMock = vi.fn(async () => undefined);

vi.mock('../../../src/mcp/server.js', () => ({
  runMcpServer: runMcpServerMock,
}));

describe('mcp index entrypoint', () => {
  it('starts the MCP server when no help flag is provided', async () => {
    runMcpServerMock.mockClear();

    const { runCcdSignerMcp } = await import('../../../src/bin/ccd-signer-mcp.js');
    const exitCode = await runCcdSignerMcp([]);

    expect(exitCode).toBe(0);
    expect(runMcpServerMock).toHaveBeenCalledTimes(1);
  });

  it('prints help without starting the MCP server', async () => {
    runMcpServerMock.mockClear();
    const stdout: string[] = [];

    const { runCcdSignerMcp } = await import('../../../src/bin/ccd-signer-mcp.js');
    const exitCode = await runCcdSignerMcp(['--help'], { stdout: (line) => stdout.push(line) });

    expect(exitCode).toBe(0);
    expect(stdout.join('\n')).toContain('Usage: ccd-signer-mcp');
    expect(runMcpServerMock).not.toHaveBeenCalled();
  });

  it('uses process stdout for default help output', async () => {
    runMcpServerMock.mockClear();
    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    try {
      const { runCcdSignerMcp } = await import('../../../src/bin/ccd-signer-mcp.js');
      const exitCode = await runCcdSignerMcp(['--help']);

      expect(exitCode).toBe(0);
      expect(stdoutWrite).toHaveBeenCalledWith(expect.stringContaining('Usage: ccd-signer-mcp'));
      expect(runMcpServerMock).not.toHaveBeenCalled();
    } finally {
      stdoutWrite.mockRestore();
    }
  });

  it('prints network diagnostics before starting the MCP server when CCD_NETWORK is unknown', async () => {
    runMcpServerMock.mockClear();
    const originalEnv = { ...process.env };
    const stdout: string[] = [];
    const stderr: string[] = [];
    const configHome = testScratchPath('ccd-missing-config');

    try {
      process.env = {
        ...originalEnv,
        CCD_NETWORK: 'localnet',
        XDG_CONFIG_HOME: configHome,
      };
      const { runCcdSignerMcp } = await import('../../../src/bin/ccd-signer-mcp.js');
      const exitCode = await runCcdSignerMcp([], {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      });

      expect(exitCode).toBe(1);
      expect(stdout).toEqual([]);
      expect(stderr.join('\n')).toContain("Session network 'localnet' from CCD_NETWORK not found.");
      expect(stderr.join('\n')).toContain(`${configHome}/ccd-agent-kit/networks.json`);
      expect(stderr.join('\n')).toContain('available networks: mainnet, testnet');
      expect(runMcpServerMock).not.toHaveBeenCalled();
    } finally {
      process.env = originalEnv;
    }
  });

  it('uses process stderr for default startup diagnostics', async () => {
    runMcpServerMock.mockClear();
    const originalEnv = { ...process.env };
    const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const configHome = testScratchPath('ccd-missing-config');

    try {
      process.env = {
        ...originalEnv,
        CCD_NETWORK: 'localnet',
        XDG_CONFIG_HOME: configHome,
      };
      const { runCcdSignerMcp } = await import('../../../src/bin/ccd-signer-mcp.js');
      const exitCode = await runCcdSignerMcp([]);

      expect(exitCode).toBe(1);
      expect(stderrWrite).toHaveBeenCalledWith(expect.stringContaining('ccd-signer-mcp: startup failed'));
      expect(runMcpServerMock).not.toHaveBeenCalled();
    } finally {
      process.env = originalEnv;
      stderrWrite.mockRestore();
    }
  });
});
