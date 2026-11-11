import { beforeEach, describe, expect, it, vi } from 'vitest';

import { parseTransaction } from '../../../../src/core/parser/parseTransaction.js';
import type { ParsedTransaction } from '../../../../src/core/model/parsedTransaction.js';
import { finalizeTransaction } from '../../../../src/core/sign/finalizeTransaction.js';
import {
  ManagedTransactionSigningError,
  signManagedTransaction,
  type ManagedTransactionSigningResult,
} from '../../../../src/core/sign/managedTransactionSigning.js';
import { annotateParsedTransactionAccounts } from '../../../../src/mcp/annotateParsedTransaction.js';
import { executeSignTransactionTool } from '../../../../src/mcp/tools/signTransactionTool.js';

vi.mock('../../../../src/core/sign/managedTransactionSigning.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../src/core/sign/managedTransactionSigning.js')>()),
  signManagedTransaction: vi.fn(),
}));
vi.mock('../../../../src/core/sign/finalizeTransaction.js', () => ({ finalizeTransaction: vi.fn() }));
vi.mock('../../../../src/core/parser/parseTransaction.js', () => ({ parseTransaction: vi.fn() }));
vi.mock('../../../../src/mcp/annotateParsedTransaction.js', () => ({ annotateParsedTransactionAccounts: vi.fn() }));

const signature = '11'.repeat(64);
const parsedTransaction = {
  kind: 'accountTransaction', version: 0, payloadType: 'transfer',
  payloadSummary: { kind: 'transfer', amount: '1', toAddress: 'recipient' },
  header: { sender: 'sender', nonce: 1n, expiry: 42, energy: 2n },
  signatureState: { senderSignatureCount: 0, sponsorSignatureCount: 0 },
} satisfies ParsedTransaction;
const signed = {
  address: 'account-address',
  label: 'alice',
  network: 'mainnet',
  networkCaip2Ref: 'mainnet-ref',
  transaction: 'core-reflected-input',
  roleSigned: 'sender' as const,
  newSignature: { 0: { 0: signature } },
  signatures: { sender: { 0: { 0: signature } }, sponsor: {} },
  isFullySigned: true,
  signatureRequirementsKnown: true,
  missingSignatures: { sender: 0, sponsor: 0 },
} satisfies ManagedTransactionSigningResult;

describe('executeSignTransactionTool', () => {
  beforeEach(() => {
    vi.mocked(signManagedTransaction).mockReset().mockResolvedValue(signed);
    vi.mocked(finalizeTransaction).mockReset().mockReturnValue({
      transactionVersion: 'v0', blockItemHex: 'beef', isFullySigned: true, signatures: signed.signatures,
    });
    vi.mocked(parseTransaction).mockReset().mockReturnValue(parsedTransaction);
    vi.mocked(annotateParsedTransactionAccounts).mockReset().mockReturnValue({ kind: 'annotated', nonce: 1n });
  });

  it('forwards signing controls and merges existing signature sets', async () => {
    const senderSignature = '22'.repeat(64);
    const sponsorSignature = '33'.repeat(64);

    await executeSignTransactionTool({
      transactionHex: 'aabb', role: 'sponsor', keys: ['0:1'], maxSignatures: 2, network: 'testnet',
      signatureRequirements: { senderNumSignatures: '1', sponsorNumSignatures: '1', totalSignatureCount: '2' },
      signatures: [
        { sender: { 0: { 1: senderSignature } }, sponsor: {} },
        { sender: {}, sponsor: { 2: { 3: sponsorSignature } } },
      ],
    });

    expect(signManagedTransaction).toHaveBeenCalledWith({
      transactionHex: 'aabb', role: 'sponsor', keys: ['0:1'], maxSignatures: 2, network: 'testnet',
      signatureRequirements: { senderNumSignatures: '1', sponsorNumSignatures: '1', totalSignatureCount: '2' },
      signatures: {
        sender: { 0: { 1: senderSignature } },
        sponsor: { 2: { 3: sponsorSignature } },
      },
      yubiKeyService: undefined,
    });
  });

  it('includes requested debug fields and finalization output', async () => {
    const requirements = { senderNumSignatures: '1', totalSignatureCount: '1' };
    const result = await executeSignTransactionTool({
      transactionHex: 'aabb', role: 'sender', describe: true, returnInput: true,
      signatureRequirements: requirements,
    });

    expect(finalizeTransaction).toHaveBeenCalledWith({
      transactionHex: 'aabb', signatureRequirements: requirements, signatures: signed.signatures,
    });
    expect(parseTransaction).toHaveBeenCalledWith('aabb', { format: 'hex' });
    expect(annotateParsedTransactionAccounts).toHaveBeenCalledWith(
      parsedTransaction, { caip2Ref: 'mainnet-ref' },
    );
    expect(result.structuredContent).toMatchObject({
      label: 'alice', transaction: 'aabb', parsedTransaction: { kind: 'annotated', nonce: '1' }, transactionVersion: 'v0', blockItemHex: 'beef',
    });
  });

  it('omits reflected, parsed, and finalized fields unless requested', async () => {
    const result = await executeSignTransactionTool({ transactionHex: 'aabb', role: 'sender', finalize: false });

    expect(result.structuredContent).not.toHaveProperty('transaction');
    expect(result.structuredContent).not.toHaveProperty('parsedTransaction');
    expect(result.structuredContent).not.toHaveProperty('blockItemHex');
    expect(finalizeTransaction).not.toHaveBeenCalled();
    expect(parseTransaction).not.toHaveBeenCalled();
  });

  it('preserves structured managed-signing errors', async () => {
    vi.mocked(signManagedTransaction).mockRejectedValue(
      new ManagedTransactionSigningError('account_not_managed', 'Refresh finalized account credentials.'),
    );

    const result = await executeSignTransactionTool({ transactionHex: 'aabb', role: 'sender' });

    expect(result).toEqual({
      content: [{ type: 'text', text: 'Refresh finalized account credentials.' }], isError: true,
    });
  });

  it('translates and sanitizes unexpected failures', async () => {
    vi.mocked(signManagedTransaction).mockRejectedValue(new Error("read '/Users/alice/key.json'"));

    const result = await executeSignTransactionTool({ transactionHex: 'aabb', role: 'sender' });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe("Signing failed: read '[redacted local path]'");
  });
});
