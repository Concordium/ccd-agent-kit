import type { AccountCredentialObservation } from '@ccd-agent-kit/config-utils';
import { ed25519PublicKey } from '@ccd-agent-kit/sdk-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { combineTransactionSignatures } from '../../../../../src/mcp/transactions/internal/combineTransactionSignaturesTool.js';
import { FakeConcordiumClient, makeContext } from '../../../../helpers/fakes.js';
import { SENDER } from '../../../../mcp/transactions/internal/helpers.js';

const V0_TRANSACTION =
  '0000c5e18b88e78169d247a036add33371305c55ed235bc188f1ba0a6114d034f4fa000000000000000500000000000001f50000002900000000d627737203fe7085b3203d75b36fbc76827343cd420786a865e0f0524b592f6a74f538d8d200000000000f4240';
const VALID = 'aa'.repeat(64);
const OTHER_VALID = 'bb'.repeat(64);
const SIGNED_V0_TRANSACTION = `00010001000040${VALID}${V0_TRANSACTION.slice(4)}`;
const PUBLIC_KEY = ed25519PublicKey.require('11'.repeat(32));

const collaborators = vi.hoisted(() => ({
  getObservation: vi.fn<() => AccountCredentialObservation | undefined>(),
  setObservation: vi.fn(),
  verifySlot: vi.fn<typeof import('@ccd-agent-kit/sdk-utils').verifyAccountTransactionSignatureSlot>(),
}));

vi.mock('@ccd-agent-kit/config-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ccd-agent-kit/config-utils')>();
  return {
    ...actual,
    getAccountCredentialObservation: collaborators.getObservation,
    setAccountCredentialObservation: collaborators.setObservation,
  };
});

vi.mock('@ccd-agent-kit/sdk-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ccd-agent-kit/sdk-utils')>();
  return { ...actual, verifyAccountTransactionSignatureSlot: collaborators.verifySlot };
});

function observation(
  credentials: AccountCredentialObservation['credentials'] = {
    '0': { threshold: '1', keys: { '0': { scheme: 'Ed25519', publicKey: PUBLIC_KEY } } },
  },
  accountThreshold = '1',
): AccountCredentialObservation {
  return {
    accountThreshold,
    credentials,
    sourceBlock: { hash: '11'.repeat(32), height: '1', time: '2026-01-01T00:00:00.000Z' },
  };
}

describe('combineTransactionSignatures', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    collaborators.getObservation.mockReturnValue(observation());
    collaborators.verifySlot.mockResolvedValue(true);
  });

  it('normalizes candidates, removes duplicates, replaces a rejected candidate, and owns its result', async () => {
    collaborators.verifySlot.mockImplementation(async ({ signature }) => signature === VALID);
    const signatureSets = [
      { sender: { 0: { 0: OTHER_VALID } }, sponsor: {} },
      { sender: { 0: { 0: VALID.toUpperCase() } }, sponsor: {} },
      { sender: { 0: { 0: VALID } }, sponsor: {} },
    ];
    const original = structuredClone(signatureSets);

    const client = new FakeConcordiumClient({
      accountCredentialObservations: { [SENDER]: { canonicalAddress: SENDER, observation: observation() } },
    });
    const result = await combineTransactionSignatures(makeContext(client), {
      transactionHex: V0_TRANSACTION,
      signatureSets,
    });

    expect(result).toMatchObject({
      signatures: { sender: { '0': { '0': VALID } }, sponsor: {} },
      acceptedSignatureCount: 1,
      rejectedSignatureCount: 1,
      hasRejectedSignatures: true,
      isFullySigned: true,
      badSignatures: [{ reason: 'invalid-signature', sender: { '0': { '0': [OTHER_VALID] } } }],
    });
    result.signatures.sender[0]![0] = OTHER_VALID;
    expect(signatureSets).toEqual(original);
    expect(collaborators.verifySlot).toHaveBeenCalledTimes(3);
  });

  it('classifies malformed, unknown credential, unknown key, invalid, and unexpected sponsor candidates', async () => {
    collaborators.verifySlot.mockResolvedValue(false);
    const client = new FakeConcordiumClient({
      accountCredentialObservations: { [SENDER]: { canonicalAddress: SENDER, observation: observation() } },
    });
    const result = await combineTransactionSignatures(makeContext(client), {
      transactionHex: V0_TRANSACTION,
      signatureSets: [{
        sender: { 0: { 0: VALID, 1: OTHER_VALID, 2: '12' }, 9: { 0: VALID } },
        sponsor: { 0: { 0: VALID } },
      }],
    });

    expect(result.rejectedSignatureCount).toBe(5);
    expect(result.badSignatures.map(({ reason }) => reason)).toEqual([
      'invalid-signature',
      'unknown-key',
      'malformed-signature',
      'unknown-credential',
      'unexpected-sponsor-signature',
    ]);
  });

  it('reports the cheapest ordered credential deficits needed to reach the account threshold', async () => {
    collaborators.getObservation.mockReturnValue(observation({
      '0': { threshold: '1', keys: { '0': { scheme: 'Ed25519', publicKey: PUBLIC_KEY } } },
      '1': {
        threshold: '2',
        keys: {
          '0': { scheme: 'Ed25519', publicKey: PUBLIC_KEY },
          '1': { scheme: 'Ed25519', publicKey: PUBLIC_KEY },
        },
      },
      '2': {
        threshold: '3',
        keys: {
          '0': { scheme: 'Ed25519', publicKey: PUBLIC_KEY },
          '1': { scheme: 'Ed25519', publicKey: PUBLIC_KEY },
          '2': { scheme: 'Ed25519', publicKey: PUBLIC_KEY },
        },
      },
    }, '2'));

    await expect(combineTransactionSignatures(makeContext(new FakeConcordiumClient()), {
      transactionHex: V0_TRANSACTION,
      signatureSets: [{ sender: { 0: { 0: VALID } }, sponsor: {} }],
    })).resolves.toMatchObject({ isFullySigned: false, missingSignatures: { sender: 2, sponsor: 0 } });
  });

  it('uses a complete cache hit without a chain refresh', async () => {
    const client = new FakeConcordiumClient();
    await combineTransactionSignatures(makeContext(client), {
      transactionHex: V0_TRANSACTION,
      signatureSets: [{ sender: { 0: { 0: VALID } }, sponsor: {} }],
    });
    expect(client.calls.getFinalizedAccountCredentials ?? 0).toBe(0);
    expect(collaborators.setObservation).not.toHaveBeenCalled();
  });

  it('refreshes a cached observation once after rejection and persists the replacement', async () => {
    const stale = observation();
    const freshKey = ed25519PublicKey.require('22'.repeat(32));
    const fresh = observation({ '0': { threshold: '1', keys: { '0': { scheme: 'Ed25519', publicKey: freshKey } } } });
    collaborators.getObservation.mockReturnValue(stale);
    collaborators.verifySlot.mockImplementation(async ({ publicKey }) => publicKey === freshKey);
    const client = new FakeConcordiumClient({
      accountCredentialObservations: { [SENDER]: { canonicalAddress: SENDER, observation: fresh } },
    });

    await expect(combineTransactionSignatures(makeContext(client), {
      transactionHex: V0_TRANSACTION,
      signatureSets: [{ sender: { 0: { 0: VALID } }, sponsor: {} }],
    })).resolves.toMatchObject({ isFullySigned: true, rejectedSignatureCount: 0 });
    expect(client.calls.getFinalizedAccountCredentials).toBe(1);
    expect(collaborators.setObservation).toHaveBeenCalledOnce();
  });

  it('rejects two distinct candidates that both validate for one slot', async () => {
    await expect(combineTransactionSignatures(makeContext(new FakeConcordiumClient()), {
      transactionHex: V0_TRANSACTION,
      signatureSets: [
        { sender: { 0: { 0: VALID } }, sponsor: {} },
        { sender: { 0: { 0: OTHER_VALID } }, sponsor: {} },
      ],
    })).rejects.toMatchObject({ kind: 'invalid-argument' });
  });

  it('rejects an account block item with an embedded sender signature map', async () => {
    await expect(combineTransactionSignatures(makeContext(new FakeConcordiumClient()), {
      transactionHex: SIGNED_V0_TRANSACTION,
      signatureSets: [{ sender: { 0: { 0: VALID } }, sponsor: {} }],
    })).rejects.toMatchObject({ kind: 'invalid-argument' });
    expect(collaborators.verifySlot).not.toHaveBeenCalled();
  });
});
