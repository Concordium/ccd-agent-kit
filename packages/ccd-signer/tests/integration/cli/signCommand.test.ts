import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@noble/ed25519', () => ({
  signAsync: vi.fn(async () => new Uint8Array(64).fill(0x44)),
}));

import {
  CliUsageError,
  createSignCommandRequest,
  runSignCommand,
} from '../../../src/cli/signCommand.js';
import { runCliWithOutput } from '../../cli/runCliWithOutput.js';
import { makeTestTempDir } from '../../helpers/tempDir.js';
import { MAINNET_REF } from '../../helpers/syntheticWallet.js';
import { transactionFixtures } from '../../helpers/transactionFixtures.js';
import { setObservedEd25519Key, writeEncryptedKey } from '../../helpers/inventory.js';
import { testEd25519PublicKeyHex } from '../../helpers/ed25519.js';

const HEX_SENDER = '3BRQgT1WY48tQUcgRNNqqSifo2VEENkY4gCX3Qx9UQ9S7kYVLP';
const HEX_SPONSOR = '3xAJhMaYdBqVb2pyo34nFuNGqsEbtvVaHBELaPoRm9gPvqDqus';
const LOCAL_PUBLIC_KEY = testEd25519PublicKeyHex('e734ea6c2b6257de72355e472aa05a4c487e6b463c029ed306df2f01b5636b58');

describe('createSignCommandRequest', () => {
  it('rejects unknown arguments', async () => {
    expect(await runCliWithOutput(['sign', '--unknown'], { stdout: [], stderr: [] })).toBe(2);
  });

  it('rejects missing role', async () => {
    expect(await runCliWithOutput(['sign', '--input', transactionFixtures.unsignedTransferWithMemoHex], { stdout: [], stderr: [] })).toBe(2);
  });

});

describe('runSignCommand', () => {
  let originalXdgData: string | undefined;
  let originalXdgState: string | undefined;
  let originalXdgConfig: string | undefined;
  let tempDir: string;

  beforeEach(() => {
    originalXdgData = process.env.XDG_DATA_HOME;
    originalXdgState = process.env.XDG_STATE_HOME;
    originalXdgConfig = process.env.XDG_CONFIG_HOME;
    tempDir = makeTestTempDir('cli-sign-test-');
    process.env.XDG_DATA_HOME = join(tempDir, 'xdg');
    process.env.XDG_STATE_HOME = join(tempDir, 'state');
    process.env.XDG_CONFIG_HOME = join(tempDir, 'config');
    // Create network-specific wallet directory for mainnet
    mkdirSync(join(process.env.XDG_DATA_HOME, 'ccd-agent-kit', 'signer', MAINNET_REF), {
      recursive: true,
    });
    mkdirSync(join(process.env.XDG_DATA_HOME, 'ccd-agent-kit', 'account-labels'), { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    if (originalXdgData !== undefined) {
      process.env.XDG_DATA_HOME = originalXdgData;
    } else {
      delete process.env.XDG_DATA_HOME;
    }
    if (originalXdgState !== undefined) {
      process.env.XDG_STATE_HOME = originalXdgState;
    } else {
      delete process.env.XDG_STATE_HOME;
    }
    if (originalXdgConfig !== undefined) {
      process.env.XDG_CONFIG_HOME = originalXdgConfig;
    } else {
      delete process.env.XDG_CONFIG_HOME;
    }
  });

  it('signs a v0 transaction as sender', async () => {
    addLocalObservedKey(HEX_SENDER);

    const stdout: string[] = [];
    const exitCode = await runSignCommand({
      request: createSignCommandRequest({ input: transactionFixtures.unsignedTransferWithMemoHex, role: 'sender' }),
      stderr: [],
      stdout,
    });

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout.join('\n'))).toMatchObject({
      isFullySigned: false,
      roleSigned: 'sender',
    });
  });

  it('reports usage errors without throwing', async () => {
    const stderr: string[] = [];
    const exitCode = await runCliWithOutput(['sign'], {
      stderr,
      stdout: [],
    });

    expect(exitCode).toBe(2);
    expect(stderr.length).toBeGreaterThan(0);
  });

  it('reads transaction input from stdin when requested', async () => {
    addLocalObservedKey(HEX_SENDER);

    const stdout: string[] = [];
    const exitCode = await runSignCommand({
      request: createSignCommandRequest({ stdin: true, role: 'sender' }),
      stdin: transactionFixtures.unsignedTransferWithMemoHex,
      stderr: [],
      stdout,
    });

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout.join('\n')).transaction).toBe(transactionFixtures.unsignedTransferWithMemoHex);
  });

  it('reads transaction input from process.stdin when no explicit stdin option is provided', async () => {
    addLocalObservedKey(HEX_SENDER);

    const originalDescriptor = Object.getOwnPropertyDescriptor(process, 'stdin');
    const fakeStdin = Readable.from([transactionFixtures.unsignedTransferWithMemoHex]);
    Object.defineProperty(process, 'stdin', {
      configurable: true,
      value: fakeStdin,
    });

    try {
      const stdout: string[] = [];
      const exitCode = await runSignCommand({
        request: createSignCommandRequest({ stdin: true, role: 'sender' }),
        stderr: [],
        stdout,
      });

      expect(exitCode).toBe(0);
      expect(JSON.parse(stdout.join('\n')).transaction).toBe(transactionFixtures.unsignedTransferWithMemoHex);
    } finally {
      if (originalDescriptor) {
        Object.defineProperty(process, 'stdin', originalDescriptor);
      }
    }
  });

  it('reads transaction input from a file', async () => {
    addLocalObservedKey(HEX_SENDER);

    const inputPath = join(tempDir, 'transaction.hex');
    writeFileSync(inputPath, transactionFixtures.unsignedTransferWithMemoHex);

    const stdout: string[] = [];
    const exitCode = await runSignCommand({
      request: createSignCommandRequest({ inputFile: inputPath, role: 'sender' }),
      stderr: [],
      stdout,
    });

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout.join('\n')).transaction).toBe(transactionFixtures.unsignedTransferWithMemoHex);
  });

  it('reports signing errors without throwing', async () => {
    const stderr: string[] = [];
    const stdout: string[] = [];
    const exitCode = await runSignCommand({
      request: createSignCommandRequest({ input: transactionFixtures.unsignedTransferWithMemoHex, role: 'sender' }),
      stderr,
      stdout,
    });

    expect(exitCode).toBe(1);
    expect(stderr.join('\n')).toContain('Refresh finalized account credentials');
    expect(stdout).toEqual([]);
  });

  it('uses caller-provided signature requirements to finalize standalone signed output', async () => {
    addLocalObservedKey(HEX_SENDER);

    const stdout: string[] = [];
    const exitCode = await runSignCommand({
      request: createSignCommandRequest({
        input: transactionFixtures.unsignedConfigureDelegationPoolHex,
        role: 'sender',
        signatureRequirements: JSON.stringify({ senderNumSignatures: '1', totalSignatureCount: '1' }),
      }),
      stderr: [],
      stdout,
    });

    const output = JSON.parse(stdout.join('\n'));
    expect(exitCode).toBe(0);
    expect(output).toMatchObject({ isFullySigned: true, signatureRequirementsKnown: true });
    expect(output.blockItemHex).toMatch(/^[0-9a-f]+$/);
  });

  it('reports missing sender address', async () => {
    const stderr: string[] = [];
    const exitCode = await runSignCommand({
      request: createSignCommandRequest({ input: '{"invalid": true}', role: 'sender' }),
      stderr,
      stdout: [],
    });

    expect(exitCode).toBe(1);
    expect(stderr.join('\n')).toContain('Could not extract sender address from transaction.');
  });

  it('reports missing sponsor address before attempting sponsor signing on unsponsored transactions', async () => {
    const stderr: string[] = [];
    const exitCode = await runSignCommand({
      request: createSignCommandRequest({ input: transactionFixtures.unsignedTransferWithMemoHex, role: 'sponsor' }),
      stderr,
      stdout: [],
    });

    expect(exitCode).toBe(1);
    expect(stderr.join('\n')).toContain('Could not extract sponsor address from transaction.');
  });

  it('shows account label when one exists for the sender', async () => {
    addLocalObservedKey(HEX_SENDER);

    const accountLabelsPath = join(process.env.XDG_DATA_HOME!, 'ccd-agent-kit', 'account-labels', `${MAINNET_REF}.json`);
    writeFileSync(accountLabelsPath, JSON.stringify({ alice: HEX_SENDER }));

    const stdout: string[] = [];
    const exitCode = await runSignCommand({
      request: createSignCommandRequest({ input: transactionFixtures.unsignedTransferWithMemoHex, role: 'sender' }),
      stderr: [],
      stdout,
    });

    expect(exitCode).toBe(0);
    const result = JSON.parse(stdout.join('\n')) as Record<string, unknown>;
    expect(result).toMatchObject({ address: HEX_SENDER, label: 'alice' });
  });

  it('signs with an explicit network selection', async () => {
    addLocalObservedKey(HEX_SENDER);

    const stdout: string[] = [];
    const exitCode = await runSignCommand({
      request: createSignCommandRequest({ input: transactionFixtures.unsignedTransferWithMemoHex, role: 'sender', network: 'mainnet' }),
      stderr: [],
      stdout,
    });

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout.join('\n'))).toMatchObject({
      address: HEX_SENDER,
      network: 'mainnet',
    });
  });

  it('reports partial signing for sponsor-only on unsigned v1', async () => {
    addLocalObservedKey(HEX_SPONSOR);

    const stdout: string[] = [];
    const stderr: string[] = [];
    const exitCode = await runSignCommand({
      request: createSignCommandRequest({ input: transactionFixtures.sponsoredPltTransferTransactionHex, role: 'sponsor' }),
      stderr,
      stdout,
    });

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout.join('\n'))).toMatchObject({
      isFullySigned: false,
      roleSigned: 'sponsor',
    });
    expect(stderr).toEqual([]);
  });

  it('validates detached signatures from a file', async () => {
    addLocalObservedKey(HEX_SENDER);

    const signaturesPath = join(tempDir, 'signatures.json');
    writeFileSync(signaturesPath, JSON.stringify({ sender: {}, sponsor: {} }));

    const stdout: string[] = [];
    const exitCode = await runSignCommand({
      request: createSignCommandRequest({ input: transactionFixtures.unsignedTransferWithMemoHex, role: 'sender', signaturesFile: signaturesPath }),
      stderr: [],
      stdout,
    });

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout.join('\n')).signatures.sender).toBeDefined();

    writeFileSync(signaturesPath, JSON.stringify({ sender: { '0': { '01': 'aa' } }, sponsor: {} }));
    expect(() => createSignCommandRequest({
      input: transactionFixtures.unsignedTransferWithMemoHex, role: 'sender', signaturesFile: signaturesPath,
    })).toThrowError(CliUsageError);
  });

  it('reports missing values for signatures-file', async () => {
    const stderr: string[] = [];
    expect(await runCliWithOutput([
        'sign',
        '--input',
        transactionFixtures.unsignedTransferWithMemoHex,
        '--role',
        'sender',
        '--signatures-file',
      ], { stdout: [], stderr })).toBe(2);
    expect(stderr.join('\n')).toContain("option '--signatures-file <path>' argument missing");
  });

  it('signs unsigned transaction hex as sender', async () => {
    addLocalObservedKey(HEX_SENDER);

    const stdout: string[] = [];
    const exitCode = await runSignCommand({
      request: createSignCommandRequest({ input: transactionFixtures.unsignedConfigureDelegationPoolHex, role: 'sender' }),
      stderr: [],
      stdout,
    });

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout.join('\n'))).toMatchObject({
      transaction: transactionFixtures.unsignedConfigureDelegationPoolHex,
    });
  });

  it('reports signing failure for malformed hex input', async () => {
    addLocalObservedKey(HEX_SENDER);

    const stderr: string[] = [];
    const exitCode = await runSignCommand({
      request: createSignCommandRequest({ input: '00ff', role: 'sender' }),
      stderr,
      stdout: [],
    });

    expect(exitCode).toBe(1);
    expect(stderr.join('\n')).toContain('Could not extract sender address from transaction.');
  });

  it('returns error for unknown network', async () => {
    const stderr: string[] = [];
    const exitCode = await runSignCommand({
      request: createSignCommandRequest({ input: transactionFixtures.unsignedTransferWithMemoHex, role: 'sender', network: 'unknown' }),
      stderr,
      stdout: [],
    });

    expect(exitCode).toBe(1);
    expect(stderr.join('\n')).toContain("Network 'unknown' not found");
  });

});

function addLocalObservedKey(address: string, publicKey = LOCAL_PUBLIC_KEY): void {
  writeEncryptedKey(publicKey, 'aa'.repeat(32));
  setObservedEd25519Key(address, MAINNET_REF, publicKey);
}
