import { rmSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const nativeYubiKeyService = vi.hoisted(() => ({
  generateEd25519Key: vi.fn(async () => {
    throw new Error('unexpected YubiKey generation');
  }),
  inspectDevice: vi.fn(async () => {
    throw new Error('unexpected YubiKey inspection');
  }),
  listAndInspectDeviceKeys: vi.fn(async () => ({ devices: [], inspections: [] })),
  listDevices: vi.fn(async () => []),
  signEd25519Digest: vi.fn(async () => {
    throw new Error('unexpected YubiKey signing');
  }),
}));

vi.mock('@ccd-agent-kit/piv-utils', async importOriginal => ({
  ...await importOriginal<typeof import('@ccd-agent-kit/piv-utils')>(),
  createNativePivYubiKeyService: () => nativeYubiKeyService,
}));

import { runCli } from '../../../src/bin/ccd-signer.js';
import { makeTestTempDir } from '../../helpers/tempDir.js';
import { transactionFixtures } from '../../helpers/transactionFixtures.js';

async function captureCli(argv: string[]) {
  const stdoutWrite = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  const stderrWrite = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  try {
    return {
      exitCode: await runCli(argv),
      stdout: stdoutWrite.mock.calls.flat().join(''),
      stderr: stderrWrite.mock.calls.flat().join(''),
    };
  } finally {
    stdoutWrite.mockRestore();
    stderrWrite.mockRestore();
  }
}

describe('runCli', () => {
  it.each([
    ['describe'],
    ['describe', '--input', 'abc', '--stdin'],
    ['--network'],
    ['sign', '--input', 'abc', '--role', 'baker'],
    ['sign', '--input', 'abc', '--role', 'sender', '--key', '0:0', '--max-signatures', '1'],
    ['sign-message', '--input', 'hello', '--format', 'text'],
    ['sign-message', '--account', 'account', '--input', 'message', '--format', 'binary'],
    ['finalize', '--input', 'abc'],
  ])('classifies option/domain validation as usage errors: %j', async (...argv) => {
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      expect(await runCli(argv)).toBe(2);
      expect(stderr).toHaveBeenCalled();
      if (argv.length === 1 && argv[0] === '--network') {
        expect(stderr.mock.calls.flat().join('')).toContain("option '--network <network>' argument missing");
      }
      expect(stdout).not.toHaveBeenCalled();
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
    }
    expect(nativeYubiKeyService.listDevices).not.toHaveBeenCalled();
    expect(nativeYubiKeyService.signEd25519Digest).not.toHaveBeenCalled();
  });

  it('accepts max-signatures without explicit keys and reaches signing', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      expect(await runCli(['sign', '--input', '00ff', '--role', 'sender', '--max-signatures', '1'])).toBe(1);
      expect(stderr.mock.calls.flat().join('')).not.toContain('Provide either --key');
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
    }
  });

  let originalConfig: string | undefined;
  let originalData: string | undefined;
  let originalState: string | undefined;
  let tempDir: string;

  beforeEach(() => {
    originalConfig = process.env.XDG_CONFIG_HOME;
    originalData = process.env.XDG_DATA_HOME;
    originalState = process.env.XDG_STATE_HOME;
    tempDir = makeTestTempDir('ccd-signer-cli-index-');
    process.env.XDG_CONFIG_HOME = join(tempDir, 'config');
    process.env.XDG_DATA_HOME = join(tempDir, 'data');
    process.env.XDG_STATE_HOME = join(tempDir, 'state');
    nativeYubiKeyService.listDevices.mockResolvedValue([]);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    if (originalConfig !== undefined) process.env.XDG_CONFIG_HOME = originalConfig;
    else delete process.env.XDG_CONFIG_HOME;
    if (originalData !== undefined) process.env.XDG_DATA_HOME = originalData;
    else delete process.env.XDG_DATA_HOME;
    if (originalState !== undefined) process.env.XDG_STATE_HOME = originalState;
    else delete process.env.XDG_STATE_HOME;
  });

  it('dispatches the describe command and writes to stdout', async () => {
    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const stderrWrite = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    try {
      const exitCode = await runCli(['--network', 'not-configured', 'describe', '--input', transactionFixtures.v0HexString]);

      expect(exitCode).toBe(0);
      expect(JSON.parse(String(stdoutWrite.mock.calls[0]?.[0]).trim())).toMatchObject({
        payloadType: 'transfer',
      });
      expect(stderrWrite).not.toHaveBeenCalled();
    } finally {
      stdoutWrite.mockRestore();
      stderrWrite.mockRestore();
    }
  });

  it('returns a usage error when no command is provided', async () => {
    await expect(captureCli([])).resolves.toMatchObject({
      exitCode: 0,
      stdout: expect.stringContaining('Commands:'),
      stderr: '',
    });
  });

  it('prints real Commander help successfully without invoking signer operations', async () => {
    for (const [argv, usage] of [
      [['--help'], 'Usage: ccd-signer [options] [command]'],
      [['-h'], 'Usage: ccd-signer [options] [command]'],
      [['sign', '--help'], 'Usage: ccd-signer sign [options]'],
      [['sign', '-h'], 'Usage: ccd-signer sign [options]'],
    ] as const) {
      const result = await captureCli([...argv]);
      expect(result).toMatchObject({ exitCode: 0, stdout: expect.stringContaining(usage), stderr: '' });
      expect(result.stdout.match(/--network <network>/g)).toHaveLength(1);
    }
    expect(nativeYubiKeyService.listDevices).not.toHaveBeenCalled();
    expect(nativeYubiKeyService.signEd25519Digest).not.toHaveBeenCalled();
  });

  it.each([
    ['help'],
    ['help', 'sign'],
    ['sign', 'help'],
  ])('rejects generated help subcommands without invoking signer operations: %j', async (...argv) => {
    await expect(captureCli(argv)).resolves.toMatchObject({
      exitCode: 2,
      stdout: '',
      stderr: expect.stringContaining('error:'),
    });
    expect(nativeYubiKeyService.listDevices).not.toHaveBeenCalled();
    expect(nativeYubiKeyService.signEd25519Digest).not.toHaveBeenCalled();
  });

  it('returns a usage error for unknown commands', async () => {
    await expect(captureCli(['unknown'])).resolves.toEqual({
      exitCode: 2,
      stdout: '',
      stderr: "error: unknown command 'unknown'\n",
    });
    expect(nativeYubiKeyService.listDevices).not.toHaveBeenCalled();
    expect(nativeYubiKeyService.signEd25519Digest).not.toHaveBeenCalled();
  });

  it('dispatches the list-keys command', async () => {
    const result = await captureCli(['list-keys', '--network', 'not-configured']);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ keys: expect.any(Array) });
    expect(result.stderr).toBe('');
  });

  it('dispatches repeated sign key options through Commander', async () => {
    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const stderrWrite = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    try {
      const exitCode = await runCli([
        '--network',
        'selected-sign-network',
        'sign',
        '--input',
        transactionFixtures.unsignedConfigureDelegationPoolHex,
        '--role',
        'sender',
        '--key',
        '0:0',
        '--key',
        '0:1',
      ]);

      expect(exitCode).toBe(1);
      expect(stdoutWrite).not.toHaveBeenCalled();
      expect(stderrWrite).toHaveBeenCalledWith(expect.stringContaining("Network 'selected-sign-network' not found"));
    } finally {
      stdoutWrite.mockRestore();
      stderrWrite.mockRestore();
    }
  });

  it('dispatches populated sign-message options through Commander', async () => {
    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const stderrWrite = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    try {
      const exitCode = await runCli([
        'sign-message', '--account', 'alice', '--input', 'hello', '--format', 'text',
        '--network', 'selected-message-network',
      ]);

      expect(exitCode).toBe(1);
      expect(stdoutWrite).not.toHaveBeenCalled();
      expect(stderrWrite).toHaveBeenCalledWith(expect.stringContaining("Network 'selected-message-network' not found"));
    } finally {
      stdoutWrite.mockRestore();
      stderrWrite.mockRestore();
    }
  });

  it('dispatches the finalize command', async () => {
    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const stderrWrite = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    try {
      const exitCode = await runCli([
        'finalize',
        '--input',
        transactionFixtures.unsignedTransferWithMemoHex,
        '--signatures',
        JSON.stringify({ sender: { 0: { 0: '22'.repeat(64) } }, sponsor: {} }),
        '--signature-requirements',
        JSON.stringify({ senderNumSignatures: '1', totalSignatureCount: '1' }),
        '--network',
        'not-configured',
      ]);

      expect(exitCode).toBe(0);
      expect(stdoutWrite).toHaveBeenCalled();
      expect(stderrWrite).not.toHaveBeenCalled();
    } finally {
      stdoutWrite.mockRestore();
      stderrWrite.mockRestore();
    }
  });
});
