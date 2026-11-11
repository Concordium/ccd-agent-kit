import { rmSync, writeFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createFinalizeCommandRequest, runFinalizeCommand } from '../../../src/cli/finalizeCommand.js';
import { runCliWithOutput } from '../../cli/runCliWithOutput.js';
import { makeTestTempDir } from '../../helpers/tempDir.js';
import { transactionFixtures } from '../../helpers/transactionFixtures.js';

const SENDER_REQUIREMENTS = JSON.stringify({ senderNumSignatures: '1', totalSignatureCount: '1' });
const SENDER_SIGNATURES = JSON.stringify({ sender: { 0: { 0: '22'.repeat(64) } }, sponsor: {} });

describe('runFinalizeCommand', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('finalizes a direct unsigned hex transaction input and prints JSON output', async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];

    const exitCode = await runFinalizeCommand({
      request: createFinalizeCommandRequest(finalizeInput({ signatures: SENDER_SIGNATURES })),
      stdout,
      stderr,
    });

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout.join('\n'))).toMatchObject({
      transactionVersion: 'v0',
      isFullySigned: true,
    });
    expect(stderr).toEqual([]);
  });

  it('finalizes unsigned hex input and prints block item hex as JSON', async () => {
    const stdout: string[] = [];

    const exitCode = await runFinalizeCommand({
      request: createFinalizeCommandRequest({
        input: transactionFixtures.sponsoredPltTransferTransactionHex,
        signatures: JSON.stringify({
          sender: { 0: { 0: '33'.repeat(64) } },
          sponsor: { 0: { 0: '44'.repeat(64) } },
        }),
        signatureRequirements: JSON.stringify({ senderNumSignatures: '1', sponsorNumSignatures: '1', totalSignatureCount: '2' }),
      }),
      stdout,
      stderr: [],
    });

    expect(exitCode).toBe(0);
    const output = JSON.parse(stdout.join('\n')) as {
      blockItemHex: string;
      transactionVersion: string;
    };
    expect(output.transactionVersion).toBe('v1');
    expect(output.blockItemHex).toMatch(/^[0-9a-f]+$/);
  });

  it('returns usage errors for missing inputs and signatures', async () => {
    const stderr: string[] = [];

    const exitCode = await runCliWithOutput(['finalize', '--signature-requirements', SENDER_REQUIREMENTS], { stdout: [], stderr });

    expect(exitCode).toBe(2);
    expect(stderr.join('\n')).toContain('A single input source must be provided');
  });

  it('reports finalization errors without throwing', async () => {
    const stderr: string[] = [];

    const exitCode = await runFinalizeCommand({
      request: createFinalizeCommandRequest(finalizeInput({ signatures: JSON.stringify({ sender: {}, sponsor: {} }) })),
      stdout: [],
      stderr,
    });

    expect(exitCode).toBe(1);
    expect(stderr.join('\n')).toContain('Transaction is not fully signed.');
  });

  it('supports file-based inputs and signatures files', async () => {
    const dir = makeTestTempDir('finalize-command-test-');
    tempDirs.push(dir);
    const txPath = join(dir, 'tx.hex');
    const sigPath = join(dir, 'sigs.json');
    writeFileSync(txPath, transactionFixtures.unsignedTransferWithMemoHex, 'utf8');
    writeFileSync(sigPath, SENDER_SIGNATURES, 'utf8');

    const stdout: string[] = [];
    const exitCode = await runFinalizeCommand({
      request: createFinalizeCommandRequest({ inputFile: txPath, signaturesFile: sigPath, signatureRequirements: SENDER_REQUIREMENTS }),
      stdout,
      stderr: [],
    });

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout.join('\n')).blockItemHex).toMatch(/^[0-9a-f]+$/);
  });

  it('supports stdin input when requested', async () => {
    const stdout: string[] = [];
    const exitCode = await runFinalizeCommand({
      request: createFinalizeCommandRequest({ stdin: true, signatures: SENDER_SIGNATURES, signatureRequirements: SENDER_REQUIREMENTS }),
      stdin: transactionFixtures.unsignedTransferWithMemoHex,
      stdout,
      stderr: [],
    });

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout.join('\n')).blockItemHex).toMatch(/^[0-9a-f]+$/);
  });

  it('reads transaction input from process.stdin when no explicit stdin option is provided', async () => {
    const originalDescriptor = Object.getOwnPropertyDescriptor(process, 'stdin');
    const fakeStdin = Readable.from([transactionFixtures.unsignedTransferWithMemoHex]);
    Object.defineProperty(process, 'stdin', {
      configurable: true,
      value: fakeStdin,
    });

    try {
      const stdout: string[] = [];
      const exitCode = await runFinalizeCommand({
        request: createFinalizeCommandRequest({ stdin: true, signatures: SENDER_SIGNATURES, signatureRequirements: SENDER_REQUIREMENTS }),
        stdout,
        stderr: [],
      });

      expect(exitCode).toBe(0);
      expect(JSON.parse(stdout.join('\n')).blockItemHex).toMatch(/^[0-9a-f]+$/);
    } finally {
      if (originalDescriptor) {
        Object.defineProperty(process, 'stdin', originalDescriptor);
      }
    }
  });

  it('returns usage errors for conflicting sources, unknown args, and malformed JSON', async () => {
    const stderrConflict: string[] = [];
    const stderrUnknown: string[] = [];
    const stderrMalformed: string[] = [];

    const conflict = await runCliWithOutput([...finalizeArgs('--signatures', JSON.stringify({ sender: {}, sponsor: {} })), '--stdin'], {
      stdout: [],
      stderr: stderrConflict,
    });
    const unknown = await runCliWithOutput(['finalize', '--bogus', '--signature-requirements', SENDER_REQUIREMENTS], {
      stdout: [],
      stderr: stderrUnknown,
    });
    const malformed = await runCliWithOutput(finalizeArgs('--signatures', '{bad'), {
      stdout: [],
      stderr: stderrMalformed,
    });
    const missingRequirements = await runCliWithOutput(finalizeArgs('--signatures', SENDER_SIGNATURES).slice(0, -2), { stdout: [], stderr: [] });
    const malformedRequirements = await runCliWithOutput(['finalize', '--input', transactionFixtures.unsignedTransferWithMemoHex, '--signatures', JSON.stringify({ sender: {}, sponsor: {} }), '--signature-requirements', '{bad'], { stdout: [], stderr: [] });

    expect(conflict).toBe(2);
    expect(stderrConflict.join('\n')).toContain('A single input source must be provided');
    expect(unknown).toBe(2);
    expect(stderrUnknown.join('\n')).toContain("unknown option '--bogus'");
    expect(malformed).toBe(2);
    expect(stderrMalformed.join('\n')).toContain('Detached signatures must be valid JSON');
    expect(missingRequirements).toBe(2);
    expect(malformedRequirements).toBe(2);
  });

});

function finalizeInput(overrides: Parameters<typeof createFinalizeCommandRequest>[0]): Parameters<typeof createFinalizeCommandRequest>[0] {
  return { input: transactionFixtures.unsignedTransferWithMemoHex, signatureRequirements: SENDER_REQUIREMENTS, ...overrides };
}

function finalizeArgs(...overrides: string[]): string[] {
  return ['finalize', '--input', transactionFixtures.unsignedTransferWithMemoHex, ...overrides, '--signature-requirements', SENDER_REQUIREMENTS];
}
