import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readHiddenLine } from '@ccd-agent-kit/cli-utils';

import {
  deriveIdentitySourceId,
  IdentitySourceError,
  loadYubiKeyConfig,
  loadYubiKeyRegistrations,
  registerYubiKey,
  type IdentitySourceRegistry,
  type IdentitySourceRegistryDocument,
  type IdentitySourceRecord,
} from '@ccd-agent-kit/config-utils';
import { deriveP256PublicKey, type IdentityRootInspection, type YubiKeyInspection } from '@ccd-agent-kit/piv-utils';
import { ed25519PublicKey } from '@ccd-agent-kit/sdk-utils';
import { registerSourceCliCommand } from '../../../src/cli/sourceCliCommand.js';
import { registerYubiKeyCliCommand } from '../../../src/cli/yubikeyCliCommand.js';
import { runCli } from '../../../src/bin/ccd-config-manager.js';
import {
  fakeIdentityService as fakeIdentityHardware,
  fakeSigningService as fakeYubiKeyService,
  type YubiKeyServiceMock,
} from '../../helpers/hardwareServices.js';
import { setupCliTestEnv, type CliTestEnv } from '../../helpers/testEnv.js';

vi.mock('@ccd-agent-kit/cli-utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ccd-agent-kit/cli-utils')>()),
  readHiddenLine: vi.fn(async () => '11'.repeat(32)),
}));

const runtimeRefresh = vi.hoisted(() => ({
  notify: vi.fn(async () => undefined),
  serviceFactory: vi.fn(),
}));

vi.mock('@ccd-agent-kit/config-utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ccd-agent-kit/config-utils')>()),
  notifyMcpInstancesConfigChanged: runtimeRefresh.notify,
}));
vi.mock('@ccd-agent-kit/piv-utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ccd-agent-kit/piv-utils')>()),
  createNativePivYubiKeyService: runtimeRefresh.serviceFactory,
}));

vi.mock('node:readline/promises', () => ({
  createInterface: () => ({
    question: async (prompt: string) => /Type exactly "([^"]+)"/.exec(prompt)?.[1] ?? '',
    close: vi.fn(),
  }),
}));

const ROOT_PUBLIC_KEY =
  '040217e617f0b6443928278f96999e69a23a4f2c152bdf6d6cdf66e5b80282d4ed194a7debcb97712d2dda3ca85aa8765a56f45fc758599652f2897c65306e5794';
const SOURCE_ID = 'ir:abcdefghijklmno';

describe('hardware management command routing', () => {
  let env: CliTestEnv;

  beforeEach(() => {
    env = setupCliTestEnv('hardware-cli-');
  });
  afterEach(() => env.restore());

  it.each(['adopt'])('uses %s to add a second device location while preserving the existing label and default', async (action) => {
    const hardware = fakeIdentityHardware();
    const registry = fakeSourceRegistry();
    registry.read.mockResolvedValueOnce(sourceDocument({ [SOURCE_ID]: sourceRecord() }, SOURCE_ID));
    await yubiProgram(env, fakeYubiKeyService(), hardware, registry).parseAsync(
      ['identity-root', action, '--backend', 'yubikey-piv', '--device', '456'], { from: 'user' },
    );
    const expected = expect.objectContaining({
      rootPublicKey: ROOT_PUBLIC_KEY, backends: [{ backend: 'yubikey-piv', locations: [{ serial: '456' }] }],
    });
    if (action === 'import') expect(registry.enroll).toHaveBeenCalledWith(expected, { replaceLocations: true });
    else expect(registry.enroll).toHaveBeenCalledWith(expected);
    expect(registry.setDefault).not.toHaveBeenCalled();
  });

  it('does not change an existing root when adoption trust is declined', async () => {
    const registry = fakeSourceRegistry();
    await expect(yubiProgram(env, fakeYubiKeyService(), fakeIdentityHardware(), registry, async () => false).parseAsync(
      ['identity-root', 'adopt', '--backend', 'yubikey-piv', '--device', '456', '--label', 'replacement'], { from: 'user' },
    )).rejects.toThrow(/cancelled/i);
    expect(registry.enroll).not.toHaveBeenCalled();
  });

  it('adopts an observed root without attaching it to an unrelated pinned root', async () => {
    const registry = fakeSourceRegistry();
    const hardware = fakeIdentityHardware();
    const observed = deriveP256PublicKey(Buffer.alloc(32, 3)).toString('hex');
    hardware.inspectRoot.mockResolvedValueOnce(identityRootInspection('456', 'occupied', observed));
    await yubiProgram(env, fakeYubiKeyService(), hardware, registry).parseAsync(
      ['identity-root', 'adopt', '--backend', 'yubikey-piv', '--device', '456'], { from: 'user' },
    );
    expect(registry.enroll).toHaveBeenCalledWith(expect.objectContaining({ rootPublicKey: observed }));
    expect(hardware.close).toHaveBeenCalledOnce();
  });

  it('rejects trailing identity-root scalar characters before hardware or catalog access', async () => {
    vi.mocked(readHiddenLine).mockResolvedValueOnce(`${'11'.repeat(32)}zz`);
    const hardware = fakeIdentityHardware();
    const registry = fakeSourceRegistry();

    await expect(yubiProgram(env, fakeYubiKeyService(), hardware, registry).parseAsync(
      ['identity-root', 'import', '--backend', 'yubikey-piv', '--device', '123'], { from: 'user' },
    )).rejects.toThrow(/private scalar/i);

    expect(hardware.importRoot).not.toHaveBeenCalled();
    expect(registry.enroll).not.toHaveBeenCalled();
  });

  it('rejects a software file option for YubiKey import before prompting or hardware access', async () => {
    vi.mocked(readHiddenLine).mockClear();
    const hardware = fakeYubiKeyService();

    await expect(yubiProgram(env, hardware).parseAsync([
      'signing-key', 'import', '--backend', 'yubikey-piv', '--device', '123', '--file', 'key.json',
    ], { from: 'user' })).rejects.toThrow(/file.*software|software.*file/i);

    expect(readHiddenLine).not.toHaveBeenCalled();
    expect(hardware.importEd25519Key).not.toHaveBeenCalled();
    expect(hardware.generateEd25519Key).not.toHaveBeenCalled();
    expect(hardware.inspectDevice).not.toHaveBeenCalled();
  });

  it.each([
    ['signing-key', 'generate'], ['signing-key', 'import'],
    ['identity-root', 'generate'], ['identity-root', 'import'],
  ])('rejects a malformed label before %s %s hardware mutation', async (purpose, action) => {
    const signing = fakeYubiKeyService(); const identity = fakeIdentityHardware(); const registry = fakeSourceRegistry();
    await expect(yubiProgram(env, signing, identity, registry).parseAsync(
      [purpose, action, '--backend', 'yubikey-piv', '--device', '123', '--label', 'bad label'], { from: 'user' },
    )).rejects.toThrow(/label/i);
    expect(signing.generateEd25519Key).not.toHaveBeenCalled();
    expect(signing.importEd25519Key).not.toHaveBeenCalled();
    expect(identity.generateRoot).not.toHaveBeenCalled();
    expect(identity.importRoot).not.toHaveBeenCalled();
    expect(registry.enroll).not.toHaveBeenCalled();
  });

  it('does not treat a registered YubiKey device name as a signing-key label collision', async () => {
    registerYubiKey({ name: 'office', serial: '123' });
    const signing = fakeYubiKeyService();

    await yubiProgram(env, signing).parseAsync(
      ['signing-key', 'generate', '--backend', 'yubikey-piv', '--device', 'office', '--label', 'office'], { from: 'user' },
    );

    expect(signing.generateEd25519Key).toHaveBeenCalledOnce();
  });

  it('registers, renames, and unregisters friendly device catalog entries without hardware access', async () => {
    const hardware = fakeYubiKeyService();
    const program = yubiProgram(env, hardware);

    await program.parseAsync(['device', 'register', '--name', 'office', '--serial', '123'], { from: 'user' });
    expect(loadYubiKeyRegistrations().devices.office?.serial).toBe('123');

    await program.parseAsync(['device', 'rename', '--device', 'office', '--name', 'primary'], { from: 'user' });
    expect(loadYubiKeyRegistrations().devices).toMatchObject({ primary: { serial: '123' } });
    expect(loadYubiKeyRegistrations().devices).not.toHaveProperty('office');

    await program.parseAsync(['device', 'unregister', '--device', '123'], { from: 'user' });
    expect(loadYubiKeyRegistrations().devices).toEqual({});
    expect(hardware.listDevices).not.toHaveBeenCalled();
    expect(hardware.inspectDevice).not.toHaveBeenCalled();
  });

  it.each([
    ['rename', ['device', 'rename', '--device', 'missing', '--name', 'primary']],
    ['unregister', ['device', 'unregister', '--device', 'missing']],
  ] as const)('preserves registrations when device %s uses an unknown friendly selector', async (_operation, args) => {
    registerYubiKey({ name: 'office', serial: '123' });
    const before = loadYubiKeyRegistrations();
    await expect(yubiProgram(env, fakeYubiKeyService()).parseAsync([...args], { from: 'user' }))
      .rejects.toThrow(/not registered|not found/i);
    expect(loadYubiKeyRegistrations()).toEqual(before);
  });

  it('sets, resolves, and resets global and device provisioning defaults', async () => {
    registerYubiKey({ name: 'office', serial: '123' });
    const program = yubiProgram(env, fakeYubiKeyService());

    await program.parseAsync([
      'device', 'defaults', 'set', '--slot', '82', '--pin-policy', 'always',
    ], { from: 'user' });
    await program.parseAsync([
      'device', 'defaults', 'set', '--device', 'office', '--touch-policy', 'cached',
    ], { from: 'user' });
    expect(loadYubiKeyConfig()).toEqual({
      defaults: { slot: '82', pinPolicy: 'always' },
      devices: { '123': { touchPolicy: 'cached' } },
    });

    env.stdout.length = 0;
    await program.parseAsync(['device', 'defaults', 'show', '--device', 'office'], { from: 'user' });
    expect(JSON.parse(env.stdout[0]!)).toMatchObject({
      resolved: { slot: '82', pinPolicy: 'always', touchPolicy: 'cached' },
    });

    await program.parseAsync(['device', 'defaults', 'reset', '--device', 'office'], { from: 'user' });
    expect(loadYubiKeyConfig()).toEqual({ defaults: { slot: '82', pinPolicy: 'always' } });
    await program.parseAsync(['device', 'defaults', 'reset'], { from: 'user' });
    expect(loadYubiKeyConfig()).toEqual({});
  });

  it('rejects an empty defaults update and unknown device selector without changing defaults', async () => {
    const program = yubiProgram(env, fakeYubiKeyService());
    const before = loadYubiKeyConfig();

    await expect(program.parseAsync(['device', 'defaults', 'set'], { from: 'user' }))
      .rejects.toThrow(/at least one/i);
    await expect(program.parseAsync([
      'device', 'defaults', 'set', '--device', 'missing', '--slot', '82',
    ], { from: 'user' })).rejects.toThrow(/not registered/i);
    expect(loadYubiKeyConfig()).toEqual(before);
  });

  it('rejects an existing-root enrollment on a serial claimed by another root before changing its label', async () => {
    const hardware = fakeIdentityHardware();
    const registry = fakeSourceRegistry();
    registry.read.mockResolvedValue(sourceDocument({
      [SOURCE_ID]: sourceRecord(),
      'ir:bcdefghijklmnop': { ...sourceRecord(), label: 'other', rootPublicKey: '04' + '33'.repeat(64),
        backends: [{ backend: 'yubikey-piv', locations: [{ serial: '456' }] }] },
    }));
    await expect(yubiProgram(env, fakeYubiKeyService(), hardware, registry).parseAsync(
      ['identity-root', 'import', '--backend', 'yubikey-piv', '--device', '456', '--label', 'replacement'], { from: 'user' },
    )).rejects.toThrow(/catalog update did not complete|claimed/i);
    expect(registry.enroll).not.toHaveBeenCalled();
    expect(hardware.importRoot).not.toHaveBeenCalled();
  });

  it.each(['generate', 'import'])('rejects a colon-containing label before %s touches hardware', async (action) => {
    const hardware = fakeIdentityHardware(); const registry = fakeSourceRegistry();
    registry.read.mockResolvedValue(sourceDocument({
      'ir:bcdefghijklmnop': { ...sourceRecord(), rootPublicKey: '04' + '33'.repeat(64) },
    }));
    await expect(yubiProgram(env, fakeYubiKeyService(), hardware, registry).parseAsync(
      ['identity-root', action, '--backend', 'yubikey-piv', '--device', '456', '--label', 'ir:bcdefghijklmnop'], { from: 'user' },
    )).rejects.toThrow(/label/i);
    expect(hardware.generateRoot).not.toHaveBeenCalled();
    expect(hardware.importRoot).not.toHaveBeenCalled();
    expect(registry.enroll).not.toHaveBeenCalled();
  });

  it.each([
    ['default', ['identity-root', 'default', 'set', '--identity-root', 'root']],
    ['backend order', ['identity-root', 'backend', 'order', '--identity-root', 'root', '--backends', 'yubikey-piv']],
    ['location order', [
      'identity-root', 'locations', 'order', '--identity-root', 'root', '--backend', 'yubikey-piv',
      '--locations', '[{"serial":"123"}]',
    ]],
  ] as const)('projects the persisted label in %s output', async (_operation, args) => {
    const registry = fakeSourceRegistry();
    const persisted = { id: SOURCE_ID, ...sourceRecord(), label: '@AgentRoot' };
    registry.setDefault.mockResolvedValueOnce(persisted);
    registry.reorderBackends.mockResolvedValueOnce(persisted);
    registry.reorderLocations.mockResolvedValueOnce(persisted);

    await sourceProgram(env, registry).parseAsync([...args], { from: 'user' });

    expect(JSON.parse(env.stdout.at(-1)!)).toEqual({
      id: SOURCE_ID,
      label: 'AgentRoot',
      backends: sourceRecord().backends,
      rootPublicKey: ROOT_PUBLIC_KEY,
      rootPublicKeyFingerprint: '22'.repeat(32),
      recipeVersion: 1,
    });
  });

  it('shows the configured default identity root without catalog mutation', async () => {
    const registry = fakeSourceRegistry();
    registry.read.mockResolvedValueOnce(sourceDocument({ [SOURCE_ID]: sourceRecord() }, SOURCE_ID));

    await sourceProgram(env, registry).parseAsync(
      ['identity-root', 'default', 'show'], { from: 'user' },
    );

    expect(JSON.parse(env.stdout.at(-1)!)).toEqual({ defaultIdentityRoot: SOURCE_ID });
    expect(registry.setDefault).not.toHaveBeenCalled();
    expect(registry.forgetLocation).not.toHaveBeenCalled();
  });

  it('lists identity-root summaries while inspect preserves the selected full record', async () => {
    const registry = fakeSourceRegistry();
    const secondId = 'ir:bcdefghijklmnop';
    const selected = {
      ...sourceRecord(),
      label: '@AgentRoot',
      backends: [
        { backend: 'yubikey-piv', locations: [{ serial: '123' }, { serial: '456' }] },
        { backend: 'future-hsm', locations: [{ cluster: 'west' }] },
      ],
    };
    const unlabelled = sourceRecord();
    delete unlabelled.label;
    registry.read.mockResolvedValue(sourceDocument({ [SOURCE_ID]: selected, [secondId]: unlabelled }, SOURCE_ID));
    const program = sourceProgram(env, registry);

    await program.parseAsync(['identity-root', 'list'], { from: 'user' });
    await program.parseAsync(['identity-root', 'inspect', '--identity-root', SOURCE_ID], { from: 'user' });

    expect(JSON.parse(env.stdout.at(-2)!)).toEqual({
      version: 1,
      defaultSourceId: SOURCE_ID,
      sources: {
        [SOURCE_ID]: { label: 'AgentRoot', backends: ['yubikey-piv', 'future-hsm'], default: true },
        [secondId]: { backends: ['yubikey-piv'], default: false },
      },
    });
    expect(JSON.parse(env.stdout.at(-1)!)).toEqual({ id: SOURCE_ID, ...selected, label: 'AgentRoot' });
  });

  it('lists an empty identity-root catalog with the stable envelope', async () => {
    const registry = fakeSourceRegistry();
    registry.read.mockResolvedValue(sourceDocument({}));

    await sourceProgram(env, registry).parseAsync(['identity-root', 'list'], { from: 'user' });

    expect(JSON.parse(env.stdout.at(-1)!)).toEqual({ version: 1, sources: {} });
  });

  it('rejects adoption of a location claimed by another root before trust confirmation', async () => {
    const registry = fakeSourceRegistry(); const confirm = vi.fn(async () => true);
    registry.read.mockResolvedValue(sourceDocument({
      'ir:bcdefghijklmnop': { ...sourceRecord(), rootPublicKey: '04' + '33'.repeat(64) },
    }));
    await expect(yubiProgram(env, fakeYubiKeyService(), fakeIdentityHardware(), registry, confirm).parseAsync(
      ['identity-root', 'adopt', '--backend', 'yubikey-piv', '--device', '123'], { from: 'user' },
    )).rejects.toThrow(/claimed/i);
    expect(confirm).not.toHaveBeenCalled();
    expect(registry.enroll).not.toHaveBeenCalled();
  });

  it('rejects a signing-key adoption label collision before trust confirmation', async () => {
    const signing = fakeYubiKeyService(); const confirm = vi.fn(async () => true);
    await yubiProgram(env, signing).parseAsync(
      ['signing-key', 'generate', '--backend', 'yubikey-piv', '--device', '123', '--label', 'claimed'], { from: 'user' },
    );
    signing.inspectDevice.mockResolvedValueOnce(signingInspection('123'));
    await expect(yubiProgram(env, signing, fakeIdentityHardware(), fakeSourceRegistry(), confirm).parseAsync(
      ['signing-key', 'adopt', '--backend', 'yubikey-piv', '--device', '123', '--slot', '82', '--label', 'claimed'], { from: 'user' },
    )).rejects.toThrow(/label/i);
    expect(confirm).not.toHaveBeenCalled();
  });

  it.each([
    ['signing-key', 'generate'],
    ['signing-key', 'import'],
    ['signing-key', 'adopt'],
    ['identity-root', 'generate'],
    ['identity-root', 'import'],
    ['identity-root', 'adopt'],
  ])('requires an explicit device for yubikey %s %s before hardware access', async (kind, action) => {
    const hardware = fakeYubiKeyService();
    const identityHardware = fakeIdentityHardware();
    const args = [kind, action, '--backend', 'yubikey-piv'];
    if (kind === 'signing-key' && action === 'adopt') args.push('--slot', '9c');

    await expect(yubiProgram(env, hardware, identityHardware).parseAsync(args, { from: 'user' })).rejects.toThrow(
      /device.*required|required option.*device/i,
    );

    expect(hardware.inspectDevice).not.toHaveBeenCalled();
    expect(hardware.generateEd25519Key).not.toHaveBeenCalled();
    expect(hardware.importEd25519Key).not.toHaveBeenCalled();
    expect(identityHardware.inspectRoot).not.toHaveBeenCalled();
    expect(identityHardware.generateRoot).not.toHaveBeenCalled();
    expect(identityHardware.importRoot).not.toHaveBeenCalled();
  });

  it.each(['unlock', 'lock'])('requires an explicit device for PIN %s before hardware access', async (action) => {
    const hardware = fakeYubiKeyService();
    await expect(
      yubiProgram(env, hardware).parseAsync(['device', action], { from: 'user' }),
    ).rejects.toThrow(/device.*required|required option.*device/i);
    expect(hardware.unlockDevice).not.toHaveBeenCalled();
    expect(hardware.lockDevice).not.toHaveBeenCalled();
  });

  it('notifies both runtimes only after successful device PIN mutation cleanup', async () => {
    let finishClose!: () => void;
    const close = vi.fn(() => new Promise<void>(resolve => { finishClose = resolve; }));
    const lockDevice = vi.fn(async () => ({ serial: '123', status: 'locked' }));
    runtimeRefresh.serviceFactory.mockReturnValue({ lockDevice, close });
    const result = runCli(['device', 'lock', '--device', '123']);
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(runtimeRefresh.notify).not.toHaveBeenCalled();

    finishClose();
    await expect(result).resolves.toBe(0);
    expect(runtimeRefresh.notify).toHaveBeenCalledExactlyOnceWith(['signer', 'idManager']);
  });

  it('rejects integrity repair without a device before inspection or catalog mutation', async () => {
    const hardware = fakeYubiKeyService();
    const identityHardware = fakeIdentityHardware();
    const registry = fakeSourceRegistry();

    await expect(
      yubiProgram(env, hardware, identityHardware, registry).parseAsync(['device', 'integrity', '--fix'], {
        from: 'user',
      }),
    ).rejects.toThrow(/device.*required|required option.*device/i);

    expect(hardware.listAndInspectDeviceKeys).not.toHaveBeenCalled();
    expect(identityHardware.inspectRoot).not.toHaveBeenCalled();
    expect(registry.forgetLocation).not.toHaveBeenCalled();
  });

  it('delegates identity-root location pruning to the registry without reading the catalog', async () => {
    const registry = fakeSourceRegistry();
    await sourceProgram(env, registry).parseAsync(
      [
        'identity-root', 'locations', 'forget', '--identity-root', 'root',
        '--backend', 'yubikey-piv', '--location', '{"serial":"123"}',
      ], { from: 'user' },
    );
    expect(registry.forgetLocation).toHaveBeenCalledWith('root', { backend: 'yubikey-piv', location: { serial: '123' } });
    expect(registry.read).not.toHaveBeenCalled();
  });

  it('delegates whole identity-root forgetting as the explicit all target', async () => {
    const registry = fakeSourceRegistry();

    await sourceProgram(env, registry).parseAsync(
      ['identity-root', 'forget', '--identity-root', 'root'], { from: 'user' },
    );

    expect(registry.forgetLocation).toHaveBeenCalledWith('root', 'all');
    expect(registry.read).not.toHaveBeenCalled();
  });

  it('renders unknown roots and unregistered locations as human errors', async () => {
    const missingRoot = fakeSourceRegistry();
    missingRoot.forgetLocation.mockRejectedValueOnce(new IdentitySourceError('SOURCE_NOT_FOUND'));
    await expect(sourceProgram(env, missingRoot).parseAsync([
      'identity-root', 'locations', 'forget', '--identity-root', 'missing',
      '--backend', 'yubikey-piv', '--location', '{"serial":"123"}',
    ], { from: 'user' })).rejects.toThrow(/not found/i);
    expect(missingRoot.forgetLocation).toHaveBeenCalledWith('missing', { backend: 'yubikey-piv', location: { serial: '123' } });

    const missingLocation = fakeSourceRegistry();
    missingLocation.forgetLocation.mockRejectedValueOnce(new IdentitySourceError('INVALID_SOURCE'));
    await expect(sourceProgram(env, missingLocation).parseAsync([
      'identity-root', 'locations', 'forget', '--identity-root', 'root',
      '--backend', 'yubikey-piv', '--location', '{"serial":"456"}',
    ], { from: 'user' })).rejects.toThrow(/not registered/i);
    expect(missingLocation.forgetLocation).toHaveBeenCalledWith('root', { backend: 'yubikey-piv', location: { serial: '456' } });
  });

  it('rejects an unsupported identity-root location backend before catalog mutation', async () => {
    const registry = fakeSourceRegistry();

    await expect(sourceProgram(env, registry).parseAsync([
      'identity-root', 'locations', 'forget', '--identity-root', 'root',
      '--backend', 'future-hsm', '--location', '{"serial":"123"}',
    ], { from: 'user' })).rejects.toThrow(/yubikey-piv|unsupported backend/i);

    expect(registry.forgetLocation).not.toHaveBeenCalled();
    expect(registry.read).not.toHaveBeenCalled();
    expect(registry.setDefault).not.toHaveBeenCalled();
  });

  it('routes identity-root backend and location ordering through the selected source', async () => {
    const registry = fakeSourceRegistry();
    const program = sourceProgram(env, registry);

    await program.parseAsync([
      'identity-root', 'backend', 'order', '--identity-root', 'root', '--backends', 'yubikey-piv',
    ], { from: 'user' });
    await program.parseAsync([
      'identity-root', 'locations', 'order', '--identity-root', 'root', '--backend', 'yubikey-piv',
      '--locations', '[{"serial":"123"}]',
    ], { from: 'user' });

    expect(registry.reorderBackends).toHaveBeenCalledWith('root', ['yubikey-piv']);
    expect(registry.reorderLocations).toHaveBeenCalledWith('root', 'yubikey-piv', [{ serial: '123' }]);
  });

  it.each([
    ['identity-root', 'locations', 'forget', '--identity-root', 'root', '--backend', 'yubikey-piv'],
    [
      'identity-root', 'locations', 'forget', '--identity-root', 'root',
      '--backend', 'yubikey-piv', '--location', '[]',
    ],
    [
      'identity-root', 'locations', 'forget', '--identity-root', 'root',
      '--backend', 'software-signer', '--location', '{"serial":"123"}',
    ],
  ])('rejects invalid identity-root location forget syntax before catalog mutation: %j', async (...args) => {
    const registry = fakeSourceRegistry();
    await expect(sourceProgram(env, registry).parseAsync(args, { from: 'user' })).rejects.toThrow();
    expect(registry.forgetLocation).not.toHaveBeenCalled();
  });

  it('sets explicit source labels and enrolls a confirmed occupied root', async () => {
    const registry = fakeSourceRegistry();
    const hardware = fakeIdentityHardware();
    const program = sourceProgram(env, registry);
    await program.parseAsync(
      ['identity-root', 'label', 'set', '--identity-root', 'root', '--mode', 'hard', '--label', 'renamed'],
      { from: 'user' },
    );
    expect(registry.setLabel).toHaveBeenCalledWith(SOURCE_ID, { label: 'renamed', mode: 'hard' });
    registry.read.mockResolvedValue(sourceDocument({}));

    const tty = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
    try {
      await yubiProgram(env, fakeYubiKeyService(), hardware, registry).parseAsync(
        ['identity-root', 'adopt', '--backend', 'yubikey-piv', '--device', '123', '--label', 'new-root'],
        { from: 'user' },
      );
    } finally {
      if (tty) Object.defineProperty(process.stdin, 'isTTY', tty);
      else Reflect.deleteProperty(process.stdin, 'isTTY');
    }
    expect(registry.enroll).toHaveBeenCalledWith(
      expect.objectContaining({
        label: 'new-root',
        rootPublicKey: ROOT_PUBLIC_KEY,
        recipeVersion: 1,
      }),
    );
    expect(hardware.close).toHaveBeenCalledOnce();
  });

  it('rejects invalid source modes and unavailable roots without catalog writes', async () => {
    const registry = fakeSourceRegistry();
    const hardware = fakeIdentityHardware();
    const program = sourceProgram(env, registry);
    await expect(
      program.parseAsync(['identity-root', 'label', 'set', '--identity-root', 'root', '--mode', 'invalid'], {
        from: 'user',
      }),
    ).rejects.toThrow(/mode/i);

    hardware.inspectRoot.mockResolvedValueOnce(identityRootInspection('123', 'empty'));
    await expect(
      yubiProgram(env, fakeYubiKeyService(), hardware, registry).parseAsync(
        ['identity-root', 'adopt', '--backend', 'yubikey-piv', '--device', '123', '--label', 'new-root'],
        { from: 'user' },
      ),
    ).rejects.toThrow(/valid P-256 root/i);
    expect(registry.enroll).not.toHaveBeenCalled();
    expect(hardware.close).toHaveBeenCalledOnce();
  });
});

function yubiProgram(
  env: CliTestEnv,
  hardware: YubiKeyServiceMock,
  identityHardware = fakeIdentityHardware(),
  registry: ReturnType<typeof fakeSourceRegistry> | IdentitySourceRegistry = fakeSourceRegistry(),
  confirm: (message: string) => Promise<boolean> = async () => true,
): Command {
  const program = new Command().exitOverride();
  registerYubiKeyCliCommand({
    program,
    stderr: env.stderr,
    stdout: env.stdout,
    runNested: async () => {},
    serviceFactory: () => hardware,
    identityServiceFactory: () => identityHardware,
    identityRegistryFactory: () => registry,
    interactionFactory: () => ({ promptPin: async () => '123456', promptManagementKey: async () => '', confirm }),
  });
  return program;
}

function sourceProgram(
  env: CliTestEnv,
  registry: ReturnType<typeof fakeSourceRegistry>,
): Command {
  const program = new Command().exitOverride();
  registerSourceCliCommand({
    program,
    stdout: env.stdout,
    registryFactory: () => registry,
  });
  return program;
}

function sourceRecord(): IdentitySourceRecord {
  return {
    label: 'root',
    backends: [{ backend: 'yubikey-piv', locations: [{ serial: '123' }] }],
    rootPublicKey: ROOT_PUBLIC_KEY,
    rootPublicKeyFingerprint: '22'.repeat(32),
    recipeVersion: 1 as const,
  };
}

function sourceDocument(
  sources: Record<string, IdentitySourceRecord>,
  defaultSourceId?: string,
): IdentitySourceRegistryDocument {
  return { version: 1, sources, ...(defaultSourceId === undefined ? {} : { defaultSourceId }) };
}

function identityRootInspection(
  serial: string,
  status: IdentityRootInspection['status'],
  publicKey?: string,
): IdentityRootInspection {
  return {
    serial,
    readerName: 'reader',
    slot: '9d',
    status,
    pinStatus: { status: 'required', retries: 3 },
    ...(publicKey === undefined ? {} : { publicKey }),
  };
}

function signingInspection(serial: string): YubiKeyInspection {
  return {
    serial,
    readerName: 'reader',
    ed25519Supported: true,
    touchPolicySupported: 'supported',
    pinStatus: { status: 'required', retries: 3 },
    slots: [{
      slot: '82',
      status: 'occupied',
      algorithm: 'Ed25519',
      publicKey: ed25519PublicKey.require('22'.repeat(32)),
    }],
  };
}

function fakeSourceRegistry() {
  const result = () => ({ id: SOURCE_ID, ...sourceRecord() });
  const registry = {
    read: vi.fn<IdentitySourceRegistry['read']>(async () => ({ version: 1 as const, sources: { [SOURCE_ID]: sourceRecord() } })),
    setLabel: vi.fn<IdentitySourceRegistry['setLabel']>(async () => result()),
    setSoftLabel: vi.fn<IdentitySourceRegistry['setSoftLabel']>(async () => result()),
    removeLabel: vi.fn<IdentitySourceRegistry['removeLabel']>(async () => result()),
    setDefault: vi.fn<IdentitySourceRegistry['setDefault']>(async () => result()),
    forgetLocation: vi.fn<IdentitySourceRegistry['forgetLocation']>(async (_source, target) => target === 'all' ? { id: SOURCE_ID } : result()),
    reorderBackends: vi.fn<IdentitySourceRegistry['reorderBackends']>(async () => result()),
    reorderLocations: vi.fn<IdentitySourceRegistry['reorderLocations']>(async () => result()),
    enroll: vi.fn<IdentitySourceRegistry['enroll']>(async record => ({ id: deriveIdentitySourceId(record.rootPublicKey, 1), ...record })),
  } satisfies IdentitySourceRegistry;
  return registry;
}
