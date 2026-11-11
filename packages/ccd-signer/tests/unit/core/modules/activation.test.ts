import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { VisibleSignerInventoryKey } from '../../../../src/core/modules/keyVisibility.js';
import type { SignerModule } from '../../../../src/core/modules/types.js';
import { TEST_PUBLIC_KEY_AB } from '../../../helpers/ed25519.js';

const dependencies = vi.hoisted(() => ({
  keys: [] as VisibleSignerInventoryKey[],
  modules: [] as SignerModule[],
}));
vi.mock('@ccd-agent-kit/config-utils', () => ({
  getSignerConfigPath: () => 'config.json',
  getSignerInventoryPath: () => 'inventory.json',
}));
vi.mock('../../../../src/core/modules/keyVisibility.js', () => ({
  listVisibleSignerInventoryKeys: () => dependencies.keys,
}));
vi.mock('../../../../src/core/modules/registry.js', () => ({ listSignerModules: () => dependencies.modules }));

import { activateSignerModules } from '../../../../src/core/modules/activation.js';

beforeEach(() => {
  dependencies.keys = [];
  dependencies.modules = [];
});

describe('activateSignerModules', () => {
  it('refreshes ordered visible descriptors and closes modules once', async () => {
    const close = vi.fn();
    const refresh = vi.fn();
    const activate = vi.fn(async () => ({ close, refresh }));
    dependencies.modules = [module('runtime', activate)];
    dependencies.keys = [visibleKey('runtime', 'first')];
    const runtime = await activateSignerModules();
    dependencies.keys = [visibleKey('runtime', 'second')];

    await runtime.refresh();
    await runtime.close();
    await runtime.close();

    expect(activate).toHaveBeenCalledWith(expect.objectContaining({ backends: [expect.objectContaining({ publicKey: TEST_PUBLIC_KEY_AB })] }));
    expect(refresh).toHaveBeenCalledWith([expect.objectContaining({ backendEntry: expect.objectContaining({ backend: { ref: 'second' } }) })]);
    expect(close).toHaveBeenCalledOnce();
  });

  it('closes activated sessions when a later module activation fails', async () => {
    const close = vi.fn();
    dependencies.modules = [
      module('first', async () => ({ close })),
      module('second', async () => { throw new Error('failed'); }),
    ];

    await expect(activateSignerModules()).rejects.toThrow('failed');

    expect(close).toHaveBeenCalledOnce();
  });
});

function module(id: string, activate: NonNullable<SignerModule['activate']>): SignerModule {
  return { activate, defaultEnabled: true, id, isBackendVisible: () => true, signEd25519Digest: async () => '' };
}

function visibleKey(signingModule: string, ref: string): VisibleSignerInventoryKey {
  const backendEntry = { backend: { ref }, createdAt: '', signingModule, updatedAt: '' };
  return {
    backends: [backendEntry],
    entry: { backends: [backendEntry], createdAt: '', scheme: 'Ed25519', updatedAt: '' },
    keyRef: `ed25519:${TEST_PUBLIC_KEY_AB}`,
    publicKey: TEST_PUBLIC_KEY_AB,
  };
}
