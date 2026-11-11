import { describe, expect, it, beforeEach, vi } from 'vitest';
import {
  completeTransaction,
  completeTransactionArgsSchema,
  type CompleteTransactionArgs,
} from '../../../../../src/mcp/transactions/internal/completeTransactionTool.js';
import { FakeConcordiumClient, makeContext } from '../../../../helpers/fakes.js';
import { SENDER } from '../../../../mcp/transactions/internal/helpers.js';

const V0_TRANSACTION =
  '0000c5e18b88e78169d247a036add33371305c55ed235bc188f1ba0a6114d034f4fa000000000000000500000000000001f50000002900000000d627737203fe7085b3203d75b36fbc76827343cd420786a865e0f0524b592f6a74f538d8d200000000000f4240';
const SIGNATURE = 'aa'.repeat(64);
const SIGNED_V0_TRANSACTION = `00010001000040${SIGNATURE}${V0_TRANSACTION.slice(4)}`;
const BLOCK_ITEM = 'beef';

const collaborators = vi.hoisted(() => ({
  combine: vi.fn(),
  finalizeAccount: vi.fn<typeof import('@ccd-agent-kit/sdk-utils').finalizeParsedAccountTransaction>(),
}));

vi.mock('../../../../../src/mcp/transactions/internal/combineTransactionSignaturesTool.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../../src/mcp/transactions/internal/combineTransactionSignaturesTool.js')>();
  return { ...actual, combineParsedTransactionSignatures: collaborators.combine };
});

vi.mock('@ccd-agent-kit/sdk-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ccd-agent-kit/sdk-utils')>();
  return {
    ...actual,
    finalizeParsedAccountTransaction: collaborators.finalizeAccount,
  };
});

function combined(isFullySigned = true) {
  return {
    network: 'mainnet',
    transactionVersion: 'v0' as const,
    sender: SENDER,
    signatures: { sender: { 0: { 0: SIGNATURE } }, sponsor: {} },
    badSignatures: [],
    hasRejectedSignatures: false,
    acceptedSignatureCount: 1,
    rejectedSignatureCount: 0,
    missingSignatures: { sender: isFullySigned ? 0 : 1, sponsor: 0 },
    isFullySigned,
  };
}

describe('completeTransaction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    collaborators.combine.mockResolvedValue(combined());
    collaborators.finalizeAccount.mockReturnValue({
      transactionVersion: 'v0',
      blockItemHex: BLOCK_ITEM,
      signatures: { sender: { 0: { 0: SIGNATURE } }, sponsor: {} },
    });
  });

  it('combines signature-only input without verification and applies role defaults', async () => {
    const signatures = [
      { sender: { 0: { 0: SIGNATURE.toUpperCase() } }, sponsor: {} },
      { sender: {}, sponsor: { 1: { 0: 'bb'.repeat(64) } } },
    ];
    const original = structuredClone(signatures);

    await expect(completeTransaction(makeContext(new FakeConcordiumClient()), { signatures })).resolves.toEqual({
      signatures: { sender: { '0': { '0': SIGNATURE } }, sponsor: { '1': { '0': 'bb'.repeat(64) } } },
      submitted: false,
      verificationSkipped: true,
      skipReason: 'transactionHex not provided',
    });
    expect(signatures).toEqual(original);
    expect(collaborators.combine).not.toHaveBeenCalled();
  });

  it.each([
    [{}, 'transactionHex'],
    [{ transactionHex: BLOCK_ITEM, submit: true, finalize: false }, 'requires finalization'],
  ])('rejects invalid direct-call arguments before using collaborators', async (args, message) => {
    await expect(completeTransaction(
      makeContext(new FakeConcordiumClient()),
      args as CompleteTransactionArgs,
    )).rejects.toMatchObject({ kind: 'invalid-argument', message: expect.stringContaining(message) });
    expect(collaborators.combine).not.toHaveBeenCalled();
    expect(collaborators.finalizeAccount).not.toHaveBeenCalled();
  });

  it('does nothing for transaction-only input unless submission is explicit', async () => {
    const client = new FakeConcordiumClient({ submittedBlockItems: { [BLOCK_ITEM]: '11'.repeat(32) } });
    await expect(completeTransaction(makeContext(client), { transactionHex: BLOCK_ITEM })).resolves.toEqual({ submitted: false });
  });

  it('dispatches account signatures through combination and finalization with defaults', async () => {
    const result = await completeTransaction(makeContext(new FakeConcordiumClient()), {
      transactionHex: V0_TRANSACTION,
      signatures: { sender: { 0: { 0: SIGNATURE } }, sponsor: {} },
    });

    expect(collaborators.combine).toHaveBeenCalledOnce();
    expect(collaborators.finalizeAccount).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ blockItemHex: BLOCK_ITEM, submitted: false, isFullySigned: true });
  });

  it('does not finalize when finalize is false', async () => {
    const result = await completeTransaction(makeContext(new FakeConcordiumClient()), {
      transactionHex: V0_TRANSACTION,
      signatures: { sender: { 0: { 0: SIGNATURE } }, sponsor: {} },
      finalize: false,
    });

    expect(result).toMatchObject({ submitted: false, isFullySigned: true });
    expect(result).not.toHaveProperty('blockItemHex');
    expect(collaborators.finalizeAccount).not.toHaveBeenCalled();
  });

  it('rejects embedded account signatures instead of merging detached signatures', async () => {
    await expect(completeTransaction(makeContext(new FakeConcordiumClient()), {
      transactionHex: SIGNED_V0_TRANSACTION,
      signatures: { sender: { 0: { 0: SIGNATURE } }, sponsor: {} },
    })).rejects.toMatchObject({ kind: 'invalid-argument' });
    expect(collaborators.combine).not.toHaveBeenCalled();
    expect(collaborators.finalizeAccount).not.toHaveBeenCalled();
  });

  it('suppresses finalization and requested submission for incomplete signatures', async () => {
    collaborators.combine.mockResolvedValue(combined(false));
    const client = new FakeConcordiumClient();
    const result = await completeTransaction(makeContext(client), {
      transactionHex: V0_TRANSACTION,
      signatures: { sender: { 0: { 0: SIGNATURE } }, sponsor: {} },
      submit: true,
    });

    expect(result).toMatchObject({
      isFullySigned: false,
      submitted: false,
      submissionSkipped: true,
      skipReason: 'incomplete-signature-set',
    });
    expect(collaborators.finalizeAccount).not.toHaveBeenCalled();
  });

  it('submits finalized input only when submit is explicitly true and honors returnInput', async () => {
    const transactionHash = '22'.repeat(32);
    const client = new FakeConcordiumClient({ submittedBlockItems: { [BLOCK_ITEM]: transactionHash } });

    await expect(completeTransaction(makeContext(client), {
      transactionHex: BLOCK_ITEM,
      submit: true,
      returnInput: true,
    })).resolves.toEqual({
      blockItemHex: BLOCK_ITEM,
      submitted: true,
      transactionHash,
      network: 'mainnet',
    });
  });

  it('rejects incomplete, contradictory, and removed signature inputs at the schema boundary', () => {
    expect(completeTransactionArgsSchema.safeParse({}).success).toBe(false);
    expect(completeTransactionArgsSchema.safeParse({
      transactionHex: 'cafe',
      submit: true,
      finalize: false,
    }).success).toBe(false);
    expect(completeTransactionArgsSchema.safeParse({
      transactionHex: 'cafe',
      signatures: { 0: SIGNATURE },
    }).success).toBe(false);
  });

  it.each([
    { kind: 'invalid-argument', message: 'public invalid input' },
    { kind: 'node', code: 14, message: 'public node failure' },
    { kind: 'chain-capability', capability: 'protocol', network: 'mainnet', message: 'public capability failure' },
  ])('preserves a structured $kind producer error', async (producerError) => {
    collaborators.finalizeAccount.mockImplementation(() => { throw producerError; });

    await expect(completeTransaction(makeContext(new FakeConcordiumClient()), {
      transactionHex: V0_TRANSACTION,
      signatures: { sender: { 0: { 0: SIGNATURE } }, sponsor: {} },
    })).rejects.toEqual(producerError);
  });

  it('sanitizes an unknown private finalizer error', async () => {
    collaborators.finalizeAccount.mockImplementation(() => { throw new Error('private finalizer detail'); });

    await expect(completeTransaction(makeContext(new FakeConcordiumClient()), {
      transactionHex: V0_TRANSACTION,
      signatures: { sender: { 0: { 0: SIGNATURE } }, sponsor: {} },
    })).rejects.toEqual({
      kind: 'invalid-argument',
      message: 'Account transaction signatures could not be finalized.',
    });
  });
});
