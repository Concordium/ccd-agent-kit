import { describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';

import { registerYubiKeyCliCommand } from '../../../src/cli/yubikeyCliCommand.js';
import { catalogAfterHardwareMutation, catalogIdentityRoot } from '../../../src/cli/catalogMutation.js';

describe('management commands', () => {
  it('does not register custody-independent location catalog commands', () => {
    const program = new Command().exitOverride();
    registerYubiKeyCliCommand({ program, stdout: [], stderr: [], runNested: async () => {} });

    const signingKey = program.commands.find(command => command.name() === 'signing-key');
    expect(signingKey?.commands.map(command => command.name())).toEqual(['generate', 'import', 'adopt']);
  });

  it('routes pin status, unlock, and lock through one directly-created hardware service', async () => {
    const close = vi.fn();
    const hardware = {
      inspectDevice: vi.fn(async () => ({ serial: '123', pinStatus: { status: 'required', retries: 3 } })),
      unlockDevice: vi.fn(async () => ({ serial: '123' })),
      lockDevice: vi.fn(async () => ({ serial: '123' })),
      close,
    };
    const stdout: string[] = [];
    const stderr: string[] = [];
    const program = new Command().exitOverride();
    registerYubiKeyCliCommand({
      program,
      stdout,
      stderr,
      runNested: async () => {},
      serviceFactory: () => hardware as never,
      interactionFactory: () => ({
        promptPin: async () => 'hidden',
        promptManagementKey: async () => '',
        confirm: async () => true,
      }),
    });
    await program.parseAsync(['device', 'pin-status', '--device', '123'], { from: 'user' });
    await program.parseAsync(['device', 'unlock', '--device', '123'], { from: 'user' });
    await program.parseAsync(['device', 'lock', '--device', '123'], { from: 'user' });
    expect(hardware.inspectDevice).toHaveBeenCalledWith('123');
    expect(hardware.unlockDevice).toHaveBeenCalledWith(expect.objectContaining({ serial: '123' }));
    expect(hardware.lockDevice).toHaveBeenCalledWith({ serial: '123' });
    expect(close).toHaveBeenCalledTimes(3);
  });

  it('classifies identity-root catalog failure without recommending regeneration', async () => {
    await expect(
      catalogIdentityRoot(async () => {
        throw new Error('disk full');
      }),
    ).rejects.toThrow(/remains on hardware.*catalog update did not complete.*do not regenerate/i);
  });

  it('returns successful catalog results and preserves the cause of synchronous partial failures', async () => {
    await expect(catalogAfterHardwareMutation(() => ({ saved: true }), 'partial')).resolves.toEqual({ saved: true });
    const cause = new Error('disk full');
    await expect(catalogAfterHardwareMutation(() => { throw cause; }, 'partial')).rejects.toMatchObject({
      message: 'partial', cause,
    });
  });
});
