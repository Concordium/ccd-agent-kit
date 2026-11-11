import { describe, expect, it, vi } from 'vitest';

import type { IdentityProofService } from '../../src/core/identityProofs.js';
import type { IdentitySourceService } from '../../src/core/sources/types.js';
import { buildIdentityMcpServer } from '../../src/mcp/server.js';
import { identityProviderServiceFixture, TEST_CANONICAL_NETWORK } from '../helpers.js';
import { identityWorkflowFixture, mcpResult, mcpText, rpc, withMcpTestClient } from '../mcpTestHelpers.js';

const REQUEST = { type: 'ConcordiumVerificationRequestV1' };

function sources(): IdentitySourceService {
  return {
    resolve: vi.fn(), list: vi.fn(async () => []), records: vi.fn(async () => []),
    inspect: vi.fn(), createAgreement: vi.fn(), refresh: vi.fn(async () => undefined),
  };
}

function proofs(): IdentityProofService {
  return {
    validateRequest: vi.fn(async () => ({ network: TEST_CANONICAL_NETWORK.caip2 })),
    findCandidates: vi.fn(async () => ({ network: TEST_CANONICAL_NETWORK.caip2, candidates: [] })),
    createProof: vi.fn(async () => ({ network: TEST_CANONICAL_NETWORK.caip2, presentation: { proof: 'aabb' } })),
  };
}

describe('identity proof MCP protocol', () => {
  it('advertises strict proof schemas and dispatches a proof tool', async () => {
    const proofService = proofs();
    const server = buildIdentityMcpServer(
      identityWorkflowFixture(), sources(), identityProviderServiceFixture(), undefined, proofService,
    );
    await withMcpTestClient(server, async client => {
      const listed = mcpResult(await rpc(client, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }));
      const serialized = JSON.stringify(listed.tools);
      expect(serialized).toContain('validate_proof_request');
      expect(serialized).toContain('create_identity_proof');
      expect(serialized).toContain('"additionalProperties":false');

      const called = mcpResult(await rpc(client, {
        jsonrpc: '2.0', id: 3, method: 'tools/call',
        params: { name: 'validate_proof_request', arguments: { request: REQUEST } },
      }));
      expect(mcpText(called)).toEqual({ network: TEST_CANONICAL_NETWORK.caip2 });
      expect(proofService.validateRequest).toHaveBeenCalledExactlyOnceWith({ request: REQUEST, describe: false });
    });
  });

  it('rejects schema-invalid proof input before collaborator effects', async () => {
    const proofService = proofs();
    const server = buildIdentityMcpServer(
      identityWorkflowFixture(), sources(), identityProviderServiceFixture(), undefined, proofService,
    );
    await withMcpTestClient(server, async client => {
      const response = await rpc(client, {
        jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: 'create_identity_proof', arguments: { request: REQUEST, subject: { type: 'identity' } } },
      });
      expect('error' in response || ('result' in response && mcpResult(response).isError === true)).toBe(true);
      expect(proofService.createProof).not.toHaveBeenCalled();
    });
  });
});
