import { beforeEach, describe, expect, it, vi } from 'vitest';

const dependencies = vi.hoisted(() => ({
  createCachingNetworkClientProvider: vi.fn(() => ({ get: vi.fn() })),
  createServerFactory: vi.fn(() => vi.fn()),
  getNetworksFilePath: vi.fn(() => '.test-tmp/config/ccd-agent-kit/networks.json'),
  listNetworks: vi.fn(() => ['mainnet', 'testnet']),
  parseConfig: vi.fn(),
  startHttp: vi.fn(async () => undefined),
  startStartupRefresh: vi.fn(),
  startStdio: vi.fn(async () => undefined),
}));

vi.mock('@ccd-agent-kit/config-utils', () => ({
  getNetworksFilePath: dependencies.getNetworksFilePath,
  listNetworks: dependencies.listNetworks,
}));
vi.mock('../../../src/config.js', () => ({ parseConfig: dependencies.parseConfig }));
vi.mock('../../../src/mcp/server.js', () => ({ createServerFactory: dependencies.createServerFactory }));
vi.mock('../../../src/mcp/startupRefresh.js', () => ({ startStartupRefresh: dependencies.startStartupRefresh }));
vi.mock('../../../src/mcp/toolPlumbing/networkClient.js', () => ({
  createCachingNetworkClientProvider: dependencies.createCachingNetworkClientProvider,
}));
vi.mock('../../../src/mcp/transports/httpTransport.js', () => ({ startHttp: dependencies.startHttp }));
vi.mock('../../../src/mcp/transports/stdioTransport.js', () => ({ startStdio: dependencies.startStdio }));

import { main } from '../../../src/bin/ccd-chain-client-mcp.js';

const config = {
  accountCredentials: { startupRefresh: { concurrency: 1, enabled: false, failureRetryMs: 1, maxAgeMs: 1 } },
  defaultNetworkSource: 'config',
  grpc: { endpoint: 'node:20000', timeoutMs: 15_000, tls: true },
  network: 'testnet',
  resolvedNetwork: { config: {}, name: 'testnet' },
  transport: 'stdio',
};

describe('ccd-chain-client-mcp entrypoint', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dependencies.parseConfig.mockReturnValue({ ok: true, value: config });
  });

  it('prints help through the default IO without creating runtime dependencies', async () => {
    const stdout = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await expect(main(['--help'], {})).resolves.toBe(0);

    expect(stdout).toHaveBeenCalledWith(expect.stringContaining('Usage: ccd-chain-client-mcp'));
    expect(dependencies.parseConfig).not.toHaveBeenCalled();
    stdout.mockRestore();
  });

  it('reports every config error with network diagnostics', async () => {
    dependencies.parseConfig.mockReturnValue({ ok: false, errors: ['bad network', 'bad transport'] });
    const stderr: string[] = [];

    const result = await main([], {}, { stdout: vi.fn(), stderr: (line) => stderr.push(line) });

    expect(result).toBe(1);
    expect(stderr).toEqual([
      'ccd-chain-client-mcp: config error: bad network',
      'ccd-chain-client-mcp: config error: bad transport',
      'ccd-chain-client-mcp: network config: .test-tmp/config/ccd-agent-kit/networks.json',
      'ccd-chain-client-mcp: available networks: mainnet, testnet',
      'ccd-chain-client-mcp: Set CCD_NETWORK to an available network or update the ccd-agent-kit network registry.',
    ]);
    expect(dependencies.startStdio).not.toHaveBeenCalled();
  });

  it('reports transport startup failures and restores process.env', async () => {
    const originalEnv = process.env;
    const stderr: string[] = [];
    dependencies.startStdio.mockRejectedValueOnce(new Error('cannot listen'));

    const result = await main(
      [],
      { TEST_ENTRYPOINT_ENV: 'set' },
      {
        stdout: vi.fn(),
        stderr: (line) => stderr.push(line),
      },
    );

    expect(result).toBe(1);
    expect(stderr.join('\n')).toContain('startup failed: Error: cannot listen');
    expect(process.env).toBe(originalEnv);
  });

  it('starts HTTP with the configured server factory', async () => {
    const httpConfig = { ...config, http: { path: '/rpc', port: 3010 }, transport: 'http' };
    dependencies.parseConfig.mockReturnValue({ ok: true, value: httpConfig });

    await expect(main([], {}, { stdout: vi.fn(), stderr: vi.fn() })).resolves.toBe(0);

    expect(dependencies.startHttp).toHaveBeenCalledWith(
      httpConfig,
      dependencies.createServerFactory.mock.results[0]?.value,
    );
    expect(dependencies.startStdio).not.toHaveBeenCalled();
  });

  it('uses the existing process environment without replacing it', async () => {
    const originalEnv = process.env;

    await expect(main([], process.env, { stdout: vi.fn(), stderr: vi.fn() })).resolves.toBe(0);

    expect(dependencies.parseConfig).toHaveBeenCalledWith(originalEnv);
    expect(process.env).toBe(originalEnv);
    expect(dependencies.startStdio).toHaveBeenCalledOnce();
  });
});
