import { rmSync } from 'node:fs';
import { afterEach,describe,expect,it,vi } from 'vitest';

import { addNetwork,getIdentityContextSnapshotPathForNetwork,setIdentityContextSnapshot } from '@ccd-agent-kit/config-utils';
import type { IdentityContextSnapshot } from '@ccd-agent-kit/sdk-utils';

import { deriveCredentialRegistrationId } from '../../src/core/identityMaterial.js';
import { withIdentityMaterial } from '../../src/core/identityMaterialSession.js';
import * as providerServiceFactory from '../../src/core/providers/serviceFactory.js';
import { createDefaultIdentityProofService } from '../../src/core/workflowInfrastructure.js';
import { softwareDevice } from '../helpers.js';
import { useProviderScratch } from '../providerHelpers.js';
import {
context,
ID_CRED_PUB,
IDENTITY_ID,
identityObject,NETWORK,selection,SOURCE_ID,
} from '../workflowFixtures.js';

const REF = NETWORK.slice(4);
const SEED_DEVICE = softwareDevice();

function snapshot(): IdentityContextSnapshot {
  const value = context();
  return {
    version: 1,
    network: { caip2: value.network, genesisHash: value.genesisHash },
    sourceBlock: { hash: 'ab'.repeat(32), height: '7', time: '2026-10-18T10:00:00.000Z' },
    observedAt: '2026-10-18T10:01:00.000Z',
    globalContext: value.globalContext,
    identityProviders: [value.ipInfo],
    anonymityRevokers: Object.values(value.arsInfos),
  };
}

function request(): Record<string, unknown> {
  return {
    type: 'ConcordiumVerificationRequestV1',
    context: { type: 'ConcordiumUnfilledContextInformationV1', given: [], requested: ['BlockHash'] },
    subjectClaims: [{ type: 'identity', source: ['accountCredential'],
      statements: [{ type: 'AttributeInSet', attributeTag: 'firstName', set: ['Ada'] }],
      issuers: ['did:ccd:testnet:idp:7'] }],
    transactionRef: 'ab'.repeat(32),
  };
}

describe('proof local context', () => {
  useProviderScratch('proof-local-context-');
  afterEach(() => vi.restoreAllMocks());

  async function createFixture() {
    addNetwork('proof-local', { caip2: NETWORK, genesisHash: context().genesisHash,
      grpc: { host: 'forbidden.invalid', port: 20000, ssl: true } });
    const publicSnapshot = snapshot();
    const selected = { ...selection(), rootPublicKey: SEED_DEVICE.publicKey.toString('hex') };
    const record = {
      version: 1 as const, id: IDENTITY_ID, sourceId: SOURCE_ID, selection: selected,
      contextHash: '11'.repeat(32),
      idCredPub: ID_CRED_PUB, status: 'ready' as const,
    };
    const sources = {
      createAgreement: vi.fn(async () => ({ agree: SEED_DEVICE.agree })),
    };
    const credentialId = await withIdentityMaterial({ selection: selected, sourceId: SOURCE_ID,
      sources: sources as never }, seed => deriveCredentialRegistrationId({
      seed, network: 'Testnet', identityProviderIndex: 7, identityIndex: 2,
      credentialIndex: 4, onChainCommitmentKey: publicSnapshot.globalContext.onChainCommitmentKey,
    }));
    sources.createAgreement.mockClear();
    const store = {
      list: vi.fn(async () => [record]),
      loadIdentity: vi.fn(async () => identityObject()),
      loadCredentials: vi.fn(async () => ({ version: 1 as const, credentials: {
        [credentialId]: { identityId: IDENTITY_ID, credentialNumber: 4, status: 'confirmed' as const },
      } })),
    };
    const providerFactory = vi.spyOn(providerServiceFactory, 'createDefaultIdentityProviderService');
    const readNodeContext = vi.fn(async () => { throw new Error('gRPC is forbidden during local discovery'); });
    const service = createDefaultIdentityProofService({
      store: store as never, sources: sources as never, readNodeContext,
      loadCachedCredentials: () => [{ account: '4abc', credentialIndex: 3, credentialId }],
    });
    return { publicSnapshot, providerFactory, readNodeContext, service, sources, store };
  }

  it('uses only a matching stored public snapshot for a legacy record with no extra proof pin', async () => {
    const fixture = await createFixture();
    setIdentityContextSnapshot(REF, fixture.publicSnapshot);
    const result = await fixture.service.findCandidates({ network: NETWORK, request: request() });
    await expect(result).toEqual({
      network: NETWORK,
      candidates: [{ subject: { type: 'account', account: '4abc', credentialIndex: 3 } }],
    });
    expect(fixture.readNodeContext).not.toHaveBeenCalled();
    expect(fixture.providerFactory).not.toHaveBeenCalled();
  });

  it('skips the subject when the local snapshot is absent without network or provider fallback', async () => {
    const fixture = await createFixture();
    rmSync(getIdentityContextSnapshotPathForNetwork(REF), { recursive: true, force: true });
    await expect(fixture.service.findCandidates({ network: NETWORK, request: request() })).resolves.toEqual({
      network: NETWORK, candidates: [],
    });
    expect(fixture.readNodeContext).not.toHaveBeenCalled();
    expect(fixture.providerFactory).not.toHaveBeenCalled();
  });

  it('accepts changed public proof parameters when network and selected IDP still match', async () => {
    const fixture = await createFixture();
    fixture.publicSnapshot.identityProviders = fixture.publicSnapshot.identityProviders.map(provider => ({
      ...provider, ipDescription: { ...provider.ipDescription, name: 'Changed provider' },
    }));
    setIdentityContextSnapshot(REF, fixture.publicSnapshot);
    await expect(fixture.service.findCandidates({ network: NETWORK, request: request() })).resolves.toEqual({
      network: NETWORK,
      candidates: [{ subject: { type: 'account', account: '4abc', credentialIndex: 3 } }],
    });
    expect(fixture.readNodeContext).not.toHaveBeenCalled();
    expect(fixture.providerFactory).not.toHaveBeenCalled();
  });
});
