import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  completeAccountOpening,
  completeAccountOpeningArgsSchema,
} from '../../../../src/mcp/submissions/completeAccountOpeningTool.js';
import { FakeConcordiumClient, makeContext } from '../../../helpers/fakes.js';

const SIGNATURE = 'aa'.repeat(64);
const BLOCK_ITEM = 'beef';

const collaborators = vi.hoisted(() => ({
  assembleCredential: vi.fn(),
  finalizeCredential: vi.fn(),
}));

vi.mock('@ccd-agent-kit/sdk-utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ccd-agent-kit/sdk-utils')>()),
  assembleSignedCredentialDeployment: collaborators.assembleCredential,
  finalizeCredentialDeploymentHex: collaborators.finalizeCredential,
}));

describe('completeAccountOpening', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    collaborators.assembleCredential.mockResolvedValue({ proofs: 'aa' });
    collaborators.finalizeCredential.mockResolvedValue({
      blockItemHex: BLOCK_ITEM,
      blockItemKind: 'credentialDeployment',
      messageExpiry: '1',
      signatures: { 0: SIGNATURE },
    });
  });

  it('uses only credDeploymentHex and flat signatures for account-opening completion', async () => {
    await expect(
      completeAccountOpening(makeContext(new FakeConcordiumClient()), {
        credDeploymentHex: '00cafe',
        signatures: { 0: SIGNATURE.toUpperCase() },
      }),
    ).resolves.toMatchObject({
      blockItemHex: BLOCK_ITEM,
      blockItemKind: 'credentialDeployment',
      submitted: false,
      signatures: { '0': SIGNATURE },
    });
    expect(collaborators.finalizeCredential).toHaveBeenCalledWith('00cafe', { '0': SIGNATURE });
  });

  it('submits only after successful finalization and honors returnInput', async () => {
    const transactionHash = '22'.repeat(32);
    const client = new FakeConcordiumClient({ submittedBlockItems: { [BLOCK_ITEM]: transactionHash } });

    await expect(
      completeAccountOpening(makeContext(client), {
        credDeploymentHex: '00cafe',
        signatures: { 0: SIGNATURE },
        submit: true,
        returnInput: true,
      }),
    ).resolves.toMatchObject({
      blockItemHex: BLOCK_ITEM,
      submitted: true,
      transactionHash,
      network: 'mainnet',
    });
  });

  it('does not return block-item bytes after submission unless returnInput is true', async () => {
    const transactionHash = '22'.repeat(32);
    const client = new FakeConcordiumClient({ submittedBlockItems: { [BLOCK_ITEM]: transactionHash } });

    const result = await completeAccountOpening(makeContext(client), {
      credDeploymentHex: '00cafe',
      signatures: { 0: SIGNATURE },
      submit: true,
      returnInput: false,
    });

    expect(result).toMatchObject({ submitted: true, transactionHash });
    expect(result).not.toHaveProperty('blockItemHex');
  });

  it('rejects submission when finalization is disabled', () => {
    expect(
      completeAccountOpeningArgsSchema.safeParse({
        credDeploymentHex: 'cafe',
        signatures: { 0: SIGNATURE },
        submit: true,
        finalize: false,
      }).success,
    ).toBe(false);
  });

  it('guards direct callers from submitting without finalization', async () => {
    await expect(
      completeAccountOpening(makeContext(new FakeConcordiumClient()), {
        credDeploymentHex: '00cafe',
        signatures: { 0: SIGNATURE },
        submit: true,
        finalize: false,
      }),
    ).rejects.toMatchObject({ kind: 'invalid-argument' });
    expect(collaborators.assembleCredential).not.toHaveBeenCalled();
    expect(collaborators.finalizeCredential).not.toHaveBeenCalled();
  });

  it('rejects a direct caller handoff that is not an account-opening target', async () => {
    await expect(
      completeAccountOpening(makeContext(new FakeConcordiumClient()), {
        credDeploymentHex: '01cafe',
        signatures: { 0: SIGNATURE },
      }),
    ).rejects.toMatchObject({ kind: 'invalid-argument' });
    expect(collaborators.finalizeCredential).not.toHaveBeenCalled();
  });

  it('verifies but does not create block-item bytes when finalization is disabled', async () => {
    const result = await completeAccountOpening(makeContext(new FakeConcordiumClient()), {
      credDeploymentHex: '00cafe',
      signatures: { 0: SIGNATURE },
      finalize: false,
    });
    expect(collaborators.assembleCredential).toHaveBeenCalledWith('00cafe', { '0': SIGNATURE });
    expect(collaborators.finalizeCredential).not.toHaveBeenCalled();
    expect(result).toMatchObject({ submitted: false, signatures: { '0': SIGNATURE } });
    expect(result).not.toHaveProperty('blockItemHex');
  });

  it.each([
    ['legacy transactionHex input', { transactionHex: 'cafe', signatures: { 0: SIGNATURE } }],
    ['role-separated signatures', { credDeploymentHex: 'cafe', signatures: { sender: {}, sponsor: {} } }],
    ['missing handoff', { signatures: { 0: SIGNATURE } }],
    ['noncanonical index', { credDeploymentHex: 'cafe', signatures: { '00': SIGNATURE } }],
    ['out-of-range index', { credDeploymentHex: 'cafe', signatures: { 256: SIGNATURE } }],
  ])('rejects %s at the public schema', (_name, input) => {
    expect(completeAccountOpeningArgsSchema.safeParse(input).success).toBe(false);
  });

  it('sanitizes private finalizer failures', async () => {
    collaborators.finalizeCredential.mockRejectedValue(new Error('private cryptographic detail'));
    const error = await completeAccountOpening(makeContext(new FakeConcordiumClient()), {
      credDeploymentHex: '00cafe',
      signatures: { 0: SIGNATURE },
    }).catch((cause: unknown) => cause);

    expect(error).toMatchObject({ kind: 'invalid-argument' });
    expect(JSON.stringify(error)).not.toContain('private cryptographic detail');
    expect(collaborators.finalizeCredential).toHaveBeenCalledWith('00cafe', { '0': SIGNATURE });
  });

  it('sanitizes private verification failures when finalization is disabled', async () => {
    collaborators.assembleCredential.mockRejectedValue(new Error('private cryptographic detail'));
    await expect(
      completeAccountOpening(makeContext(new FakeConcordiumClient()), {
        credDeploymentHex: '00cafe',
        signatures: { 0: SIGNATURE },
        finalize: false,
      }),
    ).rejects.toMatchObject({ kind: 'invalid-argument' });
  });
});
