import { describe,expect,it,vi } from 'vitest';

import { deriveCredentialRegistrationId } from '../../src/core/identityMaterial.js';
import { createIdentityProofService } from '../../src/core/identityProofs.js';
import { identityContextHash } from '../../src/core/identityWorkflow.js';
import {
context,
ID_CRED_PUB,
IDENTITY_ID,
identityObject,NETWORK,selection,SOURCE_ID,
} from '../workflowFixtures.js';

const SEED = Buffer.alloc(64, 7);

function request(firstName = 'Ada'): Record<string, unknown> {
  return {
    type: 'ConcordiumVerificationRequestV1',
    context: { type: 'ConcordiumUnfilledContextInformationV1', given: [], requested: ['BlockHash'] },
    subjectClaims: [{
      type: 'identity', source: ['accountCredential'],
      statements: [{ type: 'AttributeInSet', attributeTag: 'firstName', set: [firstName] }],
      issuers: ['did:ccd:testnet:idp:7'],
    }],
    transactionRef: 'ab'.repeat(32),
  };
}

function fixture() {
  const issuerContext = context();
  const record = {
    version: 1 as const, id: IDENTITY_ID, sourceId: SOURCE_ID, selection: selection(), label: '@identity',
    contextHash: identityContextHash(issuerContext), idCredPub: ID_CRED_PUB, status: 'ready' as const,
  };
  const credentialId = deriveCredentialRegistrationId({
    seed: SEED, network: 'Testnet', identityProviderIndex: 7, identityIndex: 2, credentialIndex: 4,
    onChainCommitmentKey: issuerContext.globalContext.onChainCommitmentKey,
  });
  const loadFinalizedCredentials = vi.fn(async () => { throw new Error('finder must not use the network'); });
  const deps = {
    resolveNetwork: vi.fn(() => ({ caip2: NETWORK, sdkNetwork: 'Testnet' as const })),
    listRecords: vi.fn(async () => [record]),
    loadIdentity: vi.fn(async () => identityObject()),
    loadLocalContext: vi.fn(async () => issuerContext),
    loadGenerationContext: vi.fn(async () => issuerContext),
    verifyAnchor: vi.fn(),
    loadFinalizedCredentials,
    loadCredentialRegistry: vi.fn(async () => ({ version: 1 as const, credentials: {
      [credentialId]: { identityId: IDENTITY_ID, credentialNumber: 4, status: 'confirmed' as const },
    } })),
    listCachedCredentials: vi.fn(async () => [{
      account: '4abc', label: 'primary', credentialIndex: 3, credentialId,
    }]),
    withMaterial: vi.fn(async (_record, callback) => callback({
      seed: Buffer.from(SEED), storageKey: Buffer.alloc(32),
      material: { idCredSec: Buffer.alloc(32), prfKey: Buffer.alloc(32), signatureBlindingRandomness: Buffer.alloc(32) },
    })),
  };
  return { credentialId, deps, service: createIdentityProofService(deps as never) };
}

describe('account proof candidate discovery', () => {
  it('returns a concrete cached account credential using only local cache, ledger, and identity attributes', async () => {
    const { deps, service } = fixture();
    await expect(service.findCandidates({ request: request() })).resolves.toEqual({
      network: NETWORK,
      candidates: [{ subject: { type: 'account', account: '4abc', credentialIndex: 3 } }],
    });
    expect(deps.loadFinalizedCredentials).not.toHaveBeenCalled();
    expect(deps.verifyAnchor).not.toHaveBeenCalled();
  });

  it('omits an account credential whose local identity attributes do not satisfy every predicate', async () => {
    const { deps, service } = fixture();
    await expect(service.findCandidates({ request: request('Grace') })).resolves.toEqual({
      network: NETWORK, candidates: [],
    });
    expect(deps.loadFinalizedCredentials).not.toHaveBeenCalled();
  });

  it.each(['missing', 'pending', 'wrong_identity', 'wrong_credential_number'] as const)(
    'omits a cached credential with a %s ledger mapping', async failure => {
      const { credentialId, deps, service } = fixture();
      if (failure === 'missing') deps.loadCredentialRegistry.mockResolvedValueOnce({ version: 1, credentials: {} });
      if (failure === 'pending') deps.loadCredentialRegistry.mockResolvedValueOnce({ version: 1, credentials: {
        [credentialId]: { identityId: IDENTITY_ID, credentialNumber: 4, status: 'pending',
          expectedAccountAddress: '4abc', expirySeconds: 2_000_000_000 },
      } } as never);
      if (failure === 'wrong_identity') deps.loadCredentialRegistry.mockResolvedValueOnce({ version: 1, credentials: {
        [credentialId]: { identityId: '11'.repeat(32), credentialNumber: 4, status: 'confirmed' },
      } });
      if (failure === 'wrong_credential_number') deps.loadCredentialRegistry.mockResolvedValueOnce({ version: 1, credentials: {
        [credentialId]: { identityId: IDENTITY_ID, credentialNumber: 5, status: 'confirmed' },
      } });

      await expect(service.findCandidates({ request: request() })).resolves.toEqual({
        network: NETWORK, candidates: [],
      });
      expect(deps.loadFinalizedCredentials).not.toHaveBeenCalled();
    },
  );

  it('fails safely on malformed cached credential data without network access', async () => {
    const { deps, service } = fixture();
    deps.listCachedCredentials.mockResolvedValueOnce([{
      account: '4abc', credentialIndex: 3, credentialId: 'not-a-registration-id',
    }] as never);
    await expect(service.findCandidates({ request: request() })).resolves.toEqual({
      network: NETWORK, candidates: [],
    });
    expect(deps.loadFinalizedCredentials).not.toHaveBeenCalled();
  });

  it('omits an ambiguously duplicated cached credential registration ID', async () => {
    const { credentialId, deps, service } = fixture();
    deps.listCachedCredentials.mockResolvedValueOnce([
      { account: '4abc', credentialIndex: 3, credentialId, label: 'ignored' },
      { account: '4alias', credentialIndex: 3, credentialId, label: 'also-ignored' },
    ]);
    await expect(service.findCandidates({ request: request() })).resolves.toEqual({
      network: NETWORK, candidates: [],
    });
    expect(deps.loadFinalizedCredentials).not.toHaveBeenCalled();
  });
});
