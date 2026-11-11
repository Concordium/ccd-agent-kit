import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fsMocks = vi.hoisted(() => ({
  readFileSync: vi.fn<typeof import('node:fs').readFileSync>(),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  fsMocks.readFileSync.mockImplementation(actual.readFileSync);
  return { ...actual, readFileSync: fsMocks.readFileSync };
});

import { rmSync } from 'node:fs';
import { join } from 'node:path';

import { listSignerKeys } from '../../../../src/core/keys/listSignerKeys.js';
import { initializeEncryptedFileStorage, lockEncryptedFileStorage } from '@ccd-agent-kit/config-utils';
import { saveSignerInventory, SIGNER_INVENTORY_VERSION, upsertSignerInventoryKey } from '@ccd-agent-kit/config-utils';
import { isSignerInventoryEntryVisible } from '../../../../src/core/modules/keyVisibility.js';
import { makeTestTempDir } from '../../../helpers/tempDir.js';
import { testEd25519PublicKey } from '../../../helpers/ed25519.js';
import { FAKE_VERIFY_KEY_HEX } from '../../../helpers/syntheticWallet.js';
import { encryptedSoftwareEntry, registerStatusModule, softwareEntry } from '../../../helpers/inventory.js';

describe('listSignerKeys', () => {
  let tempDir: string;
  let originalConfig: string | undefined;
  let originalData: string | undefined;
  let originalState: string | undefined;
  const cleanups: Array<() => void> = [];

  beforeEach(() => {
    originalConfig = process.env.XDG_CONFIG_HOME;
    originalData = process.env.XDG_DATA_HOME;
    originalState = process.env.XDG_STATE_HOME;
    tempDir = makeTestTempDir('list-signer-keys-test-');
    process.env.XDG_CONFIG_HOME = join(tempDir, 'config');
    process.env.XDG_DATA_HOME = join(tempDir, 'data');
    process.env.XDG_STATE_HOME = join(tempDir, 'state');
  });

  afterEach(() => {
    while (cleanups.length > 0) cleanups.pop()?.();
    lockEncryptedFileStorage();
    rmSync(tempDir, { recursive: true, force: true });
    if (originalConfig !== undefined) process.env.XDG_CONFIG_HOME = originalConfig;
    else delete process.env.XDG_CONFIG_HOME;
    if (originalData !== undefined) process.env.XDG_DATA_HOME = originalData;
    else delete process.env.XDG_DATA_HOME;
    if (originalState !== undefined) process.env.XDG_STATE_HOME = originalState;
    else delete process.env.XDG_STATE_HOME;
  });

  it('returns an empty key list and reports software entries visible under policy', () => {
    expect(listSignerKeys()).toEqual({ keys: [] });
    expect(isSignerInventoryEntryVisible(softwareEntry())).toBe(true);
  });

  it('lists public keys without custody details', () => {
    upsertSignerInventoryKey({
      backend: {
        devices: [{ kind: 'yubikey', pinPolicy: 'never', serial: '39713352', slot: '82', touchPolicy: 'never' }],
      },
      publicKey: FAKE_VERIFY_KEY_HEX,
      scheme: 'Ed25519',
      signingModule: 'yubikey-piv',
    });

    const result = listSignerKeys();

    expect(result).toEqual({ keys: [{ publicKey: FAKE_VERIFY_KEY_HEX, scheme: 'Ed25519', status: 'unknown' }] });
    expect(JSON.stringify(result)).not.toMatch(/keyRef|backend|devices|serial|slot|pinPolicy|touchPolicy|39713352|82/);
  });

  it('sorts keys and includes labels', () => {
    const later = testEd25519PublicKey('ff');
    const earlier = testEd25519PublicKey('11');
    saveSignerInventory({
      version: SIGNER_INVENTORY_VERSION,
      updatedAt: '2026-09-25T00:00:00.000Z',
      keys: {
        [`ed25519:${later}`]: {
          ...softwareEntry('local/later.json'),
          label: 'later_key',
        },
        [`ed25519:${earlier}`]: {
          ...encryptedSoftwareEntry('encrypted/earlier.json'),
        },
      } as never,
    });

    expect(listSignerKeys()).toEqual({
      keys: [
        { publicKey: earlier, scheme: 'Ed25519', status: 'locked' },
        { label: 'later_key', publicKey: later, scheme: 'Ed25519', status: 'locked' },
      ],
    });
  });

  it('marks encrypted software keys unlocked after encrypted storage is unlocked', () => {
    const publicKey = '22'.repeat(32);
    initializeEncryptedFileStorage('password');
    saveSignerInventory({
      version: SIGNER_INVENTORY_VERSION,
      updatedAt: '2026-09-25T00:00:00.000Z',
      keys: {
        [`ed25519:${publicKey}`]: encryptedSoftwareEntry('encrypted/key.json'),
      },
    });

    expect(listSignerKeys()).toEqual({
      keys: [{ publicKey, scheme: 'Ed25519', status: 'unlocked' }],
    });
  });

  it('aggregates backend status by unlocked, locked, unknown, then unavailable priority', () => {
    const publicKey = '33'.repeat(32);
    cleanups.push(registerStatusModule('test-unavailable', 'unavailable'));
    cleanups.push(registerStatusModule('test-unknown', 'unknown'));
    cleanups.push(registerStatusModule('test-locked', 'locked'));
    cleanups.push(registerStatusModule('test-unlocked', 'unlocked'));
    saveSignerInventory({
      version: SIGNER_INVENTORY_VERSION,
      updatedAt: '2026-09-25T00:00:00.000Z',
      keys: {
        [`ed25519:${publicKey}`]: {
          backends: ['test-unavailable', 'test-unknown', 'test-locked', 'test-unlocked'].map((signingModule) => ({
            backend: { ref: signingModule },
            createdAt: '2026-09-25T00:00:00.000Z',
            signingModule,
            updatedAt: '2026-09-25T00:00:00.000Z',
          })),
          createdAt: '2026-09-25T00:00:00.000Z',
          scheme: 'Ed25519' as const,
          updatedAt: '2026-09-25T00:00:00.000Z',
        },
      } as never,
    });

    expect(listSignerKeys()).toEqual({
      keys: [{ publicKey, scheme: 'Ed25519', status: 'unlocked' }],
    });
  });

  it('uses the visible backend set once when listing statuses', () => {
    const publicKey = testEd25519PublicKey('55');
    cleanups.push(registerStatusModule('test-call-count', 'unlocked'));
    upsertSignerInventoryKey({
      backend: { ref: 'counted' },
      publicKey,
      scheme: 'Ed25519',
      signingModule: 'test-call-count',
    });
    fsMocks.readFileSync.mockClear();

    expect(listSignerKeys()).toEqual({ keys: [{ publicKey, scheme: 'Ed25519', status: 'unlocked' }] });

    expect(fsMocks.readFileSync.mock.calls.filter(([path]) => String(path).endsWith(join('data', 'ccd-agent-kit', 'signer', 'inventory.json')))).toHaveLength(1);
  });

  it('reports unavailable when every visible backend is unavailable', () => {
    const publicKey = testEd25519PublicKey('44');
    cleanups.push(registerStatusModule('test-unavailable-only', 'unavailable'));
    upsertSignerInventoryKey({
      backend: { ref: 'unavailable' },
      publicKey,
      scheme: 'Ed25519',
      signingModule: 'test-unavailable-only',
    });

    expect(listSignerKeys()).toEqual({ keys: [{ publicKey, scheme: 'Ed25519', status: 'unavailable' }] });
  });
});
