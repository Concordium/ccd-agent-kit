import * as config from '@ccd-agent-kit/config-utils';
import { Command } from 'commander';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { registerSignerInstanceCliCommand } from '../../../src/cli/signerInstanceCliCommand.js';

vi.mock('@ccd-agent-kit/config-utils', async importOriginal => ({
  ...(await importOriginal<typeof import('@ccd-agent-kit/config-utils')>()),
  listSignerInstances: vi.fn(),
  requestSignerInstanceLock: vi.fn(),
  requestSignerInstanceUnlock: vi.fn(),
}));

const lockedInstance: config.SignerInstanceRegistryEntry = {
  instanceId: 'selected', status: 'locked',
  unlockCommand: 'ccd-config-manager service signer unlock --instance selected',
};

describe('signer instance command orchestration', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(config.listSignerInstances).mockReturnValue([lockedInstance]);
    vi.mocked(config.requestSignerInstanceUnlock).mockResolvedValue({ ok: true, status: 'unlocked' });
    vi.mocked(config.requestSignerInstanceLock).mockResolvedValue({ ok: true, status: 'locked' });
  });

  it('dispatches unlock only after target preflight and password input, then dispatches lock without prompting', async () => {
    const order: string[] = [];
    vi.mocked(config.listSignerInstances).mockImplementation(() => { order.push('list'); return [lockedInstance]; });
    vi.mocked(config.requestSignerInstanceUnlock).mockImplementation(async () => {
      order.push('unlock'); return { ok: true, status: 'unlocked' };
    });
    vi.mocked(config.requestSignerInstanceLock).mockImplementation(async () => {
      order.push('lock'); return { ok: true, status: 'locked' };
    });
    const prompt = vi.fn(async () => { order.push('password'); return 'pw'; });
    const command = makeCommand(prompt);

    await command.program.parseAsync(['service', 'signer', 'unlock', '--instance', 'selected'], { from: 'user' });
    await command.program.parseAsync(['service', 'signer', 'lock', '--instance', 'selected'], { from: 'user' });

    expect(order).toEqual(['list', 'password', 'unlock', 'list', 'lock']);
    expect(config.requestSignerInstanceUnlock).toHaveBeenCalledWith({ instanceId: 'selected', password: 'pw' });
    expect(config.requestSignerInstanceLock).toHaveBeenCalledWith({ instanceId: 'selected' });
    expect(prompt).toHaveBeenCalledOnce();
    expect(command.exitCodes).toEqual([0, 0]);
  });

  it('rejects a missing target before prompting or sending a control request', async () => {
    vi.mocked(config.listSignerInstances).mockReturnValue([]);
    const prompt = vi.fn(async () => 'unused');
    const command = makeCommand(prompt);

    await command.program.parseAsync(['service', 'signer', 'unlock', '--instance', 'missing'], { from: 'user' });
    await command.program.parseAsync(['service', 'signer', 'lock', '--instance', 'missing'], { from: 'user' });

    expect(prompt).not.toHaveBeenCalled();
    expect(config.requestSignerInstanceUnlock).not.toHaveBeenCalled();
    expect(config.requestSignerInstanceLock).not.toHaveBeenCalled();
    expect(command.exitCodes).toEqual([1, 1]);
    expect(command.stderr.join('\n')).toMatch(/not running/i);
  });

  it('turns prompt and producer failures into truthful nonzero nested results', async () => {
    const promptFailure = makeCommand(async () => { throw new Error('password cancelled'); });
    await promptFailure.program.parseAsync(
      ['service', 'signer', 'unlock', '--instance', 'selected'], { from: 'user' },
    );
    expect(config.requestSignerInstanceUnlock).not.toHaveBeenCalled();
    expect(promptFailure.exitCodes).toEqual([1]);
    expect(promptFailure.stderr).toEqual(['password cancelled']);

    vi.mocked(config.requestSignerInstanceUnlock).mockRejectedValue(new Error('authenticated request denied'));
    const requestFailure = makeCommand(async () => 'pw');
    await requestFailure.program.parseAsync(
      ['service', 'signer', 'unlock', '--instance', 'selected'], { from: 'user' },
    );
    expect(requestFailure.exitCodes).toEqual([1]);
    expect(requestFailure.stdout).toEqual([]);
    expect(requestFailure.stderr).toEqual(['authenticated request denied']);
  });

  it('renders only locked-instance guidance when requested', async () => {
    vi.mocked(config.listSignerInstances).mockReturnValue([
      lockedInstance,
      { instanceId: 'open', status: 'unlocked', unlockCommand: 'do-not-print' },
    ]);
    const command = makeCommand(async () => 'pw');

    await command.program.parseAsync(['service', 'signer', 'instances', '--unlock-commands'], { from: 'user' });
    expect(command.stdout).toEqual([lockedInstance.unlockCommand]);
  });
});

function makeCommand(promptUnlockPassword: () => Promise<string>) {
  const program = new Command().exitOverride();
  const stderr: string[] = [];
  const stdout: string[] = [];
  const exitCodes: number[] = [];
  registerSignerInstanceCliCommand({
    program, stderr, stdout, promptUnlockPassword,
    runNested: async result => { exitCodes.push(await result); },
  });
  return { exitCodes, program, stderr, stdout };
}
