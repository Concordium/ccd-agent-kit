import { describe, expect, it, beforeEach, vi } from 'vitest';
import { finalizeAccountTransactionHex } from '@ccd-agent-kit/sdk-utils';
import { verifyTransactionSignature } from '../../../../../src/mcp/transactions/internal/verifyTransactionSignatureTool.js';
import { FakeConcordiumClient, makeContext } from '../../../../helpers/fakes.js';
import { SENDER, SPONSOR, accountInfo } from '../../../../mcp/transactions/internal/helpers.js';

const V0_TRANSACTION =
  '0000c5e18b88e78169d247a036add33371305c55ed235bc188f1ba0a6114d034f4fa000000000000000500000000000001f50000002900000000d627737203fe7085b3203d75b36fbc76827343cd420786a865e0f0524b592f6a74f538d8d200000000000f4240';
const V1_TRANSACTION =
  '0300000001c5e18b88e78169d247a036add33371305c55ed235bc188f1ba0a6114d034f4fa0000000000000005000000000000027b0000002900000000d6277372fe7085b3203d75b36fbc76827343cd420786a865e0f0524b592f6a74f538d8d203fe7085b3203d75b36fbc76827343cd420786a865e0f0524b592f6a74f538d8d200000000000f4240';
const SIGNATURES = { sender: { 0: { 0: 'aa'.repeat(64) } }, sponsor: {} };

const collaborators = vi.hoisted(() => ({
  verificationInfo: vi.fn(),
  verifyV0: vi.fn<() => Promise<boolean>>(),
  verifyV1: vi.fn<() => Promise<boolean>>(),
}));

vi.mock('../../../../../src/mcp/accountCredentialsCache.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../../src/mcp/accountCredentialsCache.js')>();
  return { ...actual, getAccountVerificationInfoCacheFirst: collaborators.verificationInfo };
});

vi.mock('@concordium/web-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@concordium/web-sdk')>();
  return {
    ...actual,
    AccountTransactionV0: { ...actual.AccountTransactionV0, verifySignature: collaborators.verifyV0 },
    AccountTransactionV1: { ...actual.AccountTransactionV1, verifySignature: collaborators.verifyV1 },
  };
});

describe('verifyTransactionSignature', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    collaborators.verificationInfo.mockResolvedValue({
      info: accountInfo(SENDER, '11'.repeat(32)),
      source: 'cache',
    });
    collaborators.verifyV0.mockResolvedValue(true);
    collaborators.verifyV1.mockResolvedValue(true);
  });

  it('returns a valid v0 sender result from the cached collaborator result', async () => {
    await expect(verifyTransactionSignature(makeContext(new FakeConcordiumClient()), {
      transactionHex: V0_TRANSACTION,
      signatures: SIGNATURES,
    })).resolves.toEqual({
      valid: true,
      transactionVersion: 'v0',
      network: 'mainnet',
      sender: { address: SENDER, valid: true },
    });
    expect(collaborators.verificationInfo).toHaveBeenCalledTimes(1);
  });

  it('dispatches a representative signed block item through verification', async () => {
    const { blockItemHex } = finalizeAccountTransactionHex(V0_TRANSACTION, SIGNATURES);

    await expect(verifyTransactionSignature(makeContext(new FakeConcordiumClient()), {
      blockItemHex,
    })).resolves.toMatchObject({
      valid: true,
      transactionVersion: 'v0',
      sender: { address: SENDER, valid: true },
    });
    expect(collaborators.verifyV0).toHaveBeenCalledOnce();
  });

  it('refreshes exactly once after a cached verification rejection', async () => {
    collaborators.verifyV0.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    await expect(verifyTransactionSignature(makeContext(new FakeConcordiumClient()), {
      transactionHex: V0_TRANSACTION,
      signatures: SIGNATURES,
    })).resolves.toMatchObject({ valid: true, sender: { valid: true } });
    expect(collaborators.verificationInfo).toHaveBeenNthCalledWith(2, expect.anything(), 'mainnet', SENDER, undefined, true);
    expect(collaborators.verifyV0).toHaveBeenCalledTimes(2);
  });

  it('does not refresh a chain-sourced verification rejection', async () => {
    collaborators.verificationInfo.mockResolvedValue({
      info: accountInfo(SENDER, '11'.repeat(32)),
      source: 'chain',
    });
    collaborators.verifyV0.mockResolvedValue(false);

    await expect(verifyTransactionSignature(makeContext(new FakeConcordiumClient()), {
      transactionHex: V0_TRANSACTION,
      signatures: SIGNATURES,
      block: 'best',
    })).resolves.toMatchObject({ valid: false, sender: { valid: false } });
    expect(collaborators.verificationInfo).toHaveBeenCalledOnce();
    expect(collaborators.verificationInfo).toHaveBeenCalledWith(expect.anything(), 'mainnet', SENDER, { type: 'best' });
  });

  it('classifies sender and sponsor verification independently and preserves ordering', async () => {
    collaborators.verificationInfo
      .mockResolvedValueOnce({ info: accountInfo(SENDER, '11'.repeat(32)), source: 'chain' })
      .mockResolvedValueOnce({ info: accountInfo(SPONSOR, '22'.repeat(32)), source: 'chain' });
    collaborators.verifyV1.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    await expect(verifyTransactionSignature(makeContext(new FakeConcordiumClient()), {
      transactionHex: V1_TRANSACTION,
      signatures: { sender: SIGNATURES.sender, sponsor: { 0: { 0: 'bb'.repeat(64) } } },
    })).resolves.toEqual({
      valid: false,
      transactionVersion: 'v1',
      network: 'mainnet',
      sender: { address: SENDER, valid: true },
      sponsor: { address: SPONSOR, valid: false },
    });
    expect(collaborators.verificationInfo.mock.calls.map((call) => call[2])).toEqual([SENDER, SPONSOR]);
  });

  it('rejects sponsor signatures for v0 after reporting sender verification', async () => {
    await expect(verifyTransactionSignature(makeContext(new FakeConcordiumClient()), {
      transactionHex: V0_TRANSACTION,
      signatures: { sender: SIGNATURES.sender, sponsor: { 0: { 0: 'bb'.repeat(64) } } },
    })).rejects.toMatchObject({ kind: 'invalid-argument', message: expect.stringContaining('sponsor') });
  });
});
