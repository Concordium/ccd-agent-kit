import { beforeEach, describe, expect, it, vi } from 'vitest';
import { testScratchPath } from '../helpers/tempDir.js';

const { startHttpMock, startStdioMock } = vi.hoisted(() => ({
  startHttpMock: vi.fn(async () => undefined),
  startStdioMock: vi.fn(async () => ({ close: vi.fn(async () => undefined) })),
}));

vi.mock('../../src/mcp/transports/httpTransport.js', () => ({
  startHttp: startHttpMock,
}));

vi.mock('../../src/mcp/transports/stdioTransport.js', () => ({
  startStdio: startStdioMock,
}));

import { main } from '../../src/bin/ccd-chain-client-mcp.js';

describe('ccd-chain-client-mcp bin', () => {
  beforeEach(() => {
    startHttpMock.mockClear();
    startStdioMock.mockClear();
  });

  it('prints help without starting a transport', async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];

    const exitCode = await main(
      ['--help'],
      {},
      { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) },
    );

    expect(exitCode).toBe(0);
    expect(stdout.join('\n')).toContain('Usage: ccd-chain-client-mcp');
    expect(stderr).toEqual([]);
  });

  it('prints network diagnostics when startup config parsing fails', async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const configHome = testScratchPath('ccd-missing-config');

    const exitCode = await main(
      [],
      { CCD_NETWORK: 'localnet', XDG_CONFIG_HOME: configHome },
      { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) },
    );

    expect(exitCode).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr.join('\n')).toContain("Network 'localnet' not found.");
    expect(stderr.join('\n')).toContain(`${configHome}/ccd-agent-kit/networks.json`);
    expect(stderr.join('\n')).toContain('available networks: mainnet, testnet');
    expect(stderr.join('\n')).toContain('Set CCD_NETWORK to an available network');
  });

  it('starts the stdio transport by default', async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];

    const exitCode = await main(
      [],
      { XDG_CONFIG_HOME: testScratchPath('ccd-default-config'), CCD_ACCOUNT_CREDENTIALS_STARTUP_REFRESH: 'false' },
      { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) },
    );

    expect(exitCode).toBe(0);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual([]);
    expect(startStdioMock).toHaveBeenCalledTimes(1);
    expect(startHttpMock).not.toHaveBeenCalled();
  });

  it('keeps process.env in place when the default environment object is used', async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const originalEnv = process.env;
    const previousStartupRefresh = process.env.CCD_ACCOUNT_CREDENTIALS_STARTUP_REFRESH;
    process.env.CCD_ACCOUNT_CREDENTIALS_STARTUP_REFRESH = 'false';

    const exitCode = await main([], process.env, {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    });

    if (previousStartupRefresh === undefined) {
      delete process.env.CCD_ACCOUNT_CREDENTIALS_STARTUP_REFRESH;
    } else {
      process.env.CCD_ACCOUNT_CREDENTIALS_STARTUP_REFRESH = previousStartupRefresh;
    }

    expect(exitCode).toBe(0);
    expect(process.env).toBe(originalEnv);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual([]);
    expect(startStdioMock).toHaveBeenCalledTimes(1);
  });

  it('starts the HTTP transport when configured', async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];

    const exitCode = await main(
      [],
      {
        MCP_TRANSPORT: 'http',
        MCP_HTTP_PORT: '3001',
        XDG_CONFIG_HOME: testScratchPath('ccd-http-config'),
        CCD_ACCOUNT_CREDENTIALS_STARTUP_REFRESH: 'false',
      },
      { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) },
    );

    expect(exitCode).toBe(0);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual([]);
    expect(startHttpMock).toHaveBeenCalledTimes(1);
    expect(startStdioMock).not.toHaveBeenCalled();
  });

  it('reports transport startup failures', async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    startStdioMock.mockRejectedValueOnce(new Error('transport failed'));

    const exitCode = await main(
      [],
      { XDG_CONFIG_HOME: testScratchPath('ccd-startup-config'), CCD_ACCOUNT_CREDENTIALS_STARTUP_REFRESH: 'false' },
      { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) },
    );

    expect(exitCode).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr.join('\n')).toContain('ccd-chain-client-mcp: startup failed: Error: transport failed');
  });
});
