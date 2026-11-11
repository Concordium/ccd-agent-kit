import * as config from '@ccd-agent-kit/config-utils';
import type { IdentitySourceRegistry } from '@ccd-agent-kit/config-utils';
import { ed25519PublicKey } from '@ccd-agent-kit/sdk-utils';
import { Command } from 'commander';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { registerYubiKeyCliCommand } from '../../../src/cli/yubikeyCliCommand.js';
import {
  fakeIdentityService,
  fakeSigningService,
  type IdentityYubiKeyServiceMock,
  type YubiKeyServiceMock,
} from '../../helpers/hardwareServices.js';

vi.mock('@ccd-agent-kit/config-utils', async importOriginal => ({
  ...(await importOriginal<typeof import('@ccd-agent-kit/config-utils')>()),
  loadSignerInventory: vi.fn(),
  loadYubiKeyRegistrations: vi.fn(),
  resolveYubiKeyRegistration: vi.fn(),
  forgetYubiKeyInventoryLocators: vi.fn(),
  forgetYubiKeyPivSignerLocator: vi.fn(),
  resolveYubiKeyGenerationDefaults: vi.fn(),
  upsertSignerInventoryKey: vi.fn(),
}));

const PUBLIC_KEY = ed25519PublicKey.require('d04ab232742bb4ab3a1368bd4615e4e6d0224ab71a016baf8520a332c9778737');
const REPLACED_PUBLIC_KEY = ed25519PublicKey.require('a09aa5f47a6759802ff955f8dc2d2a14a5c99d23be97f864127ff9383455a4f0');
const ROOT_PUBLIC_KEY = `04${'11'.repeat(64)}`;
const CHANGED_ROOT_PUBLIC_KEY = `04${'22'.repeat(64)}`;

describe('hardware command catalog orchestration', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(config.loadSignerInventory).mockReturnValue({ version: 1, updatedAt: 'now', keys: {} });
    vi.mocked(config.loadYubiKeyRegistrations).mockReturnValue({ version: 1, updatedAt: 'now', devices: {} });
    vi.mocked(config.resolveYubiKeyRegistration).mockReturnValue(undefined);
    vi.mocked(config.forgetYubiKeyInventoryLocators).mockReturnValue({ removedPublicKeys: [] });
    vi.mocked(config.resolveYubiKeyGenerationDefaults).mockReturnValue({
      slot: '9c', pinPolicy: 'once', touchPolicy: 'cached',
    });
  });

  it('reports a truthful partial failure when hardware changed and replacement cleanup fails', async () => {
    const hardware = fakeSigningService();
    hardware.generateEd25519Key.mockResolvedValue({
      publicKey: PUBLIC_KEY,
      serial: '123', slot: '9c', pinPolicy: 'once', touchPolicy: 'cached',
      readerName: 'reader', replacedExistingKey: true, replacedPublicKey: REPLACED_PUBLIC_KEY,
    });
    vi.mocked(config.forgetYubiKeyPivSignerLocator).mockImplementation(() => {
      throw new Error('catalog cleanup failed');
    });
    const program = makeProgram(hardware);

    await expect(program.parseAsync(
      ['signing-key', 'generate', '--backend', 'yubikey-piv', '--device', '123'], { from: 'user' },
    )).rejects.toThrow(/partially updated.*reconcile/i);

    expect(config.upsertSignerInventoryKey).toHaveBeenCalledOnce();
    expect(config.forgetYubiKeyPivSignerLocator).toHaveBeenCalledWith({
      publicKey: REPLACED_PUBLIC_KEY, serial: '123', slot: '9c',
    });
    expect(hardware.close).toHaveBeenCalledOnce();
  });

  it('does not claim catalog success when the first catalog write fails after hardware mutation', async () => {
    const hardware = fakeSigningService();
    vi.mocked(config.upsertSignerInventoryKey).mockImplementation(() => {
      throw new Error('catalog write failed');
    });
    const stdout: string[] = [];
    const program = makeProgram(hardware, stdout);

    await expect(program.parseAsync(
      ['signing-key', 'generate', '--backend', 'yubikey-piv', '--device', '123'], { from: 'user' },
    )).rejects.toThrow(/could not be fully updated/i);

    expect(stdout).toEqual([]);
    expect(config.forgetYubiKeyPivSignerLocator).not.toHaveBeenCalled();
    expect(hardware.close).toHaveBeenCalledOnce();
  });

  it('does not write either catalog when repair confirmation is declined and closes both services', async () => {
    const signing = staleSigningService();
    const identity = staleIdentityService();
    const registry = fakeIdentityRegistry();

    await expect(makeProgram(signing, [], identity, registry, async () => false).parseAsync(
      ['device', 'integrity', '--fix', '--device', '123'], { from: 'user' },
    )).rejects.toThrow(/repair cancelled/i);

    expect(config.forgetYubiKeyInventoryLocators).not.toHaveBeenCalled();
    expect(registry.forgetLocation).not.toHaveBeenCalled();
    expect(signing.close).toHaveBeenCalledOnce();
    expect(identity.close).toHaveBeenCalledOnce();
  });

  it.each([
    { pruned: true, removedIdentityRoots: ['root-id'] },
    { pruned: false, removedIdentityRoots: [] },
  ])('reports whether identity location repair pruned the root (pruned=$pruned)', async ({ pruned, removedIdentityRoots }) => {
    const signing = fakeSigningService();
    const identity = staleIdentityService();
    const registry = fakeIdentityRegistry();
    const record = (await registry.read()).sources['root-id']!;
    registry.forgetLocation.mockResolvedValue(pruned ? { id: 'root-id' } : { id: 'root-id', ...record });
    const stdout: string[] = [];

    await makeProgram(signing, stdout, identity, registry).parseAsync(
      ['device', 'integrity', '--fix', '--device', '123'], { from: 'user' },
    );

    expect(config.forgetYubiKeyInventoryLocators).toHaveBeenCalledOnce();
    expect(registry.forgetLocation).toHaveBeenCalledWith('root-id', { backend: 'yubikey-piv', location: { serial: '123' } });
    expect(JSON.parse(stdout[0]!)).toMatchObject({
      signingKeys: { removedPublicKeys: [] },
      identityRoots: { removedIdentityRoots },
    });
  });

  it.each([
    { changed: false, message: /before any catalog changes/i },
    { changed: true, message: /partially applied/i },
  ])('reports truthful repair facts and preserves the producer cause when changed=$changed', async ({ changed, message }) => {
    const signing = staleSigningService();
    const identity = staleIdentityService();
    const registry = fakeIdentityRegistry();
    const cause = new Error('identity catalog unavailable');
    registry.forgetLocation.mockRejectedValue(cause);
    vi.mocked(config.forgetYubiKeyInventoryLocators).mockImplementation(() => {
      if (!changed) throw cause;
      return { removedPublicKeys: [PUBLIC_KEY] };
    });
    let failure: unknown;

    try {
      await makeProgram(signing, [], identity, registry).parseAsync(
        ['device', 'integrity', '--fix', '--device', '123'], { from: 'user' },
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    if (!(failure instanceof Error)) throw new Error('Expected repair failure.');
    expect(failure.message).toMatch(message);
    expect(failure.cause).toBe(cause);
    expect(registry.forgetLocation).toHaveBeenCalledTimes(changed ? 1 : 0);
    expect(signing.close).toHaveBeenCalledOnce();
    expect(identity.close).toHaveBeenCalledOnce();
  });
});

describe('hardware list and inspect routing', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(config.loadYubiKeyRegistrations).mockReturnValue(emptyRegistrations());
    vi.mocked(config.resolveYubiKeyRegistration).mockReturnValue(undefined);
  });

  it('lists public device attributes with the registration catalog and closes the signing service', async () => {
    const signing = fakeSigningService();
    const registrations = {
      version: 1 as const,
      updatedAt: '2026-10-25T00:00:00.000Z',
      devices: {
        primary: {
          serial: '123',
          registeredAt: '2026-10-24T00:00:00.000Z',
          updatedAt: '2026-10-25T00:00:00.000Z',
        },
      },
    };
    const devices = [{
      readerName: 'reader', serial: '123', model: 'YubiKey 5', formFactor: 'USB-C', firmwareVersion: '5.7.1',
    }];
    signing.listDevices.mockResolvedValue(devices);
    vi.mocked(config.loadYubiKeyRegistrations).mockReturnValue(registrations);
    const stdout: string[] = [];

    await routingProgram({ signingFactory: () => signing, stdout }).parseAsync(['device', 'list'], { from: 'user' });

    expect(JSON.parse(stdout[0]!)).toEqual({ devices, registrations });
    expect(signing.close).toHaveBeenCalledOnce();
  });

  it.each([
    {
      failure: 'device discovery',
      arrange(signing: YubiKeyServiceMock) { signing.listDevices.mockRejectedValue(new Error('reader failed')); },
      error: /reader failed/i,
    },
    {
      failure: 'registration loading',
      arrange() { vi.mocked(config.loadYubiKeyRegistrations).mockImplementation(() => { throw new Error('catalog failed'); }); },
      error: /catalog failed/i,
    },
  ])('closes the signing service when list $failure fails', async ({ arrange, error }) => {
    const signing = fakeSigningService();
    arrange(signing);

    await expect(routingProgram({ signingFactory: () => signing }).parseAsync(
      ['device', 'list'], { from: 'user' },
    )).rejects.toThrow(error);

    expect(signing.close).toHaveBeenCalledOnce();
  });

  it('resolves a selected friendly name before inspecting without enumerating devices', async () => {
    const signing = fakeSigningService();
    const identity = fakeIdentityService();
    const registration = {
      serial: '456', registeredAt: '2026-10-24T00:00:00.000Z', updatedAt: '2026-10-25T00:00:00.000Z',
    };
    vi.mocked(config.resolveYubiKeyRegistration).mockReturnValue(registration);
    const stdout: string[] = [];

    await routingProgram({ signingFactory: () => signing, identityFactory: () => identity, stdout }).parseAsync(
      ['device', 'inspect', '--device', 'primary'], { from: 'user' },
    );

    expect(config.resolveYubiKeyRegistration).toHaveBeenCalledWith('primary');
    expect(signing.listDevices).not.toHaveBeenCalled();
    expect(signing.inspectDevice).toHaveBeenCalledWith('456');
    expect(identity.inspectRoot).toHaveBeenCalledWith('456');
    expect(JSON.parse(stdout[0]!)).toEqual({
      signingKeys: await signing.inspectDevice.mock.results[0]!.value,
      identityRoot: await identity.inspectRoot.mock.results[0]!.value,
    });
    expect(signing.close).toHaveBeenCalledOnce();
    expect(identity.close).toHaveBeenCalledOnce();
  });

  it('inspects only enumerated devices with serials', async () => {
    const signing = fakeSigningService();
    const identity = fakeIdentityService();
    signing.listDevices.mockResolvedValue([
      { readerName: 'serialless', model: 'unknown reader' },
      { readerName: 'selected', serial: '123', firmwareVersion: '5.7.1' },
    ]);
    const stdout: string[] = [];

    await routingProgram({ signingFactory: () => signing, identityFactory: () => identity, stdout }).parseAsync(
      ['device', 'inspect'], { from: 'user' },
    );

    expect(signing.inspectDevice).toHaveBeenCalledOnce();
    expect(signing.inspectDevice).toHaveBeenCalledWith('123');
    expect(identity.inspectRoot).toHaveBeenCalledOnce();
    expect(identity.inspectRoot).toHaveBeenCalledWith('123');
    expect(JSON.parse(stdout[0]!)).toMatchObject({ devices: [{
      signingKeys: { serial: '123' }, identityRoot: { serial: '123' },
    }] });
  });

  it.each([
    ['no devices', []],
    ['only serialless devices', [{ readerName: 'serialless' }]],
  ])('normalizes all-device inspection with $0 to an empty devices array', async (_case, devices) => {
    const signing = fakeSigningService();
    const identity = fakeIdentityService();
    signing.listDevices.mockResolvedValue(devices);
    const stdout: string[] = [];

    await routingProgram({ signingFactory: () => signing, identityFactory: () => identity, stdout }).parseAsync(
      ['device', 'inspect'], { from: 'user' },
    );

    expect(JSON.parse(stdout[0]!)).toEqual({ devices: [] });
    expect(signing.inspectDevice).not.toHaveBeenCalled();
    expect(identity.inspectRoot).not.toHaveBeenCalled();
  });

  it('closes both inspect services when an operation fails', async () => {
    const signing = fakeSigningService();
    const identity = fakeIdentityService();
    signing.inspectDevice.mockRejectedValue(new Error('inspection failed'));

    await expect(routingProgram({ signingFactory: () => signing, identityFactory: () => identity }).parseAsync(
      ['device', 'inspect', '--device', '123'], { from: 'user' },
    )).rejects.toThrow(/inspection failed/i);

    expect(signing.close).toHaveBeenCalledOnce();
    expect(identity.close).toHaveBeenCalledOnce();
  });

  it('closes an already-created signing service when identity service creation fails', async () => {
    const signing = fakeSigningService();

    await expect(routingProgram({
      signingFactory: () => signing,
      identityFactory: () => { throw new Error('identity factory failed'); },
    }).parseAsync(['device', 'inspect', '--device', '123'], { from: 'user' })).rejects.toThrow(/identity factory failed/i);

    expect(signing.close).toHaveBeenCalledOnce();
  });

  it('rejects an unknown friendly selector before creating hardware services', async () => {
    const signingFactory = vi.fn(() => fakeSigningService());
    const identityFactory = vi.fn(() => fakeIdentityService());

    await expect(routingProgram({ signingFactory, identityFactory }).parseAsync(
      ['device', 'inspect', '--device', 'unknown'], { from: 'user' },
    )).rejects.toThrow(/not registered/i);

    expect(signingFactory).not.toHaveBeenCalled();
    expect(identityFactory).not.toHaveBeenCalled();
  });
});

function emptyRegistrations() {
  return { version: 1 as const, updatedAt: '2026-10-25T00:00:00.000Z', devices: {} };
}

function routingProgram(input: {
  signingFactory: () => YubiKeyServiceMock;
  identityFactory?: () => IdentityYubiKeyServiceMock;
  stdout?: string[];
}): Command {
  const program = new Command().exitOverride();
  registerYubiKeyCliCommand({
    program,
    stderr: [],
    stdout: input.stdout ?? [],
    runNested: async () => {},
    serviceFactory: input.signingFactory,
    identityServiceFactory: input.identityFactory ?? (() => fakeIdentityService()),
  });
  return program;
}

function makeProgram(
  hardware: YubiKeyServiceMock,
  stdout: string[] = [],
  identity = staleIdentityService(),
  registry = fakeIdentityRegistry(),
  confirm: (message: string) => Promise<boolean> = async () => true,
): Command {
  const program = new Command().exitOverride();
  registerYubiKeyCliCommand({
    program, stderr: [], stdout, runNested: async () => {},
    serviceFactory: () => hardware,
    identityServiceFactory: () => identity,
    identityRegistryFactory: () => registry,
    interactionFactory: () => ({
      promptPin: async () => '123456',
      promptManagementKey: async () => '',
      confirm,
    }),
  });
  return program;
}

function staleSigningService(): YubiKeyServiceMock {
  const reference = config.ed25519SignerKeyRef(PUBLIC_KEY);
  vi.mocked(config.loadSignerInventory).mockReturnValue({
    version: 1, updatedAt: 'now',
    keys: { [reference]: {
      scheme: 'Ed25519', createdAt: 'then', updatedAt: 'now',
      backends: [{
        signingModule: 'yubikey-piv', createdAt: 'then', updatedAt: 'now',
        backend: { devices: [{ kind: 'yubikey', serial: '123', slot: '9c' }] },
      }],
    } },
  });
  const service = fakeSigningService();
  service.listAndInspectDeviceKeys.mockResolvedValue({
    devices: [],
    inspections: [{ serial: '123', readerName: 'reader', slots: [{ slot: '9c', status: 'empty' }], ed25519Supported: true, touchPolicySupported: 'supported', pinStatus: { status: 'required', retries: 3 } }],
  });
  return service;
}

function staleIdentityService(): IdentityYubiKeyServiceMock {
  const pinStatus = { status: 'required' as const, retries: 3 };
  const service = fakeIdentityService();
  service.inspectRoot.mockImplementation(async serial => ({
    serial, readerName: 'reader', slot: '9d', status: 'occupied', publicKey: CHANGED_ROOT_PUBLIC_KEY, pinStatus,
  }));
  return service;
}

function fakeIdentityRegistry() {
  const record = {
    label: 'root', recipeVersion: 1 as const, rootPublicKey: ROOT_PUBLIC_KEY,
    rootPublicKeyFingerprint: '33'.repeat(32),
    backends: [{ backend: 'yubikey-piv' as const, locations: [{ serial: '123' }, { serial: '456' }] }],
  };
  return {
    read: vi.fn<IdentitySourceRegistry['read']>(async () => ({ version: 1, sources: { 'root-id': record } })),
    enroll: vi.fn<IdentitySourceRegistry['enroll']>(),
    setLabel: vi.fn<IdentitySourceRegistry['setLabel']>(),
    setSoftLabel: vi.fn<IdentitySourceRegistry['setSoftLabel']>(),
    removeLabel: vi.fn<IdentitySourceRegistry['removeLabel']>(),
    setDefault: vi.fn<IdentitySourceRegistry['setDefault']>(),
    forgetLocation: vi.fn<IdentitySourceRegistry['forgetLocation']>(async (_source, custody) => custody ? { id: 'root-id', ...record } : { id: 'root-id' }),
    reorderBackends: vi.fn<IdentitySourceRegistry['reorderBackends']>(),
    reorderLocations: vi.fn<IdentitySourceRegistry['reorderLocations']>(),
  } satisfies IdentitySourceRegistry;
}
