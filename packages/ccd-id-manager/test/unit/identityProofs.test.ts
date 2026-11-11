import { readFileSync } from 'node:fs';
import { describe,expect,it,vi } from 'vitest';

import { deriveCredentialRegistrationId } from '../../src/core/identityMaterial.js';
import { createIdentityProofService,IdentityProofError } from '../../src/core/identityProofs.js';
import { IdentitySourceError } from '@ccd-agent-kit/config-utils';
import { IdentityWorkflowError } from '../../src/core/workflowErrors.js';
import { context,contextFingerprint,ID_CRED_PUB,IDENTITY_ID,identityObject,NETWORK,selection,SOURCE_ID } from '../workflowFixtures.js';

const TRANSACTION = 'ab'.repeat(32);
const BLOCK = 'cd'.repeat(32);
const BLOCK_TIME = '2026-10-16T00:00:00.000Z';
const PUBLIC_FIXTURE = JSON.parse(readFileSync(new URL('../publicProofFixture.json', import.meta.url), 'utf8')) as {
  testSeed: string;
  identity: { attributeList: ReturnType<typeof identityObject>['value']['attributeList'] };
  credential: { credId: string; commitments: { cmmAttributes: Record<string, string> } };
  globalContext: ReturnType<typeof context>['globalContext'];
};

function request(statements: Record<string, unknown>[] = [{
  type: 'AttributeInSet', attributeTag: 'firstName', set: ['Ada'],
}]): Record<string, unknown> {
  return {
    type: 'ConcordiumVerificationRequestV1',
    context: {
      type: 'ConcordiumUnfilledContextInformationV1',
      given: [
        { label: 'ContextString', context: '  exact verifier text  ' },
        { label: 'ResourceID', context: 'https://verifier.example/session' },
      ],
      requested: ['BlockHash'],
    },
    subjectClaims: [{
      type: 'identity', source: ['identityCredential', 'accountCredential'], statements,
      issuers: ['did:ccd:testnet:idp:7'],
    }],
    transactionRef: TRANSACTION,
  };
}

function fixture() {
  const issuerContext = context();
  const proofContext = { ...issuerContext, sourceBlock: { hash: BLOCK, time: BLOCK_TIME } };
  const record = {
    version: 1 as const, id: IDENTITY_ID, sourceId: SOURCE_ID, label: '@ada', selection: selection(),
    contextHash: contextFingerprint(issuerContext), idCredPub: ID_CRED_PUB, status: 'ready' as const,
  };
  const identity = identityObject();
  const deps = {
    resolveNetwork: vi.fn(() => ({ caip2: NETWORK, sdkNetwork: 'Testnet' as const })),
    listRecords: vi.fn(async () => [record]),
    loadIdentity: vi.fn(async () => identity),
    loadLocalContext: vi.fn(async (): Promise<typeof proofContext | undefined> => proofContext),
    loadGenerationContext: vi.fn(async (_selection, _blockHash: string) => proofContext),
    verifyAnchor: vi.fn(async () => ({
      status: 'valid' as const, transactionHash: TRANSACTION, blockHash: BLOCK, account: '4abc',
    })),
    loadCredentialRegistry: vi.fn(async () => ({ version: 1 as const, credentials: {} })),
    loadFinalizedCredentials: vi.fn(async () => ({
      account: '4abc', sourceBlock: { hash: BLOCK, time: BLOCK_TIME }, credentials: [], currentCredentials: [],
    })),
    listCachedCredentials: vi.fn(async (): Promise<Array<{
      account: string; credentialIndex: number; credentialId: string;
    }>> => []),
    withMaterial: vi.fn(async (_record, callback) => callback({
      seed: Buffer.alloc(64, 1),
      material: { idCredSec: Buffer.alloc(32, 2), prfKey: Buffer.alloc(32, 3), signatureBlindingRandomness: Buffer.alloc(32, 4) },
      storageKey: Buffer.alloc(32, 5),
    })),
    createPresentation: vi.fn((proofRequest: unknown) => ({
      proofRequest, toJSON: () => ({ type: ['VerifiablePresentation', 'ConcordiumVerifiablePresentationV1'] }),
    })),
    verifyPresentation: vi.fn((presentation: { proofRequest: unknown }) => ({
      type: 'success' as const, result: presentation.proofRequest,
    })),
  };
  return { deps, identity, issuerContext, proofContext, record, service: createIdentityProofService(deps as never) };
}

function configureAccount(
  h: ReturnType<typeof fixture>,
  { credentialIndex = 2, credentialNumber = 4, issuer = 7, commitments = { firstName: '99'.repeat(48) } }: {
    credentialIndex?: number; credentialNumber?: number; issuer?: number; commitments?: Record<string, string>;
  } = {},
) {
  const credentialId = deriveCredentialRegistrationId({
    seed: Buffer.alloc(64, 1), network: 'Testnet', identityProviderIndex: 7, identityIndex: 2,
    credentialIndex: credentialNumber, onChainCommitmentKey: h.issuerContext.globalContext.onChainCommitmentKey,
  });
  h.deps.loadCredentialRegistry.mockResolvedValueOnce({
    version: 1, credentials: { [credentialId]: { identityId: IDENTITY_ID, credentialNumber, status: 'confirmed' } },
  });
  const state = {
    account: '4abc', sourceBlock: { hash: BLOCK, time: BLOCK_TIME },
    credentials: [{ account: '4abc', credentialIndex, credentialId, issuer, commitments,
      policy: { createdAt: '202610', validTo: '203012', revealedAttributes: {} } }],
    currentCredentials: [{ credentialIndex, credentialId }],
  };
  h.deps.loadFinalizedCredentials.mockResolvedValueOnce(state as never);
  return { credentialId, state };
}

describe('identity proof core', () => {
  it('strictly parses a request and returns exact structured review data', async () => {
    const { service } = fixture();
    await expect(service.validateRequest({ request: request(), describe: true })).resolves.toMatchObject({
      network: NETWORK,
      anchor: { status: 'valid', transactionHash: TRANSACTION, blockHash: BLOCK },
      domainBinding: { status: 'not_checked' },
      description: {
        context: [{ label: 'ContextString', context: '  exact verifier text  ' }],
        claims: [{ type: 'identity', sources: ['identityCredential', 'accountCredential'] }],
      },
    });
  });

  it.each([
    [{ ...request(), extra: true }],
    [{ ...request(), context: { ...(request().context as object), given: [{ label: 'PaymentHash', context: '00' }] } }],
    [{ ...request(), subjectClaims: [{ type: 'identity', source: ['identityCredential'], statements: [], issuers: ['did:ccd:testnet:idp:7junk'] }] }],
    [{ ...request(), context: { type: 'ConcordiumUnfilledContextInformationV1', given: null, requested: [] } }],
    [{ ...request(), context: { type: 'ConcordiumUnfilledContextInformationV1', given: [
      { label: 'Nonce', context: 7 },
    ], requested: [] } }],
    [{ ...request(), context: { type: 'ConcordiumUnfilledContextInformationV1', given: [
      { label: 'Nonce', context: 'not-hex' },
    ], requested: [] } }],
    [{ ...request(), context: { type: 'ConcordiumUnfilledContextInformationV1', given: [
      { label: 'ContextString', context: 7 },
    ], requested: [] } }],
    [{ ...request(), subjectClaims: [{
      type: 'identity', source: ['identityCredential'], statements: null, issuers: ['did:ccd:testnet:idp:7'],
    }] }],
    [{ ...request(), subjectClaims: [{
      type: 'identity', source: ['identityCredential'], statements: [], issuers: null,
    }] }],
    [{ ...request(), subjectClaims: [{
      type: 'identity', source: ['identityCredential'], statements: [null], issuers: ['did:ccd:testnet:idp:7'],
    }] }],
    [{ ...request(), subjectClaims: [{
      type: 'identity', source: ['identityCredential'],
      statements: [{ type: 'RevealAttribute', attributeTag: 'dob' }], issuers: ['did:ccd:testnet:idp:7'],
    }] }],
    [{ ...request(), subjectClaims: [{
      type: 'identity', source: ['identityCredential'],
      statements: [{ type: 'RevealAttribute', attributeTag: 'nationalIdNo' }], issuers: ['did:ccd:testnet:idp:7'],
    }] }],
  ])('rejects malformed or unsupported standard request JSON', async (input) => {
    const { deps, service } = fixture();
    await expect(service.validateRequest({ request: input, describe: false }))
      .rejects.toMatchObject({ name: 'IdentityProofError', code: 'INVALID_REQUEST' });
    expect(deps.verifyAnchor).not.toHaveBeenCalled();
    expect(deps.listRecords).not.toHaveBeenCalled();
  });

  it('describes supported binary contexts and omits absent domain binding', async () => {
    const { service } = fixture();
    const input = request();
    input.context = {
      type: 'ConcordiumUnfilledContextInformationV1',
      given: [
        { label: 'Nonce', context: '00ff' },
        { label: 'BlockHash', context: BLOCK },
        { label: 'ConnectionID', context: 'connection-7' },
      ],
      requested: [],
    };
    await expect(service.validateRequest({ request: input, describe: true })).resolves.toMatchObject({
      domainBinding: { status: 'not_checked' },
      description: { session: [
        { label: 'Nonce', context: '00ff' },
        { label: 'ConnectionID', context: 'connection-7' },
      ] },
    });
  });

  it('sanitizes anchor network failures before local state access', async () => {
    const { deps, service } = fixture();
    deps.verifyAnchor.mockRejectedValueOnce(new Error('/Users/alice/node-secret'));
    await expect(service.validateRequest({ request: request() }))
      .rejects.toMatchObject({ code: 'NETWORK_FAILED' });
    expect(deps.listRecords).not.toHaveBeenCalled();
  });

  it('returns only safe same-identity candidates and no candidates for a claimless request', async () => {
    const { service } = fixture();
    await expect(service.findCandidates({ request: request() })).resolves.toEqual({
      network: NETWORK, candidates: [{ subject: { type: 'identity', identityId: IDENTITY_ID }, label: 'ada' }],
    });
    await expect(service.findCandidates({ request: { ...request(), subjectClaims: [] } })).resolves.toEqual({
      network: NETWORK, candidates: [],
    });
  });

  it('finds an identity authorization candidate without consulting account caches', async () => {
    const { deps, service } = fixture();
    await expect(service.findCandidates({ request: request([]) })).resolves.toMatchObject({
      candidates: [{ subject: { type: 'identity', identityId: IDENTITY_ID } }],
    });
    expect(deps.listCachedCredentials).not.toHaveBeenCalled();
    expect(deps.loadCredentialRegistry).not.toHaveBeenCalled();
  });

  it('skips an individually unavailable identity but sanitizes lookup-wide storage failure', async () => {
    const unavailable = fixture();
    unavailable.deps.withMaterial.mockRejectedValueOnce(new IdentityProofError('SUBJECT_UNAVAILABLE'));
    await expect(unavailable.service.findCandidates({ request: request() })).resolves.toEqual({ network: NETWORK, candidates: [] });

    const failed = fixture();
    failed.deps.listRecords.mockRejectedValueOnce(new Error('/Users/alice/private-state'));
    await expect(failed.service.findCandidates({ request: request() }))
      .rejects.toMatchObject({ name: 'IdentityProofError', code: 'STORAGE_FAILED' });
  });

  it('filters unusable identity records before protected material access', async () => {
    const { deps, record, service } = fixture();
    deps.listRecords.mockResolvedValueOnce([
      { ...record, selection: { ...record.selection, network: 'ccd:other' } },
      { ...record, id: 'pending', status: 'pending' },
      { ...record, id: 'unassociated', sourceId: undefined },
      { ...record, id: 'eligible', label: undefined },
    ] as never);
    await expect(service.findCandidates({ request: request() })).resolves.toMatchObject({
      candidates: [{ subject: { type: 'identity', identityId: 'eligible' } }],
    });
    expect(deps.withMaterial).toHaveBeenCalledOnce();
  });

  it.each([
    [new IdentityProofError('SUBJECT_INELIGIBLE')],
    [new IdentitySourceError('SOURCE_NOT_FOUND')],
    [new IdentityWorkflowError('AUTHORIZATION_REQUIRED')],
    [new IdentityWorkflowError('SOURCE_NOT_ASSOCIATED')],
    [new IdentityWorkflowError('CRYPTO_FAILED')],
  ])('omits an identity candidate for expected local unavailability %#', async (failure) => {
    const { deps, service } = fixture();
    deps.withMaterial.mockRejectedValueOnce(failure);
    await expect(service.findCandidates({ request: request() })).resolves.toMatchObject({ candidates: [] });
  });

  it('sanitizes an unexpected per-identity inspection failure', async () => {
    const { deps, service } = fixture();
    deps.withMaterial.mockRejectedValueOnce(new Error('/Users/alice/identity-secret'));
    await expect(service.findCandidates({ request: request() }))
      .rejects.toMatchObject({ code: 'STORAGE_FAILED' });
  });

  it.each(['cache', 'registry'] as const)('sanitizes %s failure during account candidate discovery', async (dependency) => {
    const h = fixture();
    if (dependency === 'cache') h.deps.listCachedCredentials.mockRejectedValueOnce(new Error('/private/cache'));
    else h.deps.loadCredentialRegistry.mockRejectedValueOnce(new Error('/private/registry'));
    await expect(h.service.findCandidates({ request: request() }))
      .rejects.toMatchObject({ code: 'STORAGE_FAILED' });
  });

  it.each([
    [new IdentityProofError('SUBJECT_UNAVAILABLE'), undefined],
    [new IdentityProofError('SUBJECT_INELIGIBLE'), undefined],
    [new IdentitySourceError('SOURCE_NOT_FOUND'), undefined],
    [new IdentityWorkflowError('AUTHORIZATION_REQUIRED'), undefined],
    [new IdentityWorkflowError('SOURCE_NOT_ASSOCIATED'), undefined],
    [new IdentityWorkflowError('CRYPTO_FAILED'), undefined],
    [new Error('/Users/alice/cache-inspection'), 'STORAGE_FAILED'],
  ] as const)('classifies cached-account candidate inspection failure %#', async (failure, code) => {
    const h = fixture();
    const credentialId = deriveCredentialRegistrationId({
      seed: Buffer.alloc(64, 1), network: 'Testnet', identityProviderIndex: 7, identityIndex: 2,
      credentialIndex: 4, onChainCommitmentKey: h.issuerContext.globalContext.onChainCommitmentKey,
    });
    h.deps.listCachedCredentials.mockResolvedValueOnce([{
      account: '4abc', credentialIndex: 2, credentialId,
    }]);
    h.deps.loadCredentialRegistry.mockResolvedValueOnce({ version: 1, credentials: {
      [credentialId]: { identityId: IDENTITY_ID, credentialNumber: 4, status: 'confirmed' },
    } });
    h.deps.loadLocalContext.mockResolvedValueOnce(undefined).mockResolvedValueOnce(h.proofContext);
    h.deps.withMaterial.mockRejectedValueOnce(failure);
    const operation = h.service.findCandidates({ request: request() });
    if (code === undefined) await expect(operation).resolves.toMatchObject({ candidates: [] });
    else await expect(operation).rejects.toMatchObject({ code });
  });

  it('omits an identity candidate when its pinned local proof context is unavailable', async () => {
    const { deps, service } = fixture();
    deps.loadLocalContext.mockResolvedValueOnce(undefined);
    await expect(service.findCandidates({ request: request() })).resolves.toMatchObject({ candidates: [] });
    expect(deps.withMaterial).not.toHaveBeenCalled();
    expect(deps.loadGenerationContext).not.toHaveBeenCalled();
  });

  it('rechecks the finalized anchor before material access and rejects a claimless creation', async () => {
    const { deps, service } = fixture();
    deps.verifyAnchor.mockResolvedValueOnce({ status: 'invalid', reason: 'request anchor mismatch' } as never);
    await expect(service.createProof({ request: request(), subject: { type: 'identity', identityId: IDENTITY_ID } }))
      .rejects.toMatchObject({ code: 'INVALID_ANCHOR' });
    expect(deps.withMaterial).not.toHaveBeenCalled();

    await expect(service.createProof({ request: { ...request(), subjectClaims: [] },
      subject: { type: 'identity', identityId: IDENTITY_ID } }))
      .rejects.toMatchObject({ code: 'NO_PROVABLE_CLAIMS' });
  });

  it('creates and post-verifies an SDK presentation without echoing the subject', async () => {
    const { deps, service } = fixture();
    const result = await service.createProof({ request: request(), subject: { type: 'identity', identityId: IDENTITY_ID } });
    expect(result).toEqual({
      network: NETWORK, presentation: { type: ['VerifiablePresentation', 'ConcordiumVerifiablePresentationV1'] },
    });
    expect(deps.createPresentation).toHaveBeenCalledOnce();
    expect(deps.verifyPresentation).toHaveBeenCalledOnce();
    expect(result).not.toHaveProperty('subject');
  });

  it('normalizes serialized block and nonce context returned by post-verification', async () => {
    const { deps, service } = fixture();
    const input = request();
    input.context = {
      type: 'ConcordiumUnfilledContextInformationV1',
      given: [{ label: 'BlockHash', context: BLOCK }, { label: 'Nonce', context: '00ff' }],
      requested: [],
    };
    deps.verifyPresentation.mockImplementationOnce((presentation) => {
      const proofRequest = (presentation as { proofRequest: {
        context: { type: string; given: Array<{ label: string; context: unknown }>; requested: unknown[] };
      } }).proofRequest;
      return { type: 'success', result: { ...proofRequest, context: {
        ...proofRequest.context,
        given: proofRequest.context.given.map(entry => ({
          label: entry.label,
          context: entry.label === 'BlockHash' ? BLOCK : entry.label === 'Nonce' ? '00ff' : entry.context,
        })),
      } } } as never;
    });
    await expect(service.createProof({ request: input,
      subject: { type: 'identity', identityId: IDENTITY_ID } })).resolves.toHaveProperty('presentation');
  });

  it('resolves a trimmed case-insensitive bare identity label only after strict request parsing', async () => {
    const { deps, service } = fixture();
    await expect(service.createProof({ request: request(), subject: { type: 'identity', identityId: ' AdA ' } }))
      .resolves.toHaveProperty('presentation');

    deps.listRecords.mockClear();
    await expect(service.createProof({ request: { ...request(), unexpected: true },
      subject: { type: 'identity', identityId: 'ada' } }))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(deps.listRecords).not.toHaveBeenCalled();
  });

  it('rejects malformed identity selectors before reading identity storage', async () => {
    const { deps, service } = fixture();

    await expect(service.createProof({ request: request(),
      subject: { type: 'identity', identityId: '@invalid' } }))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(deps.listRecords).not.toHaveBeenCalled();
  });

  it('forwards the raw network selector to core resolution before canonical storage access', async () => {
    const { deps, service } = fixture();
    await service.createProof({ network: 'testnet', request: request(),
      subject: { type: 'identity', identityId: 'ada' } });
    expect(deps.resolveNetwork).toHaveBeenCalledExactlyOnceWith('testnet');
    expect(deps.listRecords).toHaveBeenCalledWith(NETWORK);
  });

  it.each([
    'record-status', 'context-network', 'context-sdk-network', 'provider', 'id-cred-pub',
  ] as const)('rejects identity/context integrity mismatch: %s', async (kind) => {
    const h = fixture();
    if (kind === 'record-status') h.record.status = 'pending' as never;
    if (kind === 'context-network') h.proofContext.network = 'ccd:other';
    if (kind === 'context-sdk-network') h.proofContext.sdkNetwork = 'Mainnet';
    if (kind === 'provider') h.proofContext.ipInfo.ipIdentity += 1;
    if (kind === 'id-cred-pub') h.identity.value.preIdentityObject.idCredPub = 'ff'.repeat(48);
    await expect(h.service.createProof({ request: request(),
      subject: { type: 'identity', identityId: IDENTITY_ID } }))
      .rejects.toMatchObject({ code: 'SUBJECT_INELIGIBLE' });
  });

  it('rejects missing and claim-ineligible identity subjects', async () => {
    const missing = fixture();
    await expect(missing.service.createProof({ request: request(),
      subject: { type: 'identity', identityId: 'missing' } }))
      .rejects.toMatchObject({ code: 'SUBJECT_NOT_FOUND' });
    expect(missing.deps.withMaterial).not.toHaveBeenCalled();

    const issuer = fixture();
    const wrongIssuer = request();
    (wrongIssuer.subjectClaims as Array<Record<string, unknown>>)[0]!.issuers = ['did:ccd:testnet:idp:8'];
    await expect(issuer.service.createProof({ request: wrongIssuer,
      subject: { type: 'identity', identityId: IDENTITY_ID } }))
      .rejects.toMatchObject({ code: 'SUBJECT_INELIGIBLE' });
  });

  it('sanitizes generation-context loading failure before material access', async () => {
    const { deps, service } = fixture();
    deps.loadGenerationContext.mockRejectedValueOnce(new Error('/Users/alice/provider-context'));
    await expect(service.createProof({ request: request(),
      subject: { type: 'identity', identityId: IDENTITY_ID } }))
      .rejects.toMatchObject({ code: 'NETWORK_FAILED' });
    expect(deps.withMaterial).not.toHaveBeenCalled();
    expect(deps.loadLocalContext).not.toHaveBeenCalled();
  });

  it('rejects generation context from a different finalized block before material access', async () => {
    const h = fixture();
    h.proofContext.sourceBlock.hash = 'ef'.repeat(32);
    await expect(h.service.createProof({ request: request(),
      subject: { type: 'identity', identityId: IDENTITY_ID } }))
      .rejects.toMatchObject({ code: 'NETWORK_FAILED' });
    expect(h.deps.withMaterial).not.toHaveBeenCalled();
  });

  it.each([
    ['invalid block time', 'not-a-time', undefined],
    ['identity not yet valid', '2025-10-31T23:59:59.000Z', undefined],
    ['identity expired', '2050-02-01T00:00:00.000Z', undefined],
    ['invalid created month', BLOCK_TIME, { createdAt: '2026-10' }],
    ['invalid validity month', BLOCK_TIME, { validTo: '2030-12' }],
  ] as const)('rejects identity authorization validity mismatch: %s', async (_label, time, dates) => {
    const h = fixture();
    h.proofContext.sourceBlock.time = time;
    if (dates !== undefined) Object.assign(h.identity.value.attributeList, dates);
    await expect(h.service.createProof({ request: request(),
      subject: { type: 'identity', identityId: IDENTITY_ID } }))
      .rejects.toMatchObject({ code: 'SUBJECT_INELIGIBLE' });
  });

  it.each([
    [['ContextString']],
    [['BlockHash', 'BlockHash']],
  ])('rejects unsupported requested proof context %j', async (requested) => {
    const { service } = fixture();
    const input = request();
    (input.context as { requested: string[] }).requested = requested;
    await expect(service.createProof({ request: input,
      subject: { type: 'identity', identityId: IDENTITY_ID } }))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });

  it.each(['sdk-failure', 'context-mismatch', 'claims-mismatch'] as const)(
    'rejects post-verification %s without returning a presentation', async (kind) => {
      const { deps, service } = fixture();
      if (kind === 'sdk-failure') deps.verifyPresentation.mockReturnValueOnce({ type: 'failure' } as never);
      if (kind === 'context-mismatch') deps.verifyPresentation.mockImplementationOnce((presentation) => ({
        type: 'success', result: { ...(presentation as { proofRequest: Record<string, unknown> }).proofRequest,
          context: { type: 'ConcordiumContextInformationV1', given: [], requested: [] } },
      }) as never);
      if (kind === 'claims-mismatch') deps.verifyPresentation.mockImplementationOnce((presentation) => ({
        type: 'success', result: { ...(presentation as { proofRequest: Record<string, unknown> }).proofRequest,
          subjectClaims: [1n] },
      }) as never);
      await expect(service.createProof({ request: request(),
        subject: { type: 'identity', identityId: IDENTITY_ID } }))
        .rejects.toMatchObject({ code: 'PROOF_FAILED' });
    },
  );

  it('sanitizes unexpected SDK presentation creation failure', async () => {
    const { deps, service } = fixture();
    deps.createPresentation.mockImplementationOnce(() => { throw new Error('/Users/alice/sdk-secret'); });
    await expect(service.createProof({ request: request(),
      subject: { type: 'identity', identityId: IDENTITY_ID } }))
      .rejects.toMatchObject({ code: 'PROOF_FAILED' });
  });

  it('sanitizes protected identity loading failure inside the material scope', async () => {
    const { deps, service } = fixture();
    deps.loadIdentity.mockRejectedValueOnce(new Error('/Users/alice/encrypted-identity'));
    await expect(service.createProof({ request: request(),
      subject: { type: 'identity', identityId: IDENTITY_ID } }))
      .rejects.toMatchObject({ code: 'PROOF_FAILED' });
  });

  it('uses the lowest eligible finalized normal account credential and its HD credential number', async () => {
    const { deps, service } = fixture();
    const credentialId = deriveCredentialRegistrationId({
      seed: Buffer.alloc(64, 1), network: 'Testnet', identityProviderIndex: 7, identityIndex: 2,
      credentialIndex: 4, onChainCommitmentKey: context().globalContext.onChainCommitmentKey,
    });
    const higherCredentialId = 'ee'.repeat(48);
    deps.loadCredentialRegistry.mockResolvedValueOnce({
      version: 1, credentials: {
        [credentialId]: { identityId: IDENTITY_ID, credentialNumber: 4, status: 'confirmed' },
        [higherCredentialId]: { identityId: IDENTITY_ID, credentialNumber: 9, status: 'confirmed' },
      },
    });
    deps.loadFinalizedCredentials.mockResolvedValueOnce({
      account: '4abc', sourceBlock: { hash: BLOCK, time: BLOCK_TIME },
      credentials: [
        { account: '4abc', credentialIndex: 7, credentialId: higherCredentialId, issuer: 7,
          commitments: { firstName: '88'.repeat(48) },
          policy: { createdAt: '202610', validTo: '203012', revealedAttributes: {} } },
        { account: '4abc', credentialIndex: 2, credentialId, issuer: 7,
          commitments: { firstName: '99'.repeat(48) },
          policy: { createdAt: '202610', validTo: '203012', revealedAttributes: {} } },
      ],
      currentCredentials: [
        { credentialIndex: 2, credentialId }, { credentialIndex: 7, credentialId: higherCredentialId },
      ],
    } as never);

    await expect(service.createProof({ request: request(), subject: { type: 'account', account: 'primary' } }))
      .resolves.toEqual({ network: NETWORK,
        presentation: { type: ['VerifiablePresentation', 'ConcordiumVerifiablePresentationV1'] } });
    expect(deps.loadFinalizedCredentials).toHaveBeenCalledWith(NETWORK, 'primary', BLOCK);
    expect(deps.withMaterial).toHaveBeenCalledOnce();
  });

  it('rejects account creation without statements before chain or storage access', async () => {
    const { deps, service } = fixture();
    await expect(service.createProof({ request: request([]),
      subject: { type: 'account', account: 'primary' } }))
      .rejects.toMatchObject({ code: 'NO_PROVABLE_CLAIMS' });
    expect(deps.loadFinalizedCredentials).not.toHaveBeenCalled();
    expect(deps.listRecords).not.toHaveBeenCalled();
  });

  it.each([
    ['chain', 'NETWORK_FAILED'],
    ['registry', 'STORAGE_FAILED'],
  ] as const)('sanitizes account %s lookup failure', async (dependency, code) => {
    const { deps, service } = fixture();
    if (dependency === 'chain') deps.loadFinalizedCredentials.mockRejectedValueOnce(new Error('/private/node'));
    else deps.loadCredentialRegistry.mockRejectedValueOnce(new Error('/private/registry'));
    await expect(service.createProof({ request: request(), subject: { type: 'account', account: 'primary' } }))
      .rejects.toMatchObject({ code });
    expect(deps.withMaterial).not.toHaveBeenCalled();
  });

  it('honors an explicit account credential index and rejects no matching finalized credential', async () => {
    const h = fixture();
    configureAccount(h, { credentialIndex: 2 });
    await expect(h.service.createProof({ request: request(),
      subject: { type: 'account', account: 'primary', credentialIndex: 3 } }))
      .rejects.toMatchObject({ code: 'SUBJECT_INELIGIBLE' });
    expect(h.deps.withMaterial).not.toHaveBeenCalled();
  });

  it.each(['missing-allocation', 'missing-record', 'pending-allocation'] as const)(
    'skips unusable finalized account mapping: %s', async (kind) => {
      const h = fixture();
      const { credentialId } = configureAccount(h);
      if (kind === 'missing-allocation') {
        h.deps.loadCredentialRegistry.mockReset().mockResolvedValueOnce({ version: 1, credentials: {} });
      }
      if (kind === 'missing-record') h.deps.listRecords.mockResolvedValueOnce([]);
      if (kind === 'pending-allocation') {
        h.deps.loadCredentialRegistry.mockReset().mockResolvedValueOnce({ version: 1, credentials: {
          [credentialId]: { identityId: IDENTITY_ID, credentialNumber: 4, status: 'reserved' },
        } } as never);
      }
      await expect(h.service.createProof({ request: request(), subject: { type: 'account', account: 'primary' } }))
        .rejects.toMatchObject({ code: 'SUBJECT_INELIGIBLE' });
      expect(h.deps.withMaterial).not.toHaveBeenCalled();
    },
  );

  it.each(['issuer', 'credential-id', 'commitment', 'claims'] as const)(
    'rejects account credential integrity mismatch: %s', async (kind) => {
      const h = fixture();
      configureAccount(h, {
        ...(kind === 'issuer' ? { issuer: 8 } : {}),
        ...(kind === 'commitment' ? { commitments: {} } : {}),
      });
      if (kind === 'credential-id') h.deps.withMaterial.mockImplementationOnce(async (_record, callback) => callback({
        seed: Buffer.alloc(64, 9), material: {
          idCredSec: Buffer.alloc(32), prfKey: Buffer.alloc(32), signatureBlindingRandomness: Buffer.alloc(32),
        }, storageKey: Buffer.alloc(32),
      }));
      const input = request(kind === 'claims' ? [{
        type: 'AttributeInSet', attributeTag: 'firstName', set: ['Grace'],
      }] : undefined);
      await expect(h.service.createProof({ request: input, subject: { type: 'account', account: 'primary' } }))
        .rejects.toMatchObject({ code: 'SUBJECT_INELIGIBLE' });
    },
  );

  it.each([
    ['invalid block time', (state: ReturnType<typeof configureAccount>['state']) => {
      state.sourceBlock.time = 'not-a-time';
    }],
    ['invalid created month', (state: ReturnType<typeof configureAccount>['state']) => {
      state.credentials[0]!.policy.createdAt = '2026-10';
    }],
    ['invalid validity month', (state: ReturnType<typeof configureAccount>['state']) => {
      state.credentials[0]!.policy.validTo = '2030-12';
    }],
  ] as const)('rejects malformed finalized account policy: %s', async (_label, mutate) => {
    const h = fixture();
    const { state } = configureAccount(h);
    mutate(state);
    h.proofContext.sourceBlock.time = state.sourceBlock.time;
    await expect(h.service.createProof({ request: request(), subject: { type: 'account', account: 'primary' } }))
      .rejects.toMatchObject({ code: 'SUBJECT_INELIGIBLE' });
  });

  it.each(['sdk-failure', 'verification-failure', 'unexpected'] as const)(
    'sanitizes account presentation failure: %s', async (kind) => {
      const h = fixture();
      configureAccount(h);
      if (kind === 'sdk-failure') h.deps.verifyPresentation.mockReturnValueOnce({ type: 'failure' } as never);
      if (kind === 'verification-failure') h.deps.verifyPresentation.mockImplementationOnce((presentation) => ({
        type: 'success', result: { ...(presentation as { proofRequest: Record<string, unknown> }).proofRequest,
          subjectClaims: [] },
      }) as never);
      if (kind === 'unexpected') h.deps.createPresentation.mockImplementationOnce(() => {
        throw new Error('/Users/alice/account-proof');
      });
      await expect(h.service.createProof({ request: request(), subject: { type: 'account', account: 'primary' } }))
        .rejects.toMatchObject({ code: 'PROOF_FAILED' });
    },
  );

  it('creates and verifies account proof cryptography with the public upstream fixture', async () => {
    const issuerContext = context({
      ipInfo: { ...context().ipInfo, ipIdentity: 0 }, globalContext: PUBLIC_FIXTURE.globalContext,
    });
    const selected = { ...selection(), identityProviderIndex: 0, identityIndex: 0 };
    const proofContext = { ...issuerContext, sourceBlock: { hash: BLOCK, time: BLOCK_TIME } };
    const identity = identityObject();
    identity.value.attributeList = PUBLIC_FIXTURE.identity.attributeList;
    const record = {
      version: 1 as const, id: IDENTITY_ID, sourceId: SOURCE_ID, selection: selected,
      contextHash: contextFingerprint(issuerContext), idCredPub: identity.value.preIdentityObject.idCredPub,
      status: 'ready' as const,
    };
    const requestJson = request([{ type: 'AttributeInSet', attributeTag: 'firstName', set: ['Jesus'] }]);
    (requestJson.subjectClaims as Array<Record<string, unknown>>)[0]!.issuers = ['did:ccd:testnet:idp:0'];
    const service = createIdentityProofService({
      resolveNetwork: () => ({ caip2: NETWORK, sdkNetwork: 'Testnet' }),
      listRecords: async () => [record], loadIdentity: async () => identity,
      loadLocalContext: async () => proofContext, loadGenerationContext: async () => proofContext,
      verifyAnchor: async () => ({ status: 'valid', transactionHash: TRANSACTION, blockHash: BLOCK, account: '4abc' }),
      loadCredentialRegistry: async () => ({ version: 1, credentials: {
        [PUBLIC_FIXTURE.credential.credId]: { identityId: IDENTITY_ID, credentialNumber: 0, status: 'confirmed' },
      } }),
      listCachedCredentials: async () => [],
      loadFinalizedCredentials: async () => ({
        account: '4abc', sourceBlock: { hash: BLOCK, time: BLOCK_TIME },
        credentials: [{ account: '4abc', credentialIndex: 0,
          credentialId: PUBLIC_FIXTURE.credential.credId, issuer: 0,
          commitments: PUBLIC_FIXTURE.credential.commitments.cmmAttributes,
          policy: {
            createdAt: PUBLIC_FIXTURE.identity.attributeList.createdAt,
            validTo: PUBLIC_FIXTURE.identity.attributeList.validTo,
            revealedAttributes: {},
          } }],
        currentCredentials: [{ credentialIndex: 0, credentialId: PUBLIC_FIXTURE.credential.credId }],
      }),
      withMaterial: async (_record: unknown, callback: (scope: {
        seed: Buffer; storageKey: Buffer;
        material: { idCredSec: Buffer; prfKey: Buffer; signatureBlindingRandomness: Buffer };
      }) => Promise<unknown>) => callback({
        seed: Buffer.from(PUBLIC_FIXTURE.testSeed, 'hex'), storageKey: Buffer.alloc(32),
        material: { idCredSec: Buffer.alloc(32), prfKey: Buffer.alloc(32), signatureBlindingRandomness: Buffer.alloc(32) },
      }),
    } as never);

    await expect(service.createProof({ request: requestJson, subject: { type: 'account', account: '4abc' } }))
      .resolves.toMatchObject({ network: NETWORK,
        presentation: { type: ['VerifiablePresentation', 'ConcordiumVerifiablePresentationV1'] } });
  });
});
