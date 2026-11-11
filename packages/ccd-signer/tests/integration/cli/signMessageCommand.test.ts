import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

vi.mock('@noble/ed25519', () => ({
  signAsync: vi.fn(async () => new Uint8Array(64).fill(0x44)),
}));

import { createSignMessageCommandRequest, runSignMessageCommand } from '../../../src/cli/signMessageCommand.js';
import { runCliWithOutput } from '../../cli/runCliWithOutput.js';
import { saveAccountLabels, setAccountLabel } from '@ccd-agent-kit/config-utils';
import { useSignerSandbox } from '../../helpers/sandbox.js';
import { MAINNET_REF, TESTNET_REF } from '../../helpers/syntheticWallet.js';
import { transactionFixtures } from '../../helpers/transactionFixtures.js';
import { setObservedEd25519Key, writeEncryptedKey } from '../../helpers/inventory.js';
import { TEST_PUBLIC_KEY_EF, testEd25519PublicKeyHex } from '../../helpers/ed25519.js';

const LOCAL_PUBLIC_KEY = testEd25519PublicKeyHex('e734ea6c2b6257de72355e472aa05a4c487e6b463c029ed306df2f01b5636b58');
const sandboxRoot = useSignerSandbox({ resetNetwork: true });

describe('runSignMessageCommand', () => {
  it('signs text input for an account with refreshed credentials and a local key', async () => {
    addLocalObservedKey(transactionFixtures.sender, MAINNET_REF);

    const stdout: string[] = [];
    const exitCode = await runSignMessageCommand({
      request: createSignMessageCommandRequest({ account: transactionFixtures.sender, input: 'hello', format: 'text' }),
      stderr: [],
      stdout,
    });

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout.join('\n'))).toMatchObject({
      account: transactionFixtures.sender,
      inputFormat: 'text',
      messageHex: '68656c6c6f',
      messageText: 'hello',
      network: 'mainnet',
    });
  });

  it('accepts an account label as account input and shows it in output', async () => {
    addLocalObservedKey(transactionFixtures.sender, MAINNET_REF);
    setAccountLabel({ address: transactionFixtures.sender, label: 'this-one' }, MAINNET_REF);

    const stdout: string[] = [];
    const exitCode = await runSignMessageCommand({
      request: createSignMessageCommandRequest({ account: 'this-one', input: 'hello', format: 'text' }),
      stderr: [],
      stdout,
    });

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout.join('\n'))).toMatchObject({ account: transactionFixtures.sender, label: 'this-one' });
  });

  it('preserves the canonical case-insensitively selected label when aliases share an address', async () => {
    addLocalObservedKey(transactionFixtures.sender, MAINNET_REF);
    saveAccountLabels({ First: transactionFixtures.sender, Selected: transactionFixtures.sender }, MAINNET_REF);

    const stdout: string[] = [];
    const exitCode = await runSignMessageCommand({
      request: createSignMessageCommandRequest({ account: 'SELECTED', input: 'hello', format: 'text' }),
      stderr: [],
      stdout,
    });

    expect(exitCode).toBe(0);
    const result = JSON.parse(stdout.join('\n')) as Record<string, unknown>;
    expect(result).toMatchObject({ account: transactionFixtures.sender, label: 'Selected' });
  });

  it('reads file input on an explicitly selected network', async () => {
    addLocalObservedKey(transactionFixtures.sender, TESTNET_REF);
    const inputFile = join(sandboxRoot(), 'message.txt');
    writeFileSync(inputFile, 'hello');

    const stdout: string[] = [];
    const exitCode = await runSignMessageCommand({
      request: createSignMessageCommandRequest({ account: transactionFixtures.sender, inputFile, format: 'text', network: 'testnet' }),
      stderr: [],
      stdout,
    });

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout.join('\n'))).toMatchObject({ messageText: 'hello', network: 'testnet' });
  });

  it('reads message input from stdin', async () => {
    addLocalObservedKey(transactionFixtures.sender, MAINNET_REF);

    const stdout: string[] = [];
    const exitCode = await runSignMessageCommand({
      request: createSignMessageCommandRequest({ account: transactionFixtures.sender, stdin: true, format: 'text' }),
      stdin: 'hello',
      stderr: [],
      stdout,
    });

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout.join('\n')).messageText).toBe('hello');
  });

  it('reads message input from process.stdin when requested', async () => {
    addLocalObservedKey(transactionFixtures.sender, MAINNET_REF);
    const originalDescriptor = Object.getOwnPropertyDescriptor(process, 'stdin');
    Object.defineProperty(process, 'stdin', { configurable: true, value: Readable.from(['hello']) });

    try {
      const stdout: string[] = [];
      const exitCode = await runSignMessageCommand({
        request: createSignMessageCommandRequest({ account: transactionFixtures.sender, stdin: true, format: 'text' }),
        stderr: [],
        stdout,
      });

      expect(exitCode).toBe(0);
      expect(JSON.parse(stdout.join('\n')).messageText).toBe('hello');
    } finally {
      if (originalDescriptor) Object.defineProperty(process, 'stdin', originalDescriptor);
    }
  });

  it('reports signing errors for malformed hex input after account resolution succeeds', async () => {
    addLocalObservedKey(transactionFixtures.sender, MAINNET_REF);

    const stderr: string[] = [];
    const exitCode = await runSignMessageCommand({
      request: createSignMessageCommandRequest({ account: transactionFixtures.sender, input: 'abc', format: 'hex' }),
      stderr,
      stdout: [],
    });

    expect(exitCode).toBe(1);
    expect(stderr.join('\n')).toContain('Signing failed: Message hex must be a valid even-length hex string.');
  });

  it('returns usage errors with CLI exit code', async () => {
    const stderr: string[] = [];
    const stdout: string[] = [];
    const exitCode = await runCliWithOutput(['sign-message', '--account', transactionFixtures.sender, '--input', 'hello'], {
      stderr,
      stdout,
    });

    expect(exitCode).toBe(2);
    expect(stderr.join('\n')).toContain("required option '--format <format>'");
    expect(stdout).toEqual([]);
  });

  it('returns an error when account credentials are not refreshed', async () => {
    const stderr: string[] = [];
    const exitCode = await runSignMessageCommand({
      request: createSignMessageCommandRequest({ account: transactionFixtures.sender, input: 'hello', format: 'text' }),
      stderr,
      stdout: [],
    });

    expect(exitCode).toBe(1);
    expect(stderr.join('\n')).toContain('No finalized account credentials cached');
  });

  it('returns an error when refreshed credentials have no matching local key', async () => {
    setObservedEd25519Key(transactionFixtures.sender, MAINNET_REF, TEST_PUBLIC_KEY_EF);

    const stderr: string[] = [];
    const exitCode = await runSignMessageCommand({
      request: createSignMessageCommandRequest({ account: transactionFixtures.sender, input: 'hello', format: 'text' }),
      stderr,
      stdout: [],
    });

    expect(exitCode).toBe(1);
    expect(stderr.join('\n')).toContain('No local signer key matches finalized account credentials');
  });
});

function addLocalObservedKey(address: string, caip2Ref: string): void {
  writeEncryptedKey(LOCAL_PUBLIC_KEY, 'aa'.repeat(32));
  setObservedEd25519Key(address, caip2Ref, LOCAL_PUBLIC_KEY);
}
