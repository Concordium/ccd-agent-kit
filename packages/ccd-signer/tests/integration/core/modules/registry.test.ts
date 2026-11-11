import { rmSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { listSignerKeys } from '../../../../src/core/keys/listSignerKeys.js';
import {
  loadModuleConfig,
  saveModuleConfig,
  saveSignerInventory,
  SIGNER_INVENTORY_VERSION,
  upsertSignerInventoryKey,
} from '@ccd-agent-kit/config-utils';
import { registerSignerModule } from '../../../../src/core/modules/registry.js';
import { signVisibleInventoryEd25519Digest } from '../../../../src/core/modules/signing.js';
import type { SignerModule } from '../../../../src/core/modules/types.js';
import { TEST_PUBLIC_KEY_AB } from '../../../helpers/ed25519.js';
import { makeTestTempDir } from '../../../helpers/tempDir.js';
import type { Ed25519PublicKeyHex } from '@ccd-agent-kit/sdk-utils';

const PUBLIC_KEY = TEST_PUBLIC_KEY_AB;
const MODULE_ID = 'test-signer';

describe('signer module registry', () => {
  let tempDir: string;
  let originalConfig: string | undefined;
  let originalData: string | undefined;
  let originalState: string | undefined;
  let cleanups: Array<() => void>;

  beforeEach(() => {
    originalConfig = process.env.XDG_CONFIG_HOME;
    originalData = process.env.XDG_DATA_HOME;
    originalState = process.env.XDG_STATE_HOME;
    tempDir = makeTestTempDir('signer-module-registry-test-');
    process.env.XDG_CONFIG_HOME = join(tempDir, 'config');
    process.env.XDG_DATA_HOME = join(tempDir, 'data');
    process.env.XDG_STATE_HOME = join(tempDir, 'state');
    cleanups = [];
  });

  afterEach(() => {
    for (const cleanup of cleanups.reverse()) cleanup();
    rmSync(tempDir, { recursive: true, force: true });
    if (originalConfig !== undefined) process.env.XDG_CONFIG_HOME = originalConfig;
    else delete process.env.XDG_CONFIG_HOME;
    if (originalData !== undefined) process.env.XDG_DATA_HOME = originalData;
    else delete process.env.XDG_DATA_HOME;
    if (originalState !== undefined) process.env.XDG_STATE_HOME = originalState;
    else delete process.env.XDG_STATE_HOME;
  });

  it('hides inventory entries owned by unregistered modules', async () => {
    saveRegistryTestInventory(MODULE_ID);
    setModuleEnabled(MODULE_ID, true);

    expect(listSignerKeys()).toEqual({ keys: [] });
    awaitExpectUnavailable(PUBLIC_KEY);
  });

  it('uses registered modules for visibility and signing', async () => {
    saveRegistryTestInventory(MODULE_ID);
    cleanups.push(registerSignerModule(testSignerModule({ visible: true, signatureHex: '11'.repeat(64) })));

    expect(listSignerKeys()).toEqual({ keys: [{ publicKey: PUBLIC_KEY, scheme: 'Ed25519', status: 'unknown' }] });
    await expect(signVisibleInventoryEd25519Digest({ digest: new Uint8Array([1, 2, 3]), publicKey: PUBLIC_KEY })).resolves.toBe('11'.repeat(64));
  });

  it('uses registered module backend status for listed keys', () => {
    saveRegistryTestInventory(MODULE_ID);
    cleanups.push(registerSignerModule(testSignerModule({ backendStatus: 'locked', visible: true })));

    expect(listSignerKeys()).toEqual({ keys: [{ publicKey: PUBLIC_KEY, scheme: 'Ed25519', status: 'locked' }] });
  });

  it('hides registered modules disabled by signer-owned policy', async () => {
    saveRegistryTestInventory(MODULE_ID);
    cleanups.push(registerSignerModule(testSignerModule({ visible: true, signatureHex: '22'.repeat(64) })));
    setModuleEnabled(MODULE_ID, false);

    expect(listSignerKeys()).toEqual({ keys: [] });
    await expect(signVisibleInventoryEd25519Digest({ digest: new Uint8Array([1]), publicKey: PUBLIC_KEY })).rejects.toThrow('not available');
  });

  it('rechecks visibility before fallback signing attempts', async () => {
    const fallbackModuleId = 'test-fallback-signer';
    saveRegistryTestInventory(MODULE_ID);
    upsertSignerInventoryKey({ backend: { ok: true }, publicKey: PUBLIC_KEY, scheme: 'Ed25519', signingModule: fallbackModuleId });
    cleanups.push(registerSignerModule(testSignerModule({
      async signEd25519Digest() {
        setModuleEnabled(fallbackModuleId, false);
        throw new Error('primary failed');
      },
      visible: true,
    })));
    cleanups.push(registerSignerModule(testSignerModule({ id: fallbackModuleId, signatureHex: '33'.repeat(64), visible: true })));

    await expect(signVisibleInventoryEd25519Digest({ digest: new Uint8Array([1]), publicKey: PUBLIC_KEY })).rejects.toThrow('not available');
  });

});

function setModuleEnabled(moduleId: string, enabled: boolean): void {
  const config = loadModuleConfig();
  config.signer.config.signingModules[moduleId] = { enabled };
  saveModuleConfig(config);
}

function saveRegistryTestInventory(signingModule: string): void {
  const keyRef = `ed25519:${PUBLIC_KEY}` as const;
  saveSignerInventory({
    keys: {
      [keyRef]: {
        backends: [
          {
            backend: { ok: true },
            createdAt: '2026-09-26T00:00:00.000Z',
            signingModule,
            updatedAt: '2026-09-26T00:00:00.000Z',
          },
        ],
        createdAt: '2026-09-26T00:00:00.000Z',
        scheme: 'Ed25519' as const,
        updatedAt: '2026-09-26T00:00:00.000Z',
      },
    },
    updatedAt: '2026-09-26T00:00:00.000Z',
    version: SIGNER_INVENTORY_VERSION,
  });
}

function testSignerModule(options: Partial<Pick<SignerModule, 'signEd25519Digest'>> & { backendStatus?: 'unknown' | 'unlocked' | 'locked' | 'unavailable'; id?: string; signatureHex?: string; visible: boolean }): SignerModule {
  return {
    defaultEnabled: true,
    id: options.id ?? MODULE_ID,
    ...(options.backendStatus !== undefined ? { getBackendStatus: () => options.backendStatus ?? 'unknown' } : {}),
    isBackendVisible: () => options.visible,
    signEd25519Digest: options.signEd25519Digest ?? (async () => options.signatureHex ?? '00'.repeat(64)),
  };
}

async function awaitExpectUnavailable(publicKey: Ed25519PublicKeyHex): Promise<void> {
  await expect(signVisibleInventoryEd25519Digest({ digest: new Uint8Array([1]), publicKey })).rejects.toThrow('not available');
}
