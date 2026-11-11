import { describe, expect, it, vi } from 'vitest';
import { completeAccountOpeningHandler, completeTransactionHandler } from '../../../../src/mcp/submissions/handlers.js';
import { FakeConcordiumClient, makeContext } from '../../../helpers/fakes.js';

const collaborators = vi.hoisted(() => ({ finalizeCredential: vi.fn() }));

vi.mock('@ccd-agent-kit/sdk-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ccd-agent-kit/sdk-utils')>();
  collaborators.finalizeCredential.mockImplementation(
    (credDeploymentHex: string, signatures: Parameters<typeof actual.finalizeCredentialDeploymentHex>[1]) => {
      if (credDeploymentHex === '00decafbad') throw new Error('private-credential-finalizer-sentinel');
      return actual.finalizeCredentialDeploymentHex(credDeploymentHex, signatures);
    },
  );
  return {
    ...actual,
    parseUnsignedAccountTransactionHex: (transactionHex: string) => {
      if (transactionHex === 'c0ffee') throw new Error('private-account-parser-sentinel');
      return actual.parseUnsignedAccountTransactionHex(transactionHex);
    },
    finalizeCredentialDeploymentHex: collaborators.finalizeCredential,
  };
});

describe('completeTransactionHandler', () => {
  it('returns the public invalid-argument error for conflicting submit options', async () => {
    const result = await completeTransactionHandler(makeContext(new FakeConcordiumClient()), {
      transactionHex: '00ff',
      submit: true,
      finalize: false,
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      error: {
        kind: 'invalid-argument',
        message: 'submit true requires finalization; finalize cannot be false.',
      },
    });
  });

  it('returns invalid-argument when completion input is absent', async () => {
    const result = await completeTransactionHandler(makeContext(new FakeConcordiumClient()), { submit: true });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ error: { kind: 'invalid-argument' } });
  });

  it('translates malformed unsigned account bytes without exposing parser details', async () => {
    const result = await completeTransactionHandler(makeContext(new FakeConcordiumClient()), {
      transactionHex: 'c0ffee',
      signatures: { sender: {}, sponsor: {} },
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      error: {
        kind: 'invalid-argument',
        message: 'transactionHex is not a valid unsigned account transaction.',
      },
    });
    expect(JSON.stringify(result)).not.toContain('private-account-parser-sentinel');
  });

  it('translates malformed credential handoffs without exposing finalizer details', async () => {
    const result = await completeAccountOpeningHandler(makeContext(new FakeConcordiumClient()), {
      credDeploymentHex: '00decafbad',
      signatures: { 0: '11'.repeat(64) },
    });

    expect(collaborators.finalizeCredential).toHaveBeenCalledWith('00decafbad', { '0': '11'.repeat(64) });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      error: {
        kind: 'invalid-argument',
        message: 'Account-opening credential handoff could not be finalized.',
      },
    });
    expect(JSON.stringify(result)).not.toContain('private-credential-finalizer-sentinel');
  });
});
