import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import {
  loadAccountLabels,
  loadSignerInventory,
  registerYubiKey,
  setYubiKeyGenerationDefaults,
  upsertSignerInventoryKey,
} from '@ccd-agent-kit/config-utils';
import { ed25519PublicKey } from '@ccd-agent-kit/sdk-utils';

import { registerSigningKeyCliCommand } from '../../../src/cli/signingKeyCliCommand.js';
import { registerAccountLabelCliCommand } from '../../../src/cli/accountLabelCliCommand.js';
import { registerYubiKeyCliCommand } from '../../../src/cli/yubikeyCliCommand.js';
import { registerSourceCliCommand } from '../../../src/cli/sourceCliCommand.js';
import { resolveYubiKeySelector } from '../../../src/cli/yubikeySelector.js';
import { setupCliTestEnv, type CliTestEnv } from '../../helpers/testEnv.js';

const PUBLIC_KEY = ed25519PublicKey.require('11'.repeat(32));

describe('management commands', () => {
  let env: CliTestEnv;
  beforeEach(() => {
    env = setupCliTestEnv('management-');
  });
  afterEach(() => env.restore());

  it('converts signing-material labels in both directions without changing omitted text', async () => {
    upsertSignerInventoryKey({
      publicKey: PUBLIC_KEY,
      scheme: 'Ed25519',
      signingModule: 'test',
      backend: {},
      label: 'same',
    });
    const program = programFor((root, stdout, stderr) => registerSigningKeyCliCommand({ program: root, stdout, stderr }));
    await program.parseAsync(['signing-key', 'label', 'set', '--signing-key', PUBLIC_KEY, '--mode', 'soft'], {
      from: 'user',
    });
    expect(loadSignerInventory().keys[`ed25519:${PUBLIC_KEY}`]?.label).toBe('@same');
    await program.parseAsync(['signing-key', 'label', 'set', '--signing-key', PUBLIC_KEY, '--mode', 'hard'], {
      from: 'user',
    });
    expect(loadSignerInventory().keys[`ed25519:${PUBLIC_KEY}`]?.label).toBe('same');
  });

  it('lists and inspects signing material across custody backends', async () => {
    upsertSignerInventoryKey({
      publicKey: PUBLIC_KEY,
      scheme: 'Ed25519',
      signingModule: 'software',
      backend: { keyRef: 'local' },
      label: 'shared',
    });
    upsertSignerInventoryKey({
      publicKey: PUBLIC_KEY,
      scheme: 'Ed25519',
      signingModule: 'yubikey-piv',
      backend: { devices: [{ kind: 'yubikey', serial: '123', slot: '9c' }] },
    });
    const stdout: string[] = [];
    const program = new Command().exitOverride();
    registerSigningKeyCliCommand({ program, stdout, stderr: [] });
    await program.parseAsync(['signing-key', 'list'], { from: 'user' });
    await program.parseAsync(['signing-key', 'inspect', '--signing-key', 'shared'], { from: 'user' });
    expect(stdout.join('\n')).toContain('software');
    expect(stdout.join('\n')).toContain('yubikey-piv');
    expect(stdout.join('\n')).toContain(PUBLIC_KEY);
  });

  it('preserves account label text during mode conversion and state on invalid changes', async () => {
    const program = programFor((root, stdout, stderr) => registerAccountLabelCliCommand({ program: root, stdout, stderr }));
    const run = (...args: string[]) => program.parseAsync(['account', 'label', 'set', '--network', 'mainnet', ...args], { from: 'user' });
    await run('--address', 'addr', '--label', 'same');
    expect(loadAccountLabels('9dd9ca4d19e9393877d2c44b70f89acb')).toEqual({ same: 'addr' });
    await run('--address', 'addr', '--mode', 'soft');
    const expected = { '@same': 'addr' };
    const labels = () => loadAccountLabels('9dd9ca4d19e9393877d2c44b70f89acb');
    expect(labels()).toEqual(expected);
    for (const args of [
      ['--address', 'addr', '--label', 'changed', '--mode', 'invalid'],
      ['--address', 'unlabeled', '--mode', 'hard'],
    ]) {
      await expect(run(...args)).rejects.toThrow();
      expect(labels()).toEqual(expected);
    }
  });

  it('resolves registered friendly device selectors without granting unknown names meaning', () => {
    registerYubiKey({ name: 'office', serial: '123' });
    expect(resolveYubiKeySelector('office')).toBe('123');
    expect(resolveYubiKeySelector('456')).toBe('456');
    expect(() => resolveYubiKeySelector('unknown')).toThrow(/not registered/i);
  });

  it('adopts an inspected Ed25519 slot without deriving a label from the device name', async () => {
    registerYubiKey({ name: 'office', serial: '123' });
    const hardware = fakeSigningHardware({ status: 'occupied', algorithm: 'Ed25519', publicKey: PUBLIC_KEY });
    const program = yubiProgram(hardware);
    await program.parseAsync(['signing-key', 'adopt', '--backend', 'yubikey-piv', '--device', 'office', '--slot', '9c'], {
      from: 'user',
    });
    const entry = loadSignerInventory().keys[`ed25519:${PUBLIC_KEY}`];
    expect(entry?.label).toBeUndefined();
    expect(entry?.backends[0]?.backend).toMatchObject({ devices: [{ serial: '123', slot: '9c' }] });
  });

  it('rejects adoption when the inspected slot is empty without catalog writes', async () => {
    const hardware = fakeSigningHardware({ status: 'empty' });
    await expect(
      yubiProgram(hardware).parseAsync(['signing-key', 'adopt', '--backend', 'yubikey-piv', '--device', '123', '--slot', '9c'], {
        from: 'user',
      }),
    ).rejects.toThrow(/occupied Ed25519/i);
    expect(loadSignerInventory().keys).toEqual({});
  });

  it('uses persisted generation defaults and explicit overrides', async () => {
    setYubiKeyGenerationDefaults({ defaults: { slot: '82', pinPolicy: 'once', touchPolicy: 'cached' }, serial: '123' });
    const hardware = fakeSigningHardware({ status: 'empty' });
    hardware.generateEd25519Key = vi.fn(async (_request: never) => ({
      serial: '123',
      slot: '82',
      pinPolicy: 'always',
      touchPolicy: 'cached',
      publicKey: PUBLIC_KEY,
      readerName: 'fake',
      replacedExistingKey: false,
    })) as never;
    await yubiProgram(hardware).parseAsync(
      ['signing-key', 'generate', '--backend', 'yubikey-piv', '--device', '123', '--pin-policy', 'always'],
      { from: 'user' },
    );
    expect(hardware.generateEd25519Key).toHaveBeenCalledWith(
      expect.objectContaining({ slot: '82', pinPolicy: 'always', touchPolicy: 'cached' }),
    );
  });

  it('rejects an absent catalog location without consulting hardware', async () => {
    const hardware = fakeSigningHardware({ status: 'empty' });
    await expect(yubiProgram(hardware).parseAsync([
      'signing-key', 'locations', 'forget', '--signing-key', PUBLIC_KEY,
      '--backend', 'yubikey-piv',
      '--location', '{"kind":"yubikey","serial":"123","slot":"9c"}',
    ], { from: 'user' })).rejects.toThrow(/not in the inventory/i);
    expect(hardware.inspectDevice).not.toHaveBeenCalled();
  });

  it('forgets the final generic YubiKey catalog location without consulting or changing hardware', async () => {
    upsertSignerInventoryKey({
      publicKey: PUBLIC_KEY,
      scheme: 'Ed25519',
      signingModule: 'yubikey-piv',
      backend: { devices: [{ kind: 'yubikey', serial: '123', slot: '9c' }] },
    });
    const hardware = fakeSigningHardware({ status: 'occupied', algorithm: 'Ed25519', publicKey: PUBLIC_KEY });

    await yubiProgram(hardware).parseAsync([
      'signing-key', 'locations', 'forget', '--signing-key', PUBLIC_KEY,
      '--backend', 'yubikey-piv',
      '--location', '{"kind":"yubikey","serial":"123","slot":"9c"}',
    ], { from: 'user' });

    expect(loadSignerInventory().keys[`ed25519:${PUBLIC_KEY}`]).toBeUndefined();
    expect(hardware.inspectDevice).not.toHaveBeenCalled();
    expect(hardware.generateEd25519Key).not.toHaveBeenCalled();
    expect(hardware.importEd25519Key).not.toHaveBeenCalled();
  });

  it('routes identity-root catalog operations and rejects malformed ordering', async () => {
    const methods = {
      read: vi.fn(async () => ({ version: 1, sources: { 'ir:abcdefghijklmno': {
        label: 'root', rootPublicKey: `04${'11'.repeat(64)}`, rootPublicKeyFingerprint: '22'.repeat(32),
        recipeVersion: 1, backends: [{ backend: 'yubikey-piv', locations: [{ serial: '1' }] }],
      } } })),
      setLabel: vi.fn(async () => ({})), removeLabel: vi.fn(async () => ({})), setDefault: vi.fn(async () => ({})),
      forgetLocation: vi.fn(async () => ({})), reorderBackends: vi.fn(async () => ({})), reorderLocations: vi.fn(async () => ({})),
    };
    const program = programFor((root, stdout) =>
      registerSourceCliCommand({ program: root, stdout, registryFactory: () => methods as never }));
    const commands = [
      ['identity-root', 'list'],
      ['identity-root', 'inspect', '--identity-root', 'root'],
      ['identity-root', 'label', 'set', '--identity-root', 'root', '--mode', 'soft'],
      ['identity-root', 'label', 'remove', '--identity-root', 'root'],
      ['identity-root', 'default', 'show'],
      ['identity-root', 'default', 'set', '--identity-root', 'root'],
      ['identity-root', 'forget', '--identity-root', 'root'],
      ['identity-root', 'locations', 'forget', '--identity-root', 'root', '--backend', 'yubikey-piv', '--location', '{"serial":"1"}'],
      ['identity-root', 'backend', 'order', '--identity-root', 'root', '--backends', 'a,b'],
      ['identity-root', 'locations', 'order', '--identity-root', 'root', '--backend', 'a', '--locations', '[{"serial":"1"}]'],
    ];
    for (const command of commands) await program.parseAsync(command, { from: 'user' });
    expect(methods.setLabel).toHaveBeenNthCalledWith(1, 'ir:abcdefghijklmno', { mode: 'soft' });
    expect(methods.setLabel).toHaveBeenNthCalledWith(2, 'ir:abcdefghijklmno', { operation: 'remove' });
    await program.parseAsync(
      ['identity-root', 'label', 'set', '--identity-root', 'root', '--label', 'renamed'], { from: 'user' },
    );
    expect(methods.setLabel).toHaveBeenNthCalledWith(3, 'ir:abcdefghijklmno', { label: 'renamed' });
    expect(methods.forgetLocation).toHaveBeenNthCalledWith(1, 'root', 'all');
    expect(methods.forgetLocation).toHaveBeenNthCalledWith(2, 'root', { backend: 'yubikey-piv', location: { serial: '1' } });
    expect(methods.reorderBackends).toHaveBeenCalledWith('root', ['a', 'b']);
    expect(methods.reorderLocations).toHaveBeenCalledWith('root', 'a', [{ serial: '1' }]);
    await expect(program.parseAsync(
      ['identity-root', 'backend', 'order', '--identity-root', 'root', '--backends', 'a,'], { from: 'user' },
    )).rejects.toThrow(/comma-separated/i);
    await expect(program.parseAsync(
      ['identity-root', 'locations', 'order', '--identity-root', 'root', '--backend', 'a', '--locations', '[1]'],
      { from: 'user' },
    )).rejects.toThrow(/location objects/i);
    await program.parseAsync(
      ['identity-root', 'label', 'set', '--identity-root', 'ir:abcdefghijklmno', '--mode', 'hard'], { from: 'user' },
    );
    expect(methods.setLabel).toHaveBeenLastCalledWith('ir:abcdefghijklmno', { mode: 'hard' });
    await expect(program.parseAsync(
      ['identity-root', 'remove', '--identity-root', 'root'], { from: 'user' },
    )).rejects.toThrow(/unknown command/i);

    const sharedProgram = programFor((root, stdout) => registerSourceCliCommand({ program: root, stdout }));
    await sharedProgram.parseAsync(['identity-root', 'list'], { from: 'user' });
  });

  it('projects bare identity-root labels', async () => {
    const methods = {
      read: vi.fn(async () => ({ version: 1, sources: { 'ir:abcdefghijklmno': {
        label: '@RootCase', rootPublicKey: `04${'11'.repeat(64)}`, rootPublicKeyFingerprint: '22'.repeat(32),
        recipeVersion: 1, backends: [],
      } } })),
    };
    const stdout: string[] = [];
    const program = new Command().exitOverride();
    registerSourceCliCommand({ program, stdout, registryFactory: () => methods as never });

    await program.parseAsync(['identity-root', 'list'], { from: 'user' });
    await program.parseAsync(['identity-root', 'inspect', '--identity-root', 'rootcase'], { from: 'user' });

    expect(stdout.join('\n')).toContain('"label": "RootCase"');
    expect(stdout.join('\n')).not.toContain('@RootCase');
    expect(stdout.join('\n')).not.toContain('"name"');
  });

});

function programFor(register: (program: Command, stdout: string[], stderr: string[]) => void): Command {
  const program = new Command().exitOverride();
  register(program, [], []);
  return program;
}

function fakeSigningHardware(slot: Record<string, unknown>) {
  return {
    inspectDevice: vi.fn(async () => ({
      serial: '123',
      slots: [{ slot: '9c', ...slot }],
      pinStatus: { status: 'required', retries: 3 },
    })),
    generateEd25519Key: vi.fn(),
    importEd25519Key: vi.fn(),
    listDevices: vi.fn(),
    listAndInspectDeviceKeys: vi.fn(),
    unlockDevice: vi.fn(),
    lockDevice: vi.fn(),
    signEd25519Digest: vi.fn(),
    close: vi.fn(),
  };
}

function yubiProgram(hardware: ReturnType<typeof fakeSigningHardware>, stdout: string[] = [], confirm = async () => true): Command {
  const program = new Command().exitOverride();
  registerSigningKeyCliCommand({ program, stdout, stderr: [] });
  registerYubiKeyCliCommand({
    program,
    stdout,
    stderr: [],
    runNested: async () => {},
    serviceFactory: () => hardware as never,
    identityServiceFactory: () => ({
      listDevices: async () => [], inspectRoot: async () => ({ status: 'unknown' }),
    }) as never,
    interactionFactory: () => ({
      promptPin: async () => 'hidden',
      promptManagementKey: async () => '',
      confirm,
    }),
  });
  return program;
}
