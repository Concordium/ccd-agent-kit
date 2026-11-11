import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { notifyMcpInstancesConfigChanged } from '@ccd-agent-kit/config-utils';
import { startIdentityManagerInstanceControlServer } from '../../src/core/instance/identityManagerInstance.js';

describe('identity-manager instance control', () => {
  let scratch: string;
  let originalRuntime: string | undefined;
  let originalState: string | undefined;

  beforeEach(() => {
    originalRuntime = process.env.XDG_RUNTIME_DIR;
    originalState = process.env.XDG_STATE_HOME;
    scratch = join(process.cwd(), '.test-tmp', `id-instance-${process.pid}-${Date.now()}`);
    mkdirSync(scratch, { recursive: true });
    process.env.XDG_RUNTIME_DIR = scratch;
    process.env.XDG_STATE_HOME = join(scratch, 'state');
  });

  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
    if (originalRuntime === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = originalRuntime;
    if (originalState === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = originalState;
  });

  it('owns sources-refresh and contains refresh failures behind best-effort delivery', async () => {
    const refreshSources = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('private refresh failure'));
    const control = await startIdentityManagerInstanceControlServer({ refreshSources });
    try {
      expect(control.instance).toEqual({
        instanceId: expect.any(String),
        pid: expect.any(Number),
        parentPid: expect.any(Number),
        startedAt: expect.any(String),
        lastSeenAt: expect.any(String),
      });
      expect(control.instance).not.toHaveProperty('authToken');
      expect(control.instance).not.toHaveProperty('socketPath');

      await expect(notifyMcpInstancesConfigChanged(['idManager'])).resolves.toBeUndefined();
      await expect(notifyMcpInstancesConfigChanged(['idManager'])).resolves.toBeUndefined();
      expect(refreshSources).toHaveBeenCalledTimes(2);
    } finally {
      await control.close();
    }
  });
});
