import { describe, expect, it, vi } from 'vitest';

import { runCli } from '../../../src/bin/ccd-config-manager.js';

async function capture(argv: string[]) {
  const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  try {
    return {
      exitCode: await runCli(argv),
      stdout: stdout.mock.calls.flat().join(''),
      stderr: stderr.mock.calls.flat().join(''),
    };
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
  }
}

describe('ccd-config-manager key and root management ownership', () => {
  it.each(['signing-key', 'identity-root', 'storage', 'device', 'account', 'contract-instance', 'network', 'service', 'paths'])(
    'advertises the %s management namespace without touching hardware',
    async (command) => {
      const result = await capture([command, '--help']);
      expect(result).toMatchObject({
        exitCode: 0,
        stdout: expect.stringContaining(`Usage: ccd-config-manager ${command}`),
        stderr: '',
      });
    },
  );

  it('advertises signing-key and identity-root management from ccd-config-manager top-level help', async () => {
    const result = await capture(['--help']);
    expect(result).toMatchObject({ exitCode: 0, stderr: '' });
    expect(result.stdout).toMatch(/^\s+signing-key\b/m);
    expect(result.stdout).toMatch(/^\s+identity-root\b/m);
    expect(result.stdout).toMatch(/^\s+storage\b/m);
    expect(result.stdout).toMatch(/^\s+device\b/m);
    expect(result.stdout).toMatch(/^\s+account\b/m);
    expect(result.stdout).toMatch(/^\s+service\b/m);
    expect(result.stdout).not.toMatch(/^\s+(software|yubikey|account-label|account-credentials|signer|id-manager|chain-client)\b/m);
  });

  it.each([
    [
      ['signing-key', '--help'],
      ['list', 'inspect', 'generate', 'import', 'adopt', 'label', 'backend', 'locations'],
    ],
    [
      ['signing-key', 'label', '--help'],
      ['set', 'remove'],
    ],
    [
      ['identity-root', '--help'],
      ['list', 'inspect', 'generate', 'import', 'adopt', 'forget', 'label', 'backend', 'locations', 'default'],
    ],
    [
      ['identity-root', 'locations', '--help'],
      ['order', 'forget'],
    ],
    [['identity-root', 'backend', '--help'], ['order']],
    [
      ['storage', '--help'],
      ['list', 'inspect', 'init', 'enable', 'disable', 'change-password', 'integrity'],
    ],
    [
      ['device', '--help'],
      ['list', 'inspect', 'register', 'rename', 'unregister', 'pin-status', 'unlock', 'lock', 'defaults', 'integrity'],
    ],
    [
      ['account', '--help'],
      ['label', 'credentials'],
    ],
    [
      ['contract-instance', 'label', '--help'],
      ['list', 'inspect', 'find', 'set', 'remove'],
    ],
    [
      ['service', '--help'],
      ['signer', 'id-manager', 'chain-client'],
    ],
  ])('advertises complete management paths for %j', async (argv, operations) => {
    const result = await capture(argv);
    expect(result).toMatchObject({ exitCode: 0, stderr: '' });
    for (const operation of operations) expect(result.stdout).toContain(operation);
  });

  it.each([
    ['software'], ['yubikey'], ['account-label'], ['account-credentials'],
    ['signer'], ['id-manager'], ['chain-client'],
    ['network', 'show'], ['network', 'default', '--name', 'mainnet'],
  ])('does not retain removed command aliases: %j', async (...argv) => {
    const result = await capture(argv);
    expect(result.exitCode).toBe(2);
  });
});
