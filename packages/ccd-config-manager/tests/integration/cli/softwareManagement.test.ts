import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  initializeEncryptedFileStorage,
  isEncryptedFileStorageUnlocked,
  loadSignerInventory,
  lockEncryptedFileStorage,
  unlockEncryptedFileStorage,
} from '@ccd-agent-kit/config-utils';
import { ed25519PublicKey } from '@ccd-agent-kit/sdk-utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runKeyCommand } from '../../../src/cli/keyCommand.js';
import { runStorageCommand } from '../../../src/cli/storageCommand.js';
import { setupCliTestEnv, type CliTestEnv } from '../../helpers/testEnv.js';

const PRIVATE_KEY = '11'.repeat(32);
const PUBLIC_KEY = ed25519PublicKey.require('d04ab232742bb4ab3a1368bd4615e4e6d0224ab71a016baf8520a332c9778737');
const SECOND_PRIVATE_KEY = '22'.repeat(32);
const SECOND_PUBLIC_KEY = ed25519PublicKey.require('a09aa5f47a6759802ff955f8dc2d2a14a5c99d23be97f864127ff9383455a4f0');
const ADDRESS = '3DPgLSmDKt7tvAybE95obMXANrUChv5aBpzGPU3qjaG7ERG6JC';

describe('software management component integration', () => {
  let env: CliTestEnv;

  beforeEach(() => {
    env = setupCliTestEnv('software-management-');
    mkdirSync(process.env.XDG_DATA_HOME!, { recursive: true });
  });

  afterEach(() => {
    lockEncryptedFileStorage();
    env.restore();
  });

  it('imports a real key file through encrypted protected storage into public inventory', async () => {
    const file = join(process.env.XDG_DATA_HOME!, 'direct-key.json');
    writeFileSync(file, JSON.stringify({ scheme: 'Ed25519', signKey: PRIVATE_KEY, verifyKey: PUBLIC_KEY }));
    initializeEncryptedFileStorage('pw');
    lockEncryptedFileStorage();

    expect(await runKeyCommand({
      request: { action: 'import', file, storage: 'encrypted-file', label: 'protected' },
      promptUnlockPassword: async () => 'pw',
      ...env,
    })).toBe(0);

    expect(loadSignerInventory().keys[`ed25519:${PUBLIC_KEY}`]).toMatchObject({
      label: 'protected',
      backends: [{ signingModule: 'software-signer', backend: { storageModule: 'encrypted-file' } }],
    });
    expect(env.stdout).toContain(`Public key: ${PUBLIC_KEY}`);
  });

  it('imports all keys from a representative wallet export with indexed labels', async () => {
    initializeEncryptedFileStorage('pw');
    lockEncryptedFileStorage();
    const file = join(process.env.XDG_DATA_HOME!, 'wallet.export');
    writeFileSync(file, JSON.stringify({
      type: 'concordium-browser-wallet-account', v: 0,
      value: {
        address: ADDRESS,
        credentials: { '0': 'aa'.repeat(32) },
        accountKeys: { keys: { '0': { keys: {
          '0': { signKey: PRIVATE_KEY, verifyKey: PUBLIC_KEY },
          '1': { signKey: SECOND_PRIVATE_KEY, verifyKey: SECOND_PUBLIC_KEY },
        }, threshold: 1 } }, threshold: 1 },
      },
    }));

    expect(await runKeyCommand({
      request: { action: 'import', file, label: 'wallet', storage: 'encrypted-file' },
      promptUnlockPassword: async () => 'pw',
      ...env,
    })).toBe(0);
    expect(loadSignerInventory().keys[`ed25519:${PUBLIC_KEY}`]?.label).toBe('wallet-0');
    expect(loadSignerInventory().keys[`ed25519:${SECOND_PUBLIC_KEY}`]?.label).toBe('wallet-1');
    expect(env.stdout.join('\n')).toMatch(new RegExp(`Account: ${ADDRESS}.*Imported keys: 2`, 's'));
  });

  it('runs the real encrypted storage initialize, lock, status, and password-change lifecycle', async () => {
    expect(await runStorageCommand({
      request: { action: 'init', backend: 'encrypted-file' },
      promptPassword: async () => 'old',
      ...env,
    })).toBe(0);
    expect(isEncryptedFileStorageUnlocked()).toBe(true);
    expect(existsSync(join(
      process.env.XDG_DATA_HOME!, 'ccd-agent-kit', 'signer', 'key-storage', 'encrypted-file.json',
    ))).toBe(true);

    lockEncryptedFileStorage();
    env.stdout.length = 0;
    expect(await runStorageCommand({ request: { action: 'status' }, ...env })).toBe(0);
    expect(JSON.parse(env.stdout[0]!).backends['encrypted-file'].readiness).toBe('locked');

    const passwords = ['old', 'new', 'new'];
    expect(await runStorageCommand({
      request: { action: 'change-password', backend: 'encrypted-file' },
      promptPassword: async () => passwords.shift() ?? '',
      ...env,
    })).toBe(0);
    expect(isEncryptedFileStorageUnlocked()).toBe(false);
    expect(() => unlockEncryptedFileStorage('old')).toThrow();
    expect(() => unlockEncryptedFileStorage('new')).not.toThrow();
  });
});
