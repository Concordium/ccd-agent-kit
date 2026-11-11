import { describe, expect, it, vi } from 'vitest';

import { IdentityProofError, type IdentityProofService } from '../../src/core/identityProofs.js';
import type { IdentitySourceService } from '../../src/core/sources/types.js';
import { identityProviderServiceFixture, TEST_CANONICAL_NETWORK } from '../helpers.js';
import { identityWorkflowFixture } from '../mcpTestHelpers.js';
import { captureIdentityMcpAdapter, tool, toolText } from './mcpAdapterHarness.js';

const REQUEST = { type: 'ConcordiumVerificationRequestV1' };
const IDENTITY_ID = '35'.repeat(32);

type ProofFixture = IdentityProofService & {
  validateRequest: ReturnType<typeof vi.fn<IdentityProofService['validateRequest']>>;
  findCandidates: ReturnType<typeof vi.fn<IdentityProofService['findCandidates']>>;
  createProof: ReturnType<typeof vi.fn<IdentityProofService['createProof']>>;
};

function proofs(): ProofFixture {
  return {
    validateRequest: vi.fn(async input => ({ network: input.network ?? TEST_CANONICAL_NETWORK.caip2 })),
    findCandidates: vi.fn(async () => ({ network: TEST_CANONICAL_NETWORK.caip2, candidates: [] })),
    createProof: vi.fn(async () => ({ network: TEST_CANONICAL_NETWORK.caip2, presentation: { proof: 'aabb' } })),
  };
}

function sources(): IdentitySourceService {
  return {
    resolve: vi.fn(), list: vi.fn(async () => []), records: vi.fn(async () => []),
    inspect: vi.fn(), createAgreement: vi.fn(), refresh: vi.fn(async () => undefined),
  };
}

async function capture(proofService?: IdentityProofService): Promise<void> {
  await captureIdentityMcpAdapter({
    workflow: identityWorkflowFixture(), sources: sources(), providers: identityProviderServiceFixture(),
    ...(proofService === undefined ? {} : { proofs: proofService }),
  });
}

describe('proof MCP adapter', () => {
  it('defaults describe to false and preserves an omitted network', async () => {
    const service = proofs();
    await capture(service);

    const response = await tool('validate_proof_request')({ request: REQUEST });

    expect(response.isError).not.toBe(true);
    expect(service.validateRequest).toHaveBeenCalledExactlyOnceWith({ request: REQUEST, describe: false });
  });

  it.each([
    ['find_proof_candidates', 'findCandidates'],
    ['create_identity_proof', 'createProof'],
  ] as const)('forwards optional network and subject fields through %s', async (toolName, method) => {
    const service = proofs();
    await capture(service);
    const subject = { type: 'account' as const, account: 'primary', credentialIndex: 0 };
    const input = toolName === 'create_identity_proof'
      ? { network: 'testnet', request: REQUEST, subject }
      : { network: 'testnet', request: REQUEST };

    const response = await tool(toolName)(input);

    expect(response.isError).not.toBe(true);
    expect(service[method]).toHaveBeenCalledExactlyOnceWith(input);
  });

  it('does not resolve identity labels in the adapter', async () => {
    const service = proofs();
    await capture(service);
    const subject = { type: 'identity' as const, identityId: 'agent' };

    await tool('create_identity_proof')({ request: REQUEST, subject });

    expect(service.createProof).toHaveBeenCalledExactlyOnceWith({ request: REQUEST, subject });
  });

  it('renders producer-owned proof errors and sanitizes unstructured failures', async () => {
    const service = proofs();
    service.validateRequest.mockRejectedValueOnce(new IdentityProofError('INVALID_REQUEST'));
    service.findCandidates.mockRejectedValueOnce(new Error('secret /Users/alice/private-state'));
    await capture(service);

    const classified = await tool('validate_proof_request')({ request: REQUEST });
    const unstructured = await tool('find_proof_candidates')({ request: REQUEST });

    expect(classified.isError).toBe(true);
    expect(toolText(classified)).toContain('malformed');
    expect(unstructured.isError).toBe(true);
    expect(toolText(unstructured)).not.toMatch(/secret|Users\/alice|private-state/);
  });

  it.each([
    ['validate_proof_request', { request: REQUEST }],
    ['find_proof_candidates', { request: REQUEST }],
    ['create_identity_proof', { request: REQUEST, subject: { type: 'identity', identityId: IDENTITY_ID } }],
  ] as const)('returns a safe error from %s when proof service is unavailable', async (name, input) => {
    await capture();

    const response = await tool(name)(input);

    expect(response.isError).toBe(true);
    expect(toolText(response)).not.toMatch(/Users\/|\.test-tmp|ccd-agent-kit/i);
  });
});
