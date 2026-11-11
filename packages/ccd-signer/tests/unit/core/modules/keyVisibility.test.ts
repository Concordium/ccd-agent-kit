import { afterEach, describe, expect, it } from 'vitest';

import type { SignerConfigFile, SignerInventory, SignerInventoryBackendEntry } from '@ccd-agent-kit/config-utils';
import { listVisibleSignerInventoryKeysFromSnapshot } from '../../../../src/core/modules/keyVisibility.js';
import { registerSignerModule } from '../../../../src/core/modules/registry.js';
import type { SignerModule } from '../../../../src/core/modules/types.js';
import { TEST_PUBLIC_KEY_AB } from '../../../helpers/ed25519.js';

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

describe('listVisibleSignerInventoryKeysFromSnapshot', () => {
  it('preserves producer backend order while filtering disabled and module-hidden entries', () => {
    cleanups.push(registerSignerModule(module('first', true, true)));
    cleanups.push(registerSignerModule(module('hidden', true, false)));
    cleanups.push(registerSignerModule(module('last', false, true)));
    const backends = [backend('first'), backend('hidden'), backend('last')];

    const [key] = listVisibleSignerInventoryKeysFromSnapshot(inventory(backends), config({ last: { enabled: true } }));

    expect(key?.backends.map(({ signingModule }) => signingModule)).toEqual(['first', 'last']);
  });

  it('omits entries without a canonical key or a visible registered backend', () => {
    cleanups.push(registerSignerModule(module('disabled', true, true)));
    const snapshot = inventory([backend('disabled')]);
    Object.assign(snapshot.keys, { 'ed25519:not-hex': snapshot.keys[`ed25519:${TEST_PUBLIC_KEY_AB}`]! });

    expect(listVisibleSignerInventoryKeysFromSnapshot(snapshot, config({ disabled: { enabled: false } }))).toEqual([]);
  });
});

function module(id: string, defaultEnabled: boolean, visible: boolean): SignerModule {
  return { defaultEnabled, id, isBackendVisible: () => visible, signEd25519Digest: async () => '' };
}

function backend(signingModule: string): SignerInventoryBackendEntry {
  return { backend: { ref: signingModule }, createdAt: '2026-01-01T00:00:00.000Z', signingModule, updatedAt: '2026-01-01T00:00:00.000Z' };
}

function config(signingModules: SignerConfigFile['signer']['config']['signingModules']): SignerConfigFile {
  return { moduleConfigs: {}, signer: { config: { signingModules } }, version: 1 };
}

function inventory(backends: SignerInventoryBackendEntry[]): SignerInventory {
  return {
    keys: {
      [`ed25519:${TEST_PUBLIC_KEY_AB}`]: {
        backends,
        createdAt: '2026-01-01T00:00:00.000Z',
        scheme: 'Ed25519' as const,
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    },
    updatedAt: '2026-01-01T00:00:00.000Z',
    version: 1,
  };
}
