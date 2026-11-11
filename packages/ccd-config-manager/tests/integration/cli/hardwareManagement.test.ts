import {
  createIdentitySourceRegistry,
  loadSignerInventory,
  upsertSignerInventoryKey,
} from '@ccd-agent-kit/config-utils';
import type { IdentityYubiKeyService, YubiKeyService } from '@ccd-agent-kit/piv-utils';
import { ed25519PublicKey } from '@ccd-agent-kit/sdk-utils';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { registerYubiKeyCliCommand } from '../../../src/cli/yubikeyCliCommand.js';
import { setupCliTestEnv, type CliTestEnv } from '../../helpers/testEnv.js';

const PUBLIC_KEY = ed25519PublicKey.require('d04ab232742bb4ab3a1368bd4615e4e6d0224ab71a016baf8520a332c9778737');
const ROOT_PUBLIC_KEY =
  '040217e617f0b6443928278f96999e69a23a4f2c152bdf6d6cdf66e5b80282d4ed194a7debcb97712d2dda3ca85aa8765a56f45fc758599652f2897c65306e5794';

describe('hardware management catalog integration', () => {
  let env: CliTestEnv;

  beforeEach(() => { env = setupCliTestEnv('hardware-catalog-'); });
  afterEach(() => env.restore());

  it('catalogs representative generated signing and identity keys from typed hardware adapters', async () => {
    const signing = fakeSigningService();
    const identity = fakeIdentityService();
    const program = yubiProgram(env, signing, identity);

    await program.parseAsync([
      'signing-key', 'generate', '--backend', 'yubikey-piv', '--device', '123', '--label', 'hardware-key',
    ], { from: 'user' });
    await program.parseAsync([
      'identity-root', 'generate', '--backend', 'yubikey-piv', '--device', '123', '--label', 'identity-root',
    ], { from: 'user' });

    expect(loadSignerInventory().keys[`ed25519:${PUBLIC_KEY}`]).toMatchObject({
      label: 'hardware-key', backends: [{ signingModule: 'yubikey-piv' }],
    });
    expect(Object.values((await createIdentitySourceRegistry().read()).sources)).toEqual([
      expect.objectContaining({
        label: 'identity-root', rootPublicKey: ROOT_PUBLIC_KEY,
        backends: [{ backend: 'yubikey-piv', locations: [{ serial: '123' }] }],
      }),
    ]);
    expect(signing.generateEd25519Key).toHaveBeenCalledOnce();
    expect(identity.generateRoot).toHaveBeenCalledOnce();
    expect(signing.close).toHaveBeenCalledOnce();
    expect(identity.close).toHaveBeenCalledOnce();
  });

  it('repairs stale locations in both real public catalogs after one combined confirmation', async () => {
    upsertSignerInventoryKey({
      publicKey: PUBLIC_KEY, scheme: 'Ed25519', signingModule: 'yubikey-piv',
      backend: { devices: [{ kind: 'yubikey', serial: '123', slot: '9c' }] },
    });
    const registry = createIdentitySourceRegistry();
    const enrolled = await registry.enroll({
      label: 'identity-root', rootPublicKey: ROOT_PUBLIC_KEY,
      rootPublicKeyFingerprint: createHash('sha256').update(Buffer.from(ROOT_PUBLIC_KEY, 'hex')).digest('hex'),
      recipeVersion: 1,
      backends: [{ backend: 'yubikey-piv', locations: [{ serial: '123' }] }],
    });
    const signing = fakeSigningService();
    signing.listAndInspectDeviceKeys.mockResolvedValue({
      devices: [{ serial: '123', readerName: 'reader' }],
      inspections: [{
        serial: '123', readerName: 'reader', ed25519Supported: true,
        touchPolicySupported: 'supported', pinStatus: { status: 'required', retries: 3 },
        slots: [{ slot: '9c', status: 'empty' }],
      }],
    });
    const identity = fakeIdentityService();
    identity.inspectRoot.mockResolvedValue({
      serial: '123', readerName: 'reader', slot: '9d', status: 'empty',
      pinStatus: { status: 'required', retries: 3 },
    });
    const confirm = vi.fn(async () => true);

    await yubiProgram(env, signing, identity, confirm).parseAsync(
      ['device', 'integrity', '--fix', '--device', '123'], { from: 'user' },
    );

    expect(confirm).toHaveBeenCalledOnce();
    expect(loadSignerInventory().keys[`ed25519:${PUBLIC_KEY}`]).toBeUndefined();
    expect((await registry.read()).sources[enrolled.id]).toBeUndefined();
    expect(JSON.parse(env.stdout.at(-1)!)).toMatchObject({
      signingKeys: { removedPublicKeys: [PUBLIC_KEY] },
      identityRoots: { removedIdentityRoots: [enrolled.id] },
    });
  });
});

function yubiProgram(
  env: CliTestEnv,
  signing: ReturnType<typeof fakeSigningService>,
  identity: ReturnType<typeof fakeIdentityService>,
  confirm: (message: string) => Promise<boolean> = async () => true,
): Command {
  const program = new Command().exitOverride();
  registerYubiKeyCliCommand({
    program, stderr: env.stderr, stdout: env.stdout, runNested: async () => {},
    serviceFactory: () => signing,
    identityServiceFactory: () => identity,
    interactionFactory: () => ({
      promptPin: async () => '123456', promptManagementKey: async () => '', confirm,
    }),
  });
  return program;
}

function fakeSigningService() {
  return {
    listDevices: vi.fn<YubiKeyService['listDevices']>(async () => [{ serial: '123', readerName: 'reader' }]),
    inspectDevice: vi.fn<YubiKeyService['inspectDevice']>(async () => ({
      serial: '123', readerName: 'reader', slots: [], ed25519Supported: true,
      touchPolicySupported: 'supported', pinStatus: { status: 'required', retries: 3 },
    })),
    listAndInspectDeviceKeys: vi.fn<YubiKeyService['listAndInspectDeviceKeys']>(async () => ({ devices: [], inspections: [] })),
    generateEd25519Key: vi.fn<YubiKeyService['generateEd25519Key']>(async () => ({
      serial: '123', readerName: 'reader', slot: '9c', publicKey: PUBLIC_KEY,
      pinPolicy: 'once', touchPolicy: 'cached', replacedExistingKey: false,
    })),
    importEd25519Key: vi.fn<YubiKeyService['importEd25519Key']>(),
    unlockDevice: vi.fn<YubiKeyService['unlockDevice']>(),
    lockDevice: vi.fn<NonNullable<YubiKeyService['lockDevice']>>(),
    signEd25519Digest: vi.fn<YubiKeyService['signEd25519Digest']>(),
    close: vi.fn<NonNullable<YubiKeyService['close']>>(),
  } satisfies YubiKeyService;
}

function fakeIdentityService() {
  return {
    listDevices: vi.fn<IdentityYubiKeyService['listDevices']>(async () => [{ serial: '123', readerName: 'reader' }]),
    inspectRoot: vi.fn<IdentityYubiKeyService['inspectRoot']>(async () => ({
      serial: '123', readerName: 'reader', slot: '9d', status: 'occupied', publicKey: ROOT_PUBLIC_KEY,
      pinStatus: { status: 'required', retries: 3 },
    })),
    generateRoot: vi.fn<IdentityYubiKeyService['generateRoot']>(async () => ({
      serial: '123', readerName: 'reader', slot: '9d', status: 'occupied', publicKey: ROOT_PUBLIC_KEY,
      pinStatus: { status: 'required', retries: 3 }, replacedExistingKey: false,
    })),
    importRoot: vi.fn<IdentityYubiKeyService['importRoot']>(),
    pinStatus: vi.fn<IdentityYubiKeyService['pinStatus']>(async () => ({ status: 'required', retries: 3 })),
    pinUnlock: vi.fn<IdentityYubiKeyService['pinUnlock']>(),
    pinLock: vi.fn<IdentityYubiKeyService['pinLock']>(),
    createAgreement: vi.fn<IdentityYubiKeyService['createAgreement']>(() => {
      throw new Error('agreement is outside this test');
    }),
    close: vi.fn<NonNullable<IdentityYubiKeyService['close']>>(),
  } satisfies IdentityYubiKeyService;
}
import { createHash } from 'node:crypto';
