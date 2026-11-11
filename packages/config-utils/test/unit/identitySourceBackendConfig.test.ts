import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  getConfigDir,
  getSignerConfigPath,
  isIdentitySourceBackendEnabled,
  setIdentitySourceBackendPolicy,
  YUBIKEY_IDENTITY_SOURCE_BACKEND,
} from '../../src/index.js';
import { useConfigSandbox } from '../helpers/configSandbox.js';

function identityPolicyPath(): string {
  return join(getConfigDir(), 'id-manager', 'config.json');
}

describe('shared identity source backend configuration', () => {
  useConfigSandbox();

  it('uses the enabled YubiKey default without writing state', () => {
    expect(YUBIKEY_IDENTITY_SOURCE_BACKEND).toBe('yubikey-piv');
    expect(isIdentitySourceBackendEnabled('yubikey-piv')).toBe(true);
    expect(isIdentitySourceBackendEnabled('unknown')).toBe(false);
    expect(existsSync(identityPolicyPath())).toBe(false);
  });

  it('persists the exact existing version-1 format with protected permissions', () => {
    setIdentitySourceBackendPolicy('yubikey-piv', 'disabled');

    expect(isIdentitySourceBackendEnabled('yubikey-piv')).toBe(false);
    expect(JSON.parse(readFileSync(identityPolicyPath(), 'utf8'))).toEqual({
      version: 1,
      backends: { 'yubikey-piv': { enabled: false } },
    });
    expect(statSync(dirname(identityPolicyPath())).mode & 0o077).toBe(0);
    expect(statSync(identityPolicyPath()).mode & 0o077).toBe(0);

    setIdentitySourceBackendPolicy('yubikey-piv', 'enabled');
    expect(isIdentitySourceBackendEnabled('yubikey-piv')).toBe(true);
  });

  it('keeps identity-manager and signer policies in independent files', () => {
    setIdentitySourceBackendPolicy('yubikey-piv', 'disabled');

    expect(existsSync(identityPolicyPath())).toBe(true);
    expect(existsSync(getSignerConfigPath())).toBe(false);
  });

  it('rejects unknown backends without creating or changing state', () => {
    expect(() => setIdentitySourceBackendPolicy('missing', 'disabled')).toThrow(/unknown/i);
    expect(existsSync(identityPolicyPath())).toBe(false);

    setIdentitySourceBackendPolicy('yubikey-piv', 'disabled');
    const before = readFileSync(identityPolicyPath(), 'utf8');
    expect(() => setIdentitySourceBackendPolicy('missing', 'enabled')).toThrow(/unknown/i);
    expect(readFileSync(identityPolicyPath(), 'utf8')).toBe(before);
  });

  it.each([
    { version: 2, backends: {} },
    { version: 1, backends: {}, extra: true },
    { version: 1, backends: { 'yubikey-piv': { enabled: 'yes' } } },
    { version: 1, backends: { 'yubikey-piv': { enabled: true, extra: true } } },
  ])('rejects unsupported raw formats without rewriting them', document => {
    mkdirSync(dirname(identityPolicyPath()), { recursive: true, mode: 0o700 });
    const original = JSON.stringify(document);
    writeFileSync(identityPolicyPath(), original, { mode: 0o600 });
    expect(() => isIdentitySourceBackendEnabled('yubikey-piv')).toThrow(/unsupported/i);
    expect(readFileSync(identityPolicyPath(), 'utf8')).toBe(original);
  });

  it('rejects unsafe policy-file permissions', () => {
    mkdirSync(dirname(identityPolicyPath()), { recursive: true, mode: 0o700 });
    writeFileSync(identityPolicyPath(), JSON.stringify({ version: 1, backends: {} }));
    chmodSync(identityPolicyPath(), 0o644);
    expect(() => isIdentitySourceBackendEnabled('yubikey-piv')).toThrow(/unsafe/i);
  });
});
