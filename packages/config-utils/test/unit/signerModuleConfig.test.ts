import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  getSignerConfigPath,
  getSigningModuleEnabled,
  isSoftwareStorageModuleEnabled,
  loadModuleConfig,
  parseSoftwareKeyStorageModuleId,
  setSigningModulePolicy,
  setSoftwareStorageModulePolicy,
} from '../../src/index.js';
import { useConfigSandbox } from '../helpers/configSandbox.js';

describe('shared signer module configuration', () => {
  useConfigSandbox();

  it('returns secure built-in defaults without creating state', () => {
    expect(getSigningModuleEnabled('software-signer')).toBe(true);
    expect(getSigningModuleEnabled('yubikey-piv')).toBe(true);
    expect(getSigningModuleEnabled('unknown')).toBe(false);
    expect(isSoftwareStorageModuleEnabled('encrypted-file')).toBe(true);
    expect(existsSync(getSignerConfigPath())).toBe(false);
  });

  it('persists independent signing and encrypted storage policies', () => {
    setSigningModulePolicy('yubikey-piv', 'disabled');
    setSoftwareStorageModulePolicy('encrypted-file', 'disabled');
    expect(getSigningModuleEnabled('yubikey-piv')).toBe(false);
    expect(isSoftwareStorageModuleEnabled('encrypted-file')).toBe(false);
    setSigningModulePolicy('yubikey-piv', 'enabled');
    setSoftwareStorageModulePolicy('encrypted-file', 'enabled');
    expect(getSigningModuleEnabled('yubikey-piv')).toBe(true);
    expect(isSoftwareStorageModuleEnabled('encrypted-file')).toBe(true);
  });

  it('preserves unknown fields while normalizing known defaults and malformed booleans', () => {
    mkdirSync(dirname(getSignerConfigPath()), { recursive: true });
    chmodSync(dirname(dirname(getSignerConfigPath())), 0o700);
    chmodSync(dirname(getSignerConfigPath()), 0o700);
    writeFileSync(getSignerConfigPath(), JSON.stringify({
      signer: { config: { signingModules: { custom: { enabled: true, keep: 1 }, malformed: { enabled: 'yes' } }, extra: true } },
      moduleConfigs: {
        custom: { config: { nested: true }, keep: 2 },
        'software-signer': { config: {
          schemes: { Future: { enabled: true }, Broken: { enabled: 'yes' } },
          storageModules: { future: { enabled: true, keep: 3 } },
          extra: 'kept',
        } },
      },
    }), { mode: 0o600 });
    setSoftwareStorageModulePolicy('encrypted-file', 'disabled');
    const saved = JSON.parse(readFileSync(getSignerConfigPath(), 'utf8')) as ReturnType<typeof loadModuleConfig>;
    expect(saved.signer.config).toMatchObject({ extra: true, signingModules: {
      custom: { enabled: true, keep: 1 }, malformed: {},
      'software-signer': { enabled: true }, 'yubikey-piv': { enabled: true },
    } });
    expect(getSigningModuleEnabled('malformed')).toBe(false);
    expect(saved.moduleConfigs).toMatchObject({
      custom: { config: { nested: true }, keep: 2 },
      'software-signer': { config: {
        extra: 'kept', schemes: { Ed25519: { enabled: true }, Future: { enabled: true }, Broken: { enabled: false } },
        storageModules: { 'encrypted-file': { enabled: false }, future: { enabled: true, keep: 3 } },
      } },
      'yubikey-piv': { config: {} },
    });
  });

  it('falls back safely for malformed JSON and rejects unknown storage module identifiers', () => {
    mkdirSync(dirname(getSignerConfigPath()), { recursive: true });
    chmodSync(dirname(dirname(getSignerConfigPath())), 0o700);
    chmodSync(dirname(getSignerConfigPath()), 0o700);
    writeFileSync(getSignerConfigPath(), '{bad', { mode: 0o600 });
    expect(loadModuleConfig()).toMatchObject({ version: 1 });
    expect(parseSoftwareKeyStorageModuleId('encrypted-file')).toBe('encrypted-file');
    expect(() => parseSoftwareKeyStorageModuleId('future')).toThrow();
  });
});
