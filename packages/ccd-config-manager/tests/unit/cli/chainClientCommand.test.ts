import { beforeEach, describe, expect, it, vi } from 'vitest';

const config = vi.hoisted(() => ({
  loadChainClientConfig: vi.fn(),
  resetChainClientConfig: vi.fn(),
  updateChainClientStartupRefreshConfig: vi.fn(),
}));

vi.mock('@ccd-agent-kit/config-utils', () => config);

import { runChainClientCommand } from '../../../src/cli/chainClientCommand.js';

const configured = {
  accountCredentials: {
    startupRefresh: { concurrency: 4, enabled: true, failureRetry: '5m', maxAge: '24h' },
  },
};

describe('runChainClientCommand', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    config.loadChainClientConfig.mockReturnValue(configured);
    config.resetChainClientConfig.mockReturnValue(configured);
    config.updateChainClientStartupRefreshConfig.mockReturnValue(configured);
  });

  it('renders structured producer configuration', async () => {
    const result = await run({ kind: 'show' });
    expect(result.code).toBe(0);
    expect(result.stdout).toEqual([
      'ccd-chain-client configuration:',
      '  accountCredentials.startupRefresh.enabled: true',
      '  accountCredentials.startupRefresh.maxAge: 24h',
      '  accountCredentials.startupRefresh.failureRetry: 5m',
      '  accountCredentials.startupRefresh.concurrency: 4',
    ]);
  });

  it('normalizes a valid patch once and renders the producer result', async () => {
    const result = await run({ kind: 'startup-refresh-set', concurrency: '5', enabled: 'false' });
    expect(result.code).toBe(0);
    expect(config.updateChainClientStartupRefreshConfig).toHaveBeenCalledWith({ concurrency: 5, enabled: false });
    expect(result.stdout[0]).toBe('ccd-chain-client configuration:');
  });

  it('handles no-op, validation, and producer-error branches', async () => {
    expect(await run({ kind: 'startup-refresh-set' })).toMatchObject({ code: 0, stdout: ['No changes specified.'] });
    expect((await run({ kind: 'startup-refresh-set', maxAge: 'soon' })).code).toBe(2);

    config.resetChainClientConfig.mockImplementationOnce(() => {
      throw new Error('read only');
    });
    expect(await run({ kind: 'startup-refresh-reset' })).toMatchObject({ code: 2, stderr: ['read only'] });
  });

});

async function run(request: Parameters<typeof runChainClientCommand>[0]['request']) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await runChainClientCommand({ request, stdout, stderr });
  return { code, stderr, stdout };
}
