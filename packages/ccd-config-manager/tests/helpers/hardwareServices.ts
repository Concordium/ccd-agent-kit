import type { IdentityYubiKeyService, YubiKeyService } from '@ccd-agent-kit/piv-utils';
import { ed25519PublicKey } from '@ccd-agent-kit/sdk-utils';
import { vi } from 'vitest';

export const TEST_SIGNING_PUBLIC_KEY = ed25519PublicKey.require(
  'd04ab232742bb4ab3a1368bd4615e4e6d0224ab71a016baf8520a332c9778737',
);
export const TEST_IDENTITY_PUBLIC_KEY =
  '040217e617f0b6443928278f96999e69a23a4f2c152bdf6d6cdf66e5b80282d4ed194a7debcb97712d2dda3ca85aa8765a56f45fc758599652f2897c65306e5794';

/** Creates an entirely in-memory, typed signing-hardware collaborator. */
export function fakeSigningService(): YubiKeyServiceMock {
  return {
    listDevices: vi.fn<YubiKeyService['listDevices']>(async () => [{ serial: '123', readerName: 'reader' }]),
    inspectDevice: vi.fn<YubiKeyService['inspectDevice']>(async serial => ({
      serial: serial ?? '123', readerName: 'reader', slots: [],
      ed25519Supported: true, touchPolicySupported: 'supported',
      pinStatus: { status: 'required', retries: 3 },
    })),
    listAndInspectDeviceKeys: vi.fn<YubiKeyService['listAndInspectDeviceKeys']>(async () => ({
      devices: [], inspections: [],
    })),
    generateEd25519Key: vi.fn<YubiKeyService['generateEd25519Key']>(async () => ({
      publicKey: TEST_SIGNING_PUBLIC_KEY,
      serial: '123', slot: '9c', pinPolicy: 'once', touchPolicy: 'cached',
      readerName: 'reader', replacedExistingKey: false,
    })),
    importEd25519Key: vi.fn<YubiKeyService['importEd25519Key']>(),
    unlockDevice: vi.fn<YubiKeyService['unlockDevice']>(),
    lockDevice: vi.fn<NonNullable<YubiKeyService['lockDevice']>>(),
    signEd25519Digest: vi.fn<YubiKeyService['signEd25519Digest']>(),
    watchDevices: vi.fn<NonNullable<YubiKeyService['watchDevices']>>(),
    close: vi.fn<NonNullable<YubiKeyService['close']>>(),
  };
}

/** Creates an entirely in-memory, typed identity-hardware collaborator. */
export function fakeIdentityService(): IdentityYubiKeyServiceMock {
  const pinStatus = { status: 'required' as const, retries: 3 };
  return {
    listDevices: vi.fn<IdentityYubiKeyService['listDevices']>(async () => [{ serial: '123', readerName: 'reader' }]),
    inspectRoot: vi.fn<IdentityYubiKeyService['inspectRoot']>(async serial => ({
      serial, readerName: 'reader', slot: '9d', status: 'occupied',
      publicKey: TEST_IDENTITY_PUBLIC_KEY, pinStatus,
    })),
    generateRoot: vi.fn<IdentityYubiKeyService['generateRoot']>(async input => ({
      serial: input.serial, readerName: 'reader', slot: '9d', status: 'occupied',
      publicKey: TEST_IDENTITY_PUBLIC_KEY, pinStatus, replacedExistingKey: false,
    })),
    importRoot: vi.fn<IdentityYubiKeyService['importRoot']>(async input => ({
      serial: input.serial, readerName: 'reader', slot: '9d', status: 'occupied',
      publicKey: TEST_IDENTITY_PUBLIC_KEY, pinStatus, replacedExistingKey: false,
    })),
    pinStatus: vi.fn<IdentityYubiKeyService['pinStatus']>(async () => pinStatus),
    pinUnlock: vi.fn<IdentityYubiKeyService['pinUnlock']>(),
    pinLock: vi.fn<IdentityYubiKeyService['pinLock']>(),
    createAgreement: vi.fn<IdentityYubiKeyService['createAgreement']>(),
    close: vi.fn<NonNullable<IdentityYubiKeyService['close']>>(),
  };
}

export type YubiKeyServiceMock = {
  [K in keyof Required<YubiKeyService>]: ReturnType<typeof vi.fn<Required<YubiKeyService>[K]>>;
};

export type IdentityYubiKeyServiceMock = {
  [K in keyof Required<IdentityYubiKeyService>]: ReturnType<typeof vi.fn<Required<IdentityYubiKeyService>[K]>>;
};
