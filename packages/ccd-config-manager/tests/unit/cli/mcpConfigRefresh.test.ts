import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const notify = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock('@ccd-agent-kit/config-utils', async importOriginal => ({
  ...await importOriginal<typeof import('@ccd-agent-kit/config-utils')>(),
  getSigningModuleEnabled: vi.fn(() => true),
  isIdentitySourceBackendEnabled: vi.fn(() => true),
  notifyMcpInstancesConfigChanged: notify,
  setIdentitySourceBackendPolicy: vi.fn(),
  setSigningModulePolicy: vi.fn(),
}));

import { runCli } from '../../../src/bin/ccd-config-manager.js';
import { classifyMcpConfigRefreshTargets } from '../../../src/cli/mcpConfigRefresh.js';

describe('MCP config refresh classification', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it.each([
    [['signing-key', 'generate'], {}, ['signer']],
    [['signing-key', 'import'], {}, ['signer']],
    [['signing-key', 'adopt'], {}, ['signer']],
    [['signing-key', 'forget'], {}, ['signer']],
    [['signing-key', 'backend', 'order'], {}, ['signer']],
    [['signing-key', 'locations', 'order'], {}, ['signer']],
    [['signing-key', 'locations', 'forget'], {}, ['signer']],
    [['storage', 'init'], {}, []],
    [['storage', 'enable'], {}, ['signer']],
    [['storage', 'disable'], {}, ['signer']],
    [['storage', 'change-password'], {}, []],
    [['storage', 'integrity'], { fix: true }, ['signer']],
    [['storage', 'integrity'], { fix: false }, []],
    [['service', 'signer', 'module', 'disable'], {}, ['signer']],
    [['service', 'id-manager', 'module', 'enable'], {}, ['idManager']],
    [['identity-root', 'generate'], {}, ['idManager']],
    [['identity-root', 'import'], {}, ['idManager']],
    [['identity-root', 'adopt'], {}, ['idManager']],
    [['identity-root', 'locations', 'forget'], {}, ['idManager']],
    [['identity-root', 'forget'], {}, ['idManager']],
    [['identity-root', 'default', 'set'], {}, ['idManager']],
    [['identity-root', 'backend', 'order'], {}, ['idManager']],
    [['identity-root', 'locations', 'order'], {}, ['idManager']],
    [['identity-root', 'label', 'set'], {}, []],
    [['identity-root', 'label', 'remove'], {}, []],
    [['device', 'unlock'], {}, ['signer', 'idManager']],
    [['device', 'lock'], {}, ['signer', 'idManager']],
    [['device', 'integrity'], { fix: true }, ['signer', 'idManager']],
    [['network', 'default', 'set'], {}, []],
    [['signing-key', 'label', 'set'], {}, []],
  ] as const)('classifies %j with only its documented refresh targets', (path, options, expected) => {
    expect(classifyMcpConfigRefreshTargets(path, options)).toEqual(expected);
  });

  it('runs notification only after successful relevant commands and contains delivery failures', async () => {
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    await expect(runCli(['service', 'signer', 'module', 'enable', '--module', 'software-signer'])).resolves.toBe(0);
    expect(notify).toHaveBeenLastCalledWith(['signer']);

    await expect(runCli(['service', 'signer', 'module', 'inspect', '--module', 'software-signer'])).resolves.toBe(0);
    await expect(runCli(['service', 'signer', 'module', 'enable', '--module', 'unknown'])).resolves.toBe(2);
    expect(notify).toHaveBeenCalledTimes(1);

    notify.mockRejectedValueOnce(new Error('runtime unavailable'));
    await expect(runCli(['service', 'id-manager', 'module', 'disable', '--backend', 'yubikey-piv']))
      .resolves.toBe(0);
    expect(notify).toHaveBeenLastCalledWith(['idManager']);
  });

  it('lists signer module policy without sending a runtime refresh', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    await expect(runCli(['service', 'signer', 'module', 'list'])).resolves.toBe(0);

    const output = stdout.mock.calls.flat().join('');
    expect(output).toContain('software-signer');
    expect(output).toContain('yubikey-piv');
    expect(notify).not.toHaveBeenCalled();
  });
});
