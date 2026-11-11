import * as config from '@ccd-agent-kit/config-utils';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

vi.mock('@ccd-agent-kit/config-utils', async importOriginal => ({
  ...(await importOriginal<typeof import('@ccd-agent-kit/config-utils')>()),
  listIdentityManagerInstances: vi.fn(),
}));

import { runCli } from '../../../src/bin/ccd-config-manager.js';

describe('identity-manager instance commands', () => {
  let stdoutWrite: MockInstance;
  let stderrWrite: MockInstance;

  beforeEach(() => {
    vi.clearAllMocks();
    stdoutWrite = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    stderrWrite = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  });

  afterEach(() => vi.restoreAllMocks());

  it('lists safe identity-manager status and generic process metadata as JSON', async () => {
    vi.mocked(config.listIdentityManagerInstances).mockReturnValue([
      { instanceId: 'id-a', network: 'testnet', pid: 101 },
      { instanceId: 'id-b', lastSeenAt: '2026-10-28T12:00:00.000Z', parentPid: 99 },
    ]);

    await expect(runCli(['service', 'id-manager', 'instances'])).resolves.toBe(0);

    expect(stdoutWrite).toHaveBeenCalledOnce();
    expect(JSON.parse(String(stdoutWrite.mock.calls[0]?.[0]))).toEqual({
      instances: [
        { instanceId: 'id-a', network: 'testnet', pid: 101 },
        { instanceId: 'id-b', lastSeenAt: '2026-10-28T12:00:00.000Z', parentPid: 99 },
      ],
    });
    expect(stderrWrite).not.toHaveBeenCalled();
  });

  it('renders an empty instance list as JSON', async () => {
    vi.mocked(config.listIdentityManagerInstances).mockReturnValue([]);

    await expect(runCli(['service', 'id-manager', 'instances'])).resolves.toBe(0);

    expect(stdoutWrite).toHaveBeenCalledWith(`${JSON.stringify({ instances: [] }, null, 2)}\n`);
    expect(stderrWrite).not.toHaveBeenCalled();
  });

  it('returns nonzero and sanitizes unexpected list failures at the CLI boundary', async () => {
    const failure = Object.assign(new Error('registry unavailable'), { authToken: 'private-token' });
    vi.mocked(config.listIdentityManagerInstances).mockImplementation(() => {
      throw failure;
    });

    await expect(runCli(['service', 'id-manager', 'instances'])).resolves.toBe(1);

    expect(stdoutWrite).not.toHaveBeenCalled();
    expect(stderrWrite).toHaveBeenCalledWith(expect.stringContaining('registry unavailable'));
    expect(stderrWrite).not.toHaveBeenCalledWith(expect.stringContaining('private-token'));
  });
});
