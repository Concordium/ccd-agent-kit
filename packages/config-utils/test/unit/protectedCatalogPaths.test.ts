import { chmodSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { createECDH, createHash } from 'node:crypto';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  createIdentitySourceRegistry,
  getDataDir,
  getIdentitySourcesPath,
  getSignerInventoryPath,
  getYubiKeyRegistrationsPath,
  loadSignerInventory,
  saveSignerInventory,
  saveYubiKeyRegistrations,
  type IdentitySourceRecord,
} from '../../src/index.js';
import { writeProtectedJsonAtomic } from '../../src/signer/protectedFile.js';
import { useConfigSandbox } from '../helpers/configSandbox.js';

const EMPTY_INVENTORY = { version: 1 as const, updatedAt: '2026-10-23T00:00:00.000Z', keys: {} };
const EMPTY_DEVICES = { version: 1 as const, updatedAt: '2026-10-23T00:00:00.000Z', devices: {} };

function source(): IdentitySourceRecord {
  const key = createECDH('prime256v1');
  key.generateKeys();
  const root = key.getPublicKey(undefined, 'uncompressed');
  return {
    label: 'primary', recipeVersion: 1, rootPublicKey: root.toString('hex'),
    rootPublicKeyFingerprint: createHash('sha256').update(root).digest('hex'),
    backends: [{ backend: 'yubikey-piv', locations: [{ serial: '12345678' }] }],
  };
}

describe('protected catalog paths', () => {
  useConfigSandbox();

  it('propagates filesystem traversal errors while checking for a protected file', () => {
    writeFileSync(process.env.XDG_DATA_HOME!, 'not a directory', { mode: 0o600 });
    let failure: unknown;
    try {
      loadSignerInventory();
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: 'ENOTDIR' });
  });

  it.each([
    ['signer inventory', getSignerInventoryPath, () => saveSignerInventory(EMPTY_INVENTORY)],
    ['YubiKey registry', getYubiKeyRegistrationsPath, () => saveYubiKeyRegistrations(EMPTY_DEVICES)],
  ] as const)('rejects a symlinked %s directory without writing outside', (_label, path, save) => {
    const filename = path();
    const outside = join(process.env.XDG_DATA_HOME!, 'outside');
    mkdirSync(outside, { recursive: true, mode: 0o700 });
    mkdirSync(dirname(dirname(filename)), { recursive: true, mode: 0o700 });
    symlinkSync(outside, dirname(filename));

    expect(save).toThrow();
    expect(() => readFileSync(join(outside, filename.split('/').at(-1)!), 'utf8')).toThrow();
  });

  it.each([
    ['signer inventory', getSignerInventoryPath, () => saveSignerInventory(EMPTY_INVENTORY)],
    ['YubiKey registry', getYubiKeyRegistrationsPath, () => saveYubiKeyRegistrations(EMPTY_DEVICES)],
  ] as const)('rejects an existing dangling %s target and preserves the link', (_label, path, save) => {
    const filename = path();
    const missing = join(process.env.XDG_DATA_HOME!, 'missing-target');
    mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
    symlinkSync(missing, filename);

    expect(save).toThrow();
    expect(() => readFileSync(missing, 'utf8')).toThrow();
  });

  it.each([
    ['signer inventory', getSignerInventoryPath, () => saveSignerInventory(EMPTY_INVENTORY)],
    ['YubiKey registry', getYubiKeyRegistrationsPath, () => saveYubiKeyRegistrations(EMPTY_DEVICES)],
  ] as const)('rejects an overly permissive %s directory instead of silently chmodding it', (_label, path, save) => {
    const directory = dirname(path());
    mkdirSync(directory, { recursive: true, mode: 0o755 });
    chmodSync(directory, 0o755);
    expect(save).toThrow();
  });

  it('rejects symlinked identity-source ancestry without changing the external file', async () => {
    const outside = join(process.env.XDG_DATA_HOME!, 'outside-sources');
    const original = 'external state\n';
    mkdirSync(outside, { recursive: true, mode: 0o700 });
    writeFileSync(join(outside, 'marker'), original, { mode: 0o600 });
    mkdirSync(dirname(dirname(getIdentitySourcesPath())), { recursive: true, mode: 0o700 });
    symlinkSync(outside, dirname(getIdentitySourcesPath()));

    await expect(createIdentitySourceRegistry().enroll(source())).rejects.toMatchObject({ code: 'STORAGE_FAILED' });
    expect(readFileSync(join(outside, 'marker'), 'utf8')).toBe(original);
  });

  it.each(['signer', 'id-manager'] as const)(
    'rejects a permissive application root for the protected %s namespace',
    (namespace) => {
      const appRoot = getDataDir();
      const directory = join(appRoot, namespace, 'nested');
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      chmodSync(appRoot, 0o755);

      expect(() => writeProtectedJsonAtomic(join(directory, 'catalog.json'), {}, 'catalog')).toThrow(/unsafe/i);
    },
  );
});
