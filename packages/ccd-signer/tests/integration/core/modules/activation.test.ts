import { rmSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { upsertSignerInventoryKey } from '@ccd-agent-kit/config-utils';
import { activateSignerModules } from '../../../../src/core/modules/activation.js';
import { registerSignerModule } from '../../../../src/core/modules/registry.js';
import type { SignerModule } from '../../../../src/core/modules/types.js';
import type { YubiKeyDeviceSummary, YubiKeyDeviceWatcher, YubiKeyInspection, YubiKeyService } from '@ccd-agent-kit/piv-utils';
import { TEST_PUBLIC_KEY_AB } from '../../../helpers/ed25519.js';
import { makeTestTempDir } from '../../../helpers/tempDir.js';

const MODULE_ID = 'activation-test-module';
const PUBLIC_KEY = TEST_PUBLIC_KEY_AB;
describe('activateSignerModules', () => {
  let tempDir: string;
  let originalConfig: string | undefined;
  let originalData: string | undefined;
  let originalState: string | undefined;
  let cleanups: Array<() => void>;

  beforeEach(() => {
    originalConfig = process.env.XDG_CONFIG_HOME;
    originalData = process.env.XDG_DATA_HOME;
    originalState = process.env.XDG_STATE_HOME;
    tempDir = makeTestTempDir('signer-module-activation-test-');
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

  it('passes visible backend descriptors to module activation and closes activated runtimes', async () => {
    const close = vi.fn();
    const activate = vi.fn(async () => ({ close }));
    cleanups.push(registerSignerModule(testModule({ activate })));
    upsertSignerInventoryKey({
      backend: { ref: 'activation-backend' },
      publicKey: PUBLIC_KEY,
      scheme: 'Ed25519',
      signingModule: MODULE_ID,
    });

    const runtime = await activateSignerModules({ services: { yubiKeyService: new EmptyYubiKeyService() } });

    expect(activate).toHaveBeenCalledWith(expect.objectContaining({
      backends: [expect.objectContaining({
        backendEntry: expect.objectContaining({ signingModule: MODULE_ID }),
        publicKey: PUBLIC_KEY,
        scheme: 'Ed25519',
      })],
    }));

    await runtime.close();
    await runtime.close();

    expect(close).toHaveBeenCalledTimes(1);
  });

  it('closes earlier module runtimes when later activation fails', async () => {
    const close = vi.fn();
    cleanups.push(registerSignerModule(testModule({ activate: async () => ({ close }), id: 'activation-first' })));
    cleanups.push(registerSignerModule(testModule({ activate: async () => { throw new Error('activation failed'); }, id: 'activation-second' })));

    await expect(activateSignerModules({ services: { yubiKeyService: new EmptyYubiKeyService() } })).rejects.toThrow('activation failed');

    expect(close).toHaveBeenCalledOnce();
  });

  it('reloads persisted inventory descriptors without reactivating modules', async () => {
    const refresh = vi.fn();
    const activate = vi.fn(async () => ({ close: vi.fn(), refresh }));
    cleanups.push(registerSignerModule(testModule({ activate })));
    const runtime = await activateSignerModules({ services: { yubiKeyService: new EmptyYubiKeyService() } });
    try {
      upsertSignerInventoryKey({ backend: { ref: 'new' }, publicKey: PUBLIC_KEY, scheme: 'Ed25519', signingModule: MODULE_ID });
      await runtime.refresh();
      expect(refresh).toHaveBeenCalledWith([expect.objectContaining({ publicKey: PUBLIC_KEY, backendEntry: expect.objectContaining({ backend: { ref: 'new' } }) })]);
      expect(activate).toHaveBeenCalledTimes(1);
    } finally { await runtime.close(); }
  });

});

function testModule(input: Pick<SignerModule, 'activate'> & { id?: string }): SignerModule {
  return {
    activate: input.activate,
    defaultEnabled: true,
    id: input.id ?? MODULE_ID,
    isBackendVisible: () => true,
    signEd25519Digest: async () => '11'.repeat(64),
  };
}

class EmptyYubiKeyService implements YubiKeyService {
  public async listDevices(): Promise<YubiKeyDeviceSummary[]> {
    return [];
  }

  public async inspectDevice(): Promise<never> {
    throw new Error('not used');
  }

  public async listAndInspectDeviceKeys(): Promise<{ devices: YubiKeyDeviceSummary[]; inspections: YubiKeyInspection[] }> {
    return { devices: [], inspections: [] };
  }

  public async watchDevices(): Promise<YubiKeyDeviceWatcher> {
    return { close: () => undefined };
  }

  public async generateEd25519Key(): Promise<never> {
    throw new Error('not used');
  }

  public async importEd25519Key(): Promise<never> {
    throw new Error('not used');
  }

  public async unlockDevice(): Promise<never> {
    throw new Error('not used');
  }

  public async signEd25519Digest(): Promise<never> {
    throw new Error('not used');
  }
}
