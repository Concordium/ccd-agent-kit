import { rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { afterEach, describe, expect, it } from 'vitest';

import { createDescribeCommandRequest, runDescribeCommand } from '../../../src/cli/describeCommand.js';
import { runCliWithOutput } from '../../cli/runCliWithOutput.js';
import { makeTestTempDir } from '../../helpers/tempDir.js';
import { transactionFixtures } from '../../helpers/transactionFixtures.js';

describe('runDescribeCommand', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('renders JSON by default for direct input', async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];

    const exitCode = await runDescribeCommand({
      request: createDescribeCommandRequest({ input: transactionFixtures.v1SponsoredHexString }),
      stderr,
      stdout,
    });

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(JSON.parse(stdout[0]!)).toMatchObject({
      header: { energy: '785' },
      payloadType: 'transfer',
      version: 1,
    });
  });

  it('renders text output when requested', async () => {
    const stdout: string[] = [];

    const exitCode = await runDescribeCommand({
      request: createDescribeCommandRequest({ input: transactionFixtures.v0HexString, output: 'text' }),
      stderr: [],
      stdout,
    });

    expect(exitCode).toBe(0);
    expect(stdout).toEqual([
      `Type: transfer\nVersion: v0\nSender: ${transactionFixtures.sender}\nNonce: 1\nMax energy: 501\nAmount: 1\nTo: ${transactionFixtures.receiver}`,
    ]);
  });

  it('renders exact signing-handoff disclosure values with terminal controls escaped', async () => {
    const jsonOutput: string[] = [];
    expect(
      await runDescribeCommand({
        request: createDescribeCommandRequest({ input: transactionFixtures.credentialDeploymentSigningDisclosedHex }),
        stderr: [],
        stdout: jsonOutput,
      }),
    ).toBe(0);
    expect(JSON.parse(jsonOutput[0]!)).toMatchObject({
      credential: { revealedAttributes: { firstName: 'Ada\n' } },
    });

    const textOutput: string[] = [];
    expect(
      await runDescribeCommand({
        request: createDescribeCommandRequest({
          input: transactionFixtures.credentialDeploymentSigningDisclosedHex,
          output: 'text',
        }),
        stderr: [],
        stdout: textOutput,
      }),
    ).toBe(0);
    expect(textOutput[0]).toContain('Revealed attribute firstName: "Ada\\n"');
    expect(textOutput[0]).not.toContain('Ada\n');
  });

  it('reads transaction input from a file', async () => {
    const directory = makeTestTempDir('ccd-signer-');
    tempDirs.push(directory);
    const filePath = join(directory, 'transaction.hex');
    await writeFile(filePath, transactionFixtures.unsignedTransferWithMemoHex, 'utf8');

    const stdout: string[] = [];

    const exitCode = await runDescribeCommand({
      request: createDescribeCommandRequest({ inputFile: filePath }),
      stderr: [],
      stdout,
    });

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout[0]!)).toMatchObject({ payloadType: 'transferWithMemo' });
  });

  it('reads transaction input from stdin when requested', async () => {
    const stdout: string[] = [];

    const exitCode = await runDescribeCommand({
      request: createDescribeCommandRequest({ stdin: true }),
      stderr: [],
      stdin: transactionFixtures.v0HexString,
      stdout,
    });

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout[0]!)).toMatchObject({ payloadType: 'transfer' });
  });

  it('reads transaction input from process stdin when no test stdin is supplied', async () => {
    const originalDescriptor = Object.getOwnPropertyDescriptor(process, 'stdin');
    Object.defineProperty(process, 'stdin', {
      configurable: true,
      value: Readable.from([transactionFixtures.v0HexString]),
    });

    try {
      const stdout: string[] = [];
      const exitCode = await runDescribeCommand({
        request: createDescribeCommandRequest({ stdin: true }),
        stderr: [],
        stdout,
      });

      expect(exitCode).toBe(0);
      expect(JSON.parse(stdout[0]!)).toMatchObject({ payloadType: 'transfer' });
    } finally {
      if (originalDescriptor) {
        Object.defineProperty(process, 'stdin', originalDescriptor);
      }
    }
  });

  it('reports usage errors without throwing', async () => {
    const stderr: string[] = [];

    const exitCode = await runCliWithOutput(['describe'], {
      stderr,
      stdout: [],
    });

    expect(exitCode).toBe(2);
    expect(stderr).toEqual(['A single input source must be provided via --input, --input-file, or --stdin.']);
  });

  it('reports parse failures without throwing', async () => {
    const stderr: string[] = [];

    const exitCode = await runDescribeCommand({
      request: createDescribeCommandRequest({ input: 'not-a-transaction' }),
      stderr,
      stdout: [],
    });

    expect(exitCode).toBe(1);
    expect(stderr).toEqual(['Transaction input is not supported transaction hex.']);
  });
});
