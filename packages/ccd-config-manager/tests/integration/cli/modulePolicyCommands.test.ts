import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import {
  getConfigDir,
  getSignerConfigPath,
  getSigningModuleEnabled,
  isIdentitySourceBackendEnabled,
} from '@ccd-agent-kit/config-utils';

const hardwareFactories = vi.hoisted(() => ({
  signer: vi.fn(() => { throw new Error('unexpected signer hardware construction'); }),
  identity: vi.fn(() => { throw new Error('unexpected identity hardware construction'); }),
  transport: vi.fn(() => { throw new Error('unexpected transport construction'); }),
}));

vi.mock('@ccd-agent-kit/piv-utils', async importOriginal => ({
  ...await importOriginal<typeof import('@ccd-agent-kit/piv-utils')>(),
  createNativePivYubiKeyService: hardwareFactories.signer,
  createIdentityYubiKeyService: hardwareFactories.identity,
  createPivTransport: hardwareFactories.transport,
}));

import { runCli } from '../../../src/bin/ccd-config-manager.js';
import { setupCliTestEnv, type CliTestEnv } from '../../helpers/testEnv.js';

function identityPolicyPath(): string {
  return join(getConfigDir(), 'id-manager', 'config.json');
}

describe('consumer module policy commands', () => {
  let env: CliTestEnv;
  beforeEach(() => { env = setupCliTestEnv('module-policy-'); });
  afterEach(() => env.restore());

  it('lists and reports persisted defaults without writes or hardware construction', async () => {
    await capture(async ({ stdout }) => {
      expect(await runCli(['service', 'signer', 'module', 'list'])).toBe(0);
      expect(await runCli(['service', 'signer', 'module', 'inspect', '--module', 'software-signer'])).toBe(0);
      expect(await runCli(['service', 'id-manager', 'module', 'list'])).toBe(0);
      expect(await runCli(['service', 'id-manager', 'module', 'inspect', '--backend', 'yubikey-piv'])).toBe(0);
      const output = stdout.mock.calls.flat().join('');
      expect(output).toContain('software-signer');
      expect(output).toContain('yubikey-piv');
      expect(output).toMatch(/enabled/i);
    });
    expect(existsSync(getSignerConfigPath())).toBe(false);
    expect(existsSync(identityPolicyPath())).toBe(false);
    expect(hardwareFactories.signer).not.toHaveBeenCalled();
    expect(hardwareFactories.identity).not.toHaveBeenCalled();
    expect(hardwareFactories.transport).not.toHaveBeenCalled();
  });

  it.each([
    ['software-signer', 'software-signer'],
    ['yubikey-piv', 'yubikey-piv'],
  ])('accepts signer selector %s for %s', async (selector, moduleId) => {
    expect(await runCli(['service', 'signer', 'module', 'disable', '--module', selector])).toBe(0);
    expect(getSigningModuleEnabled(moduleId)).toBe(false);
    expect(await runCli(['service', 'signer', 'module', 'enable', '--module', selector])).toBe(0);
    expect(getSigningModuleEnabled(moduleId)).toBe(true);
  });

  it('persists signer and identity-manager policy independently', async () => {
    expect(await runCli(['service', 'signer', 'module', 'disable', '--module', 'yubikey-piv'])).toBe(0);
    expect(await runCli(['service', 'id-manager', 'module', 'disable', '--backend', 'yubikey-piv'])).toBe(0);
    expect(getSigningModuleEnabled('yubikey-piv')).toBe(false);
    expect(isIdentitySourceBackendEnabled('yubikey-piv')).toBe(false);
    expect(JSON.parse(readFileSync(getSignerConfigPath(), 'utf8'))).toHaveProperty(
      'signer.config.signingModules.yubikey-piv.enabled', false,
    );
    expect(JSON.parse(readFileSync(identityPolicyPath(), 'utf8'))).toEqual({
      version: 1, backends: { 'yubikey-piv': { enabled: false } },
    });

    expect(await runCli(['service', 'id-manager', 'module', 'enable', '--backend', 'yubikey-piv'])).toBe(0);
    expect(isIdentitySourceBackendEnabled('yubikey-piv')).toBe(true);
    expect(getSigningModuleEnabled('yubikey-piv')).toBe(false);
  });

  it('reads persisted list and status policy without rewriting either file', async () => {
    expect(await runCli(['service', 'signer', 'module', 'disable', '--module', 'software-signer'])).toBe(0);
    expect(await runCli(['service', 'id-manager', 'module', 'disable', '--backend', 'yubikey-piv'])).toBe(0);
    const signerBefore = readFileSync(getSignerConfigPath(), 'utf8');
    const identityBefore = readFileSync(identityPolicyPath(), 'utf8');

    expect(await runCli(['service', 'signer', 'module', 'list'])).toBe(0);
    expect(await runCli(['service', 'signer', 'module', 'inspect', '--module', 'software-signer'])).toBe(0);
    expect(await runCli(['service', 'id-manager', 'module', 'list'])).toBe(0);
    expect(await runCli(['service', 'id-manager', 'module', 'inspect', '--backend', 'yubikey-piv'])).toBe(0);

    expect(readFileSync(getSignerConfigPath(), 'utf8')).toBe(signerBefore);
    expect(readFileSync(identityPolicyPath(), 'utf8')).toBe(identityBefore);
  });

  it.each([
    ['service', 'signer', 'module', 'enable', '--module', 'missing'],
    ['service', 'signer', 'module', 'inspect', '--module', 'software'],
    ['service', 'signer', 'module', 'disable'],
    ['service', 'signer', 'module', 'list', '--module', 'software-signer'],
    ['service', 'id-manager', 'module', 'enable', '--backend', 'missing'],
    ['service', 'id-manager', 'module', 'inspect', '--backend', 'missing'],
    ['service', 'id-manager', 'module', 'disable'],
    ['service', 'id-manager', 'module', 'list', '--backend', 'yubikey-piv'],
  ])('rejects invalid module syntax without changing state: %j', async (...args) => {
    const signerBefore = getSigningModuleEnabled('software-signer');
    const identityBefore = isIdentitySourceBackendEnabled('yubikey-piv');
    await capture(async ({ stderr }) => {
      expect(await runCli(args)).toBe(2);
      expect(stderr.mock.calls.flat().join('')).toMatch(/error|unknown|required/i);
    });
    expect(getSigningModuleEnabled('software-signer')).toBe(signerBefore);
    expect(isIdentitySourceBackendEnabled('yubikey-piv')).toBe(identityBefore);
    expect(existsSync(getSignerConfigPath())).toBe(false);
    expect(existsSync(identityPolicyPath())).toBe(false);
  });
});

async function capture(callback: (spies: { stdout: MockInstance; stderr: MockInstance }) => Promise<void>): Promise<void> {
  const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  try { await callback({ stdout, stderr }); }
  finally { stdout.mockRestore(); stderr.mockRestore(); }
}
