import { readFileSync } from 'node:fs';

import { describe,expect,it } from 'vitest';

import { deriveIdentityMaterial,type IdentityMaterial } from '../../src/core/identityMaterial.js';
import { createIdentityProofService } from '../../src/core/identityProofs.js';
import type { StoredIdentity } from '../../src/core/workflowTypes.js';
import { NETWORK,SOURCE_ID,selection as workflowSelection } from '../workflowFixtures.js';

const BLOCK = 'cd'.repeat(32);
const BLOCK_TIME = '2026-10-18T10:00:00.000Z';
const TRANSACTION = 'ab'.repeat(32);
const fixture = JSON.parse(readFileSync(new URL('../publicIdentityProofFixture.json', import.meta.url), 'utf8')) as {
  sourceUrl: string;
  publicTestSeed: string;
  sdkNetwork: 'Testnet';
  identityProviderIndex: 0;
  identityIndex: 0;
  identity: { v: 0; value: {
    attributeList: { chosenAttributes: Record<string, string>; createdAt: string; validTo: string };
    preIdentityObject: { idCredPub: string };
  } };
  ipInfo: { ipIdentity: number; [key: string]: unknown };
  arsInfos: Record<string, unknown>;
  globalContext: Record<string, unknown>;
};

function request(): Record<string, unknown> {
  return {
    type: 'ConcordiumVerificationRequestV1',
    context: {
      type: 'ConcordiumUnfilledContextInformationV1',
      given: [
        { label: 'ContextString', context: 'Authorize this exact session without revealing attributes' },
        { label: 'Nonce', context: '01'.repeat(32) },
      ],
      requested: ['BlockHash'],
    },
    subjectClaims: [{
      type: 'identity', source: ['identityCredential'], statements: [], issuers: ['did:ccd:testnet:idp:0'],
    }],
    transactionRef: TRANSACTION,
  };
}

function serviceFixture({ wrongSecret = false, alteredContext = false } = {}) {
  const selection = { ...workflowSelection(), identityProviderIndex: fixture.identityProviderIndex,
    identityIndex: fixture.identityIndex };
  const proofContext = {
    network: NETWORK, genesisHash: '12'.repeat(32), sdkNetwork: fixture.sdkNetwork,
    ipInfo: alteredContext ? {
      ...fixture.ipInfo,
      ipVerifyKey: `00${String(fixture.ipInfo.ipVerifyKey).slice(2)}`,
    } : fixture.ipInfo,
    arsInfos: fixture.arsInfos, globalContext: fixture.globalContext,
    sourceBlock: { hash: BLOCK, time: BLOCK_TIME },
  };
  const record = {
    version: 1 as const, id: '35'.repeat(32), sourceId: SOURCE_ID, selection,
    contextHash: '11'.repeat(32),
    idCredPub: fixture.identity.value.preIdentityObject.idCredPub, status: 'ready' as const,
  };
  const deps: Parameters<typeof createIdentityProofService>[0] = {
    resolveNetwork: () => ({ caip2: NETWORK, sdkNetwork: fixture.sdkNetwork }),
    listRecords: async () => [record],
    loadIdentity: async () => fixture.identity as never,
    loadLocalContext: async () => proofContext as never,
    loadGenerationContext: async () => proofContext as never,
    verifyAnchor: async () => ({
      status: 'valid', transactionHash: TRANSACTION, blockHash: BLOCK, account: '4abc',
    }),
    listCachedCredentials: async () => [],
    loadCredentialRegistry: async () => ({ version: 1, credentials: {} }),
    loadFinalizedCredentials: async () => ({
      account: '4abc', sourceBlock: { hash: BLOCK, time: BLOCK_TIME }, credentials: [], currentCredentials: [],
    }),
    async withMaterial<T>(_record: StoredIdentity, callback: (scope: {
      seed: Buffer; material: IdentityMaterial; storageKey: Buffer;
    }) => Promise<T>): Promise<T> {
      const seed = Buffer.from(fixture.publicTestSeed, 'hex');
      const material = deriveIdentityMaterial({
        seed, network: fixture.sdkNetwork, identityProviderIndex: fixture.identityProviderIndex,
        identityIndex: fixture.identityIndex,
      });
      if (wrongSecret) material.idCredSec[0] = material.idCredSec[0]! ^ 0xff;
      try { return await callback({ seed, material, storageKey: Buffer.alloc(32) }); }
      finally {
        seed.fill(0);
        material.idCredSec.fill(0);
        material.prfKey.fill(0);
        material.signatureBlindingRandomness.fill(0);
      }
    },
  };
  return createIdentityProofService(deps);
}

describe('public identity authorization proof', () => {
  it('creates and post-verifies a context-bound identity proof without revealing attributes', async () => {
    const result = await serviceFixture().createProof({
      request: request(), subject: { type: 'identity', identityId: '35'.repeat(32) },
    });
    const serialized = JSON.stringify(result.presentation);
    const credential = (result.presentation.verifiableCredential as Array<{
      credentialSubject: { statement: unknown[] };
      proof: { proofValue: string };
    }>)[0]!;
    expect(result.network).toBe(NETWORK);
    expect(credential.credentialSubject.statement).toEqual([]);
    expect(credential.proof.proofValue.length).toBeGreaterThan(500);
    expect(serialized.length).toBeGreaterThan(500);
    for (const name of Object.keys(fixture.identity.value.attributeList.chosenAttributes)) {
      expect(serialized).not.toContain(name);
    }
  }, 15_000);

  it('rejects authorization generated with the wrong identity secret', async () => {
    await expect(serviceFixture({ wrongSecret: true }).createProof({
      request: request(), subject: { type: 'identity', identityId: '35'.repeat(32) },
    })).rejects.toMatchObject({ code: 'PROOF_FAILED' });
  });

  it('rejects authorization against altered issuer verification context', async () => {
    await expect(serviceFixture({ alteredContext: true }).createProof({
      request: request(), subject: { type: 'identity', identityId: '35'.repeat(32) },
    })).rejects.toMatchObject({ code: 'PROOF_FAILED' });
  });
});
