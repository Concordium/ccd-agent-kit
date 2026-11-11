import { RpcError } from '@concordium/web-sdk';
import { describe,expect,it,vi } from 'vitest';

import { deriveCredentialRegistrationId } from '../../src/core/identityMaterial.js';
import { createIdentityProofService,IdentityProofError } from '../../src/core/identityProofs.js';
import { identityContextHash } from '../../src/core/identityWorkflow.js';
import { context,ID_CRED_PUB,IDENTITY_ID,identityObject,NETWORK,selection,SOURCE_ID } from '../workflowFixtures.js';

const BLOCK = 'cd'.repeat(32);
const SEED = Buffer.alloc(64, 9);

function request(): Record<string, unknown> {
  return {
    type: 'ConcordiumVerificationRequestV1',
    context: { type: 'ConcordiumUnfilledContextInformationV1', given: [], requested: ['BlockHash'] },
    subjectClaims: [{ type: 'identity', source: ['accountCredential'],
      statements: [{ type: 'AttributeInSet', attributeTag: 'firstName', set: ['Ada'] }],
      issuers: ['did:ccd:testnet:idp:7'] }], transactionRef: 'ab'.repeat(32),
  };
}

function fixture() {
  const issuerContext = context();
  const record = { version: 1 as const, id: IDENTITY_ID, sourceId: SOURCE_ID, selection: selection(),
    contextHash: identityContextHash(issuerContext), idCredPub: ID_CRED_PUB, status: 'ready' as const };
  const id = (credentialNumber: number) => deriveCredentialRegistrationId({ seed: SEED, network: 'Testnet',
    identityProviderIndex: 7, identityIndex: 2, credentialIndex: credentialNumber,
    onChainCommitmentKey: issuerContext.globalContext.onChainCommitmentKey });
  const lowId = id(4);
  const highId = id(5);
  const state = {
    account: '4abc', sourceBlock: { hash: BLOCK, time: '2026-10-18T10:00:00.000Z' },
    credentials: [
      { account: '4abc', credentialIndex: 2, credentialId: lowId, issuer: 7,
        commitments: { firstName: '11'.repeat(48) },
        policy: { createdAt: '202610', validTo: '203012', revealedAttributes: {} } },
      { account: '4abc', credentialIndex: 10, credentialId: highId, issuer: 7,
        commitments: { firstName: '22'.repeat(48) },
        policy: { createdAt: '202610', validTo: '203012', revealedAttributes: {} } },
    ],
    currentCredentials: [{ credentialIndex: 10, credentialId: highId }],
  };
  const deps = {
    resolveNetwork: () => ({ caip2: NETWORK, sdkNetwork: 'Testnet' as const }), listRecords: async () => [record],
    loadIdentity: async () => identityObject(), loadLocalContext: async () => issuerContext,
    loadGenerationContext: vi.fn(async (_selection, blockHash: string) => {
      expect(blockHash).toBe(BLOCK);
      return { ...issuerContext, sourceBlock: { hash: BLOCK, time: '2026-10-18T10:00:00.000Z' } };
    }),
    verifyAnchor: async () => ({ status: 'valid' as const, transactionHash: 'ab'.repeat(32), blockHash: BLOCK, account: '4anchor' }),
    listCachedCredentials: async () => [], loadFinalizedCredentials: vi.fn(async () => state),
    loadCredentialRegistry: vi.fn(async () => ({ version: 1 as const, credentials: {
      [lowId]: { identityId: IDENTITY_ID, credentialNumber: 4, status: 'confirmed' as const },
      [highId]: { identityId: IDENTITY_ID, credentialNumber: 5, status: 'confirmed' as const },
    } })),
    withMaterial: vi.fn(async (_record: unknown, callback: (scope: never) => Promise<unknown>) => callback({
      seed: Buffer.from(SEED), storageKey: Buffer.alloc(32),
      material: { idCredSec: Buffer.alloc(32), prfKey: Buffer.alloc(32), signatureBlindingRandomness: Buffer.alloc(32) },
    } as never)),
    createPresentation: vi.fn((proofRequest: unknown) => ({ proofRequest,
      toJSON: () => ({ type: ['VerifiablePresentation', 'ConcordiumVerifiablePresentationV1'] }) })),
    verifyPresentation: vi.fn((presentation: { proofRequest: unknown }) => ({ type: 'success' as const,
      result: presentation.proofRequest })),
  };
  return { deps, state, service: createIdentityProofService(deps as never) };
}

describe('account proof finalized state', () => {
  it('skips a lower removed credential and selects the lowest currently active eligible credential', async () => {
    const { deps, service } = fixture();
    await expect(service.createProof({ request: request(), subject: { type: 'account', account: '4abc' } }))
      .resolves.toHaveProperty('presentation');
    expect(deps.loadFinalizedCredentials).toHaveBeenCalledWith(NETWORK, '4abc', BLOCK);
    expect(deps.createPresentation).toHaveBeenCalledOnce();
  });

  it.each([
    ['wrong source block', (state: ReturnType<typeof fixture>['state']) => { state.sourceBlock.hash = 'ef'.repeat(32); }, 'NETWORK_FAILED'],
    ['credential replaced after anchor', (state: ReturnType<typeof fixture>['state']) => {
      state.currentCredentials = [{ credentialIndex: 10, credentialId: 'ef'.repeat(48) }];
    }, 'SUBJECT_INELIGIBLE'],
    ['credential removed after anchor', (state: ReturnType<typeof fixture>['state']) => {
      state.currentCredentials = [];
    }, 'SUBJECT_INELIGIBLE'],
    ['expired at anchor', (state: ReturnType<typeof fixture>['state']) => { state.credentials[1]!.policy.validTo = '202509'; }, 'SUBJECT_INELIGIBLE'],
    ['mismatched revealed value', (state: ReturnType<typeof fixture>['state']) => {
      state.credentials[1]!.policy.revealedAttributes = { firstName: 'Grace' };
    }, 'SUBJECT_INELIGIBLE'],
    ['missing commitment', (state: ReturnType<typeof fixture>['state']) => {
      state.credentials[1]!.commitments = {} as typeof state.credentials[number]['commitments'];
    }, 'SUBJECT_INELIGIBLE'],
  ] as const)('rejects %s', async (_label, mutate, code) => {
    const { state, service } = fixture(); mutate(state);
    await expect(service.createProof({ request: request(), subject: { type: 'account', account: '4abc', credentialIndex: 10 } }))
      .rejects.toMatchObject({ code });
  });

  it('does not use a credential added only after the anchor block', async () => {
    const { state, service } = fixture();
    state.credentials = state.credentials.filter(credential => credential.credentialIndex !== 10);
    await expect(service.createProof({ request: request(),
      subject: { type: 'account', account: '4abc', credentialIndex: 10 } }))
      .rejects.toMatchObject({ code: 'SUBJECT_INELIGIBLE' });
  });

  it.each([
    ['block hash', { hash: 'ef'.repeat(32), time: '2026-10-18T10:00:00.000Z' }],
    ['block time', { hash: BLOCK, time: '2026-10-18T10:00:01.000Z' }],
  ] as const)('rejects generation context with mismatched anchor %s provenance', async (_label, sourceBlock) => {
    const { deps, service } = fixture();
    deps.loadGenerationContext.mockResolvedValueOnce({ ...context(), sourceBlock });
    await expect(service.createProof({ request: request(),
      subject: { type: 'account', account: '4abc', credentialIndex: 10 } }))
      .rejects.toMatchObject({ code: 'NETWORK_FAILED' });
    expect(deps.loadGenerationContext).toHaveBeenCalledWith(expect.any(Object), BLOCK);
  });

  it('classifies credential-ledger read failure as storage rather than network', async () => {
    const { deps, service } = fixture();
    deps.loadCredentialRegistry.mockRejectedValueOnce(new Error('/protected/ledger'));
    await expect(service.createProof({ request: request(), subject: { type: 'account', account: '4abc' } }))
      .rejects.toMatchObject({ code: 'STORAGE_FAILED' });
  });

  it.each(['identity', 'account'] as const)(
    'classifies %s generation-context loading failure as network before material access', async subjectType => {
      const { deps, service } = fixture();
      deps.loadGenerationContext.mockRejectedValueOnce(new Error('historical block timeout /private/path'));
      const subject = subjectType === 'identity'
        ? { type: 'identity' as const, identityId: IDENTITY_ID }
        : { type: 'account' as const, account: '4abc', credentialIndex: 10 };
      await expect(service.createProof({ request: request(), subject }))
        .rejects.toMatchObject({ code: 'NETWORK_FAILED' });
      expect(deps.withMaterial).not.toHaveBeenCalled();
    },
  );

  it('preserves a deliberate proof error from the generation-context reader', async () => {
    const { deps, service } = fixture();
    deps.loadGenerationContext.mockRejectedValueOnce(new IdentityProofError('SUBJECT_UNAVAILABLE'));
    await expect(service.createProof({ request: request(),
      subject: { type: 'identity', identityId: IDENTITY_ID } }))
      .rejects.toMatchObject({ code: 'SUBJECT_UNAVAILABLE' });
    expect(deps.withMaterial).not.toHaveBeenCalled();
  });

  it('classifies historical-block RPC NOT_FOUND as network failure rather than an invalid anchor', async () => {
    const { deps, service } = fixture();
    deps.loadGenerationContext.mockRejectedValueOnce(new RpcError('missing historical block', 'NOT_FOUND'));
    await expect(service.createProof({ request: request(),
      subject: { type: 'identity', identityId: IDENTITY_ID } }))
      .rejects.toMatchObject({ code: 'NETWORK_FAILED' });
    expect(deps.withMaterial).not.toHaveBeenCalled();
  });
});
