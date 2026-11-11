import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SignerConfigFile, SignerInventory, SignerInventoryBackendEntry } from '@ccd-agent-kit/config-utils';
import { TEST_PUBLIC_KEY_AB } from '../../../helpers/ed25519.js';

const producer = vi.hoisted(() => ({ config: undefined as SignerConfigFile | undefined, inventory: undefined as SignerInventory | undefined }));
vi.mock('@ccd-agent-kit/config-utils', async importOriginal => ({
  ...await importOriginal<typeof import('@ccd-agent-kit/config-utils')>(),
  loadModuleConfig: () => producer.config!,
  loadSignerInventory: () => producer.inventory!,
}));

import { registerSignerModule } from '../../../../src/core/modules/registry.js';
import { signInventoryBackendsEd25519Digest } from '../../../../src/core/modules/signing.js';
import type { SignerModule } from '../../../../src/core/modules/types.js';

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length > 0) cleanups.pop()?.(); });

describe('signInventoryBackendsEd25519Digest', () => {
  it('tries visible backends in inventory order and returns the first successful signature', async () => {
    const attempts: string[] = [];
    const first = backend('first');
    const second = backend('second');
    producer.inventory = inventory([first, second]);
    producer.config = config({});
    cleanups.push(registerSignerModule(module('first', async () => { attempts.push('first'); throw new Error('unavailable'); })));
    cleanups.push(registerSignerModule(module('second', async () => { attempts.push('second'); return '22'.repeat(64); })));

    await expect(signInventoryBackendsEd25519Digest({
      backends: [first, second],
      digest: new Uint8Array([1]),
      publicKey: TEST_PUBLIC_KEY_AB,
    })).resolves.toBe('22'.repeat(64));
    expect(attempts).toEqual(['first', 'second']);
  });

  it('rechecks authorization before each fallback attempt', async () => {
    const first = backend('first-recheck');
    const second = backend('second-recheck');
    producer.inventory = inventory([first, second]);
    producer.config = config({});
    cleanups.push(registerSignerModule(module('first-recheck', async () => {
      producer.config = config({ 'second-recheck': { enabled: false } });
      throw new Error('first failed');
    })));
    const fallback = vi.fn(async () => '33'.repeat(64));
    cleanups.push(registerSignerModule(module('second-recheck', fallback)));

    await expect(signInventoryBackendsEd25519Digest({
      backends: [first, second],
      digest: new Uint8Array([1]),
      publicKey: TEST_PUBLIC_KEY_AB,
    })).rejects.toThrow(/not available/i);
    expect(fallback).not.toHaveBeenCalled();
  });

  it('surfaces the final backend error when every authorized attempt fails', async () => {
    const only = backend('failing');
    producer.inventory = inventory([only]);
    producer.config = config({});
    cleanups.push(registerSignerModule(module('failing', async () => { throw new TypeError('device failed'); })));

    await expect(signInventoryBackendsEd25519Digest({
      backends: [only],
      digest: new Uint8Array([1]),
      publicKey: TEST_PUBLIC_KEY_AB,
    })).rejects.toBeInstanceOf(TypeError);
  });
});

function module(id: string, signEd25519Digest: SignerModule['signEd25519Digest']): SignerModule {
  return { defaultEnabled: true, id, isBackendVisible: () => true, signEd25519Digest };
}

function backend(signingModule: string): SignerInventoryBackendEntry {
  return { backend: { ref: signingModule }, createdAt: '', signingModule, updatedAt: '' };
}

function config(signingModules: SignerConfigFile['signer']['config']['signingModules']): SignerConfigFile {
  return { moduleConfigs: {}, signer: { config: { signingModules } }, version: 1 };
}

function inventory(backends: SignerInventoryBackendEntry[]): SignerInventory {
  return {
    keys: {
      [`ed25519:${TEST_PUBLIC_KEY_AB}`]: { backends, createdAt: '', scheme: 'Ed25519' as const, updatedAt: '' },
    },
    updatedAt: '',
    version: 1,
  };
}
