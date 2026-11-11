import { createIdentitySourceRegistry } from '@ccd-agent-kit/config-utils';
import type {
  IdentityRootInspection,
  IdentityYubiKeyService,
  PivSessionPool,
  PivTransport,
} from '@ccd-agent-kit/piv-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultIdentitySourceService } from '../../src/core/sources/runtime.js';
import {
  OTHER_ROOT_PUBLIC_KEY,
  ROOT_PUBLIC_KEY,
  otherSourceRecord,
  sourceRecord,
} from '../sourceHelpers.js';
import { useTestXdg } from '../xdgTestHelpers.js';

const piv = vi.hoisted(() => {
  const state = { deviceChanged: undefined as (() => void) | undefined };
  const watcher = { close: vi.fn(() => undefined) };
  const transport = {
    async withCards<T>(): Promise<T> { throw new Error('Unexpected card access'); },
    async withSelectedCard<T>(): Promise<T> { throw new Error('Unexpected card access'); },
    watchDevices: vi.fn(async ({ onChanged }) => {
      state.deviceChanged = onChanged;
      return watcher;
    }),
  } satisfies PivTransport;
  const pool = {
    async withCard<T>(): Promise<T> { throw new Error('Unexpected card access'); },
    retain: vi.fn(async () => undefined),
    release: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  } satisfies PivSessionPool;
  const hardware = {
    listDevices: vi.fn(async () => []),
    inspectRoot: vi.fn(async (serial): Promise<IdentityRootInspection> => ({
      readerName: `YubiKey ${serial}`,
      serial,
      slot: '9d',
      status: 'occupied',
      algorithm: 'ECCP256',
      publicKey: serial === '87654321' ? OTHER_ROOT_PUBLIC_KEY : ROOT_PUBLIC_KEY,
      pinPolicy: 'never',
      touchPolicy: 'always',
      pinStatus: { status: 'verified' },
    })),
    async generateRoot() { throw new Error('Unexpected root generation'); },
    async importRoot() { throw new Error('Unexpected root import'); },
    pinStatus: vi.fn(async () => ({ status: 'verified' as const })),
    pinUnlock: vi.fn(async () => undefined),
    pinLock: vi.fn(async () => undefined),
    createAgreement: vi.fn(() => ({
      agree: vi.fn(async peerPublicKey => ({ publicKey: peerPublicKey, sharedSecret: Buffer.alloc(32) })),
    })),
    close: vi.fn(async () => undefined),
  } satisfies IdentityYubiKeyService;
  return { state, watcher, transport, pool, hardware };
});

vi.mock('@ccd-agent-kit/piv-utils', async importOriginal => ({
  ...await importOriginal<typeof import('@ccd-agent-kit/piv-utils')>(),
  createPivTransport: () => piv.transport,
  createPivSessionPool: () => piv.pool,
  createIdentityYubiKeyService: () => piv.hardware,
}));

useTestXdg('source-runtime-', ['XDG_CONFIG_HOME', 'XDG_DATA_HOME']);

beforeEach(async () => {
  vi.clearAllMocks();
  piv.state.deviceChanged = undefined;
});

describe('runtime identity-source composition', () => {
  it('composes the protected catalog, YubiKey backend, PIV pool, watcher, and source service', async () => {
    const enrolled = await createIdentitySourceRegistry().enroll(sourceRecord());
    const service = createDefaultIdentitySourceService({ persistent: true });

    await expect(service.list()).resolves.toEqual([
      { id: enrolled.id, label: 'primary', isDefault: false, availability: 'unlocked' },
    ]);
    expect(piv.pool.retain).toHaveBeenCalledExactlyOnceWith('12345678');
    expect(piv.hardware.inspectRoot).toHaveBeenCalledExactlyOnceWith('12345678');
    expect(piv.transport.watchDevices).toHaveBeenCalledOnce();

    await service.close!();
    expect(piv.watcher.close).toHaveBeenCalledOnce();
    expect(piv.hardware.close).toHaveBeenCalledOnce();
  });

  it('reconciles protected-catalog replacement after a hardware device change', async () => {
    const registry = createIdentitySourceRegistry();
    await registry.enroll(sourceRecord());
    const service = createDefaultIdentitySourceService({ persistent: true });
    await service.list();

    await registry.forgetLocation('primary', 'all');
    const replacement = await registry.enroll(otherSourceRecord());
    piv.state.deviceChanged!();

    await expect(service.list()).resolves.toEqual([
      { id: replacement.id, label: 'secondary', isDefault: false, availability: 'unlocked' },
    ]);
    expect(piv.pool.release).toHaveBeenCalledWith('12345678');
    expect(piv.pool.retain).toHaveBeenCalledWith('87654321');
    await service.close!();
  });
});
