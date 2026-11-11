import { IdentityHardwareError } from '@ccd-agent-kit/piv-utils';
import { afterEach,describe,expect,it,vi } from 'vitest';
import * as materialCore from '../../src/core/identityMaterial.js';
import * as rootCore from '../../src/core/identityRoot.js';
import { deriveIdentityStorageMaterial } from '../../src/core/identityStorageCrypto.js';
import { createIdentityWorkflow,IdentityWorkflowError } from '../../src/core/identityWorkflow.js';
import { awaitingRecord,context,IDENTITY_ID,identityObject,NOW_MS,PUBLIC_KEY,readyRecord,recoveryInput,requestInput,requestObject,setup } from '../workflowFixtures.js';

afterEach(() => vi.restoreAllMocks());

function ownedBuffers() {
  const seed = Buffer.alloc(64, 1);
  const material = {idCredSec:Buffer.alloc(32, 2),prfKey:Buffer.alloc(32, 3),signatureBlindingRandomness:Buffer.alloc(32, 4)};
  vi.spyOn(rootCore,'deriveIdentityRoot').mockResolvedValue(seed);
  vi.spyOn(materialCore,'deriveIdentityMaterial').mockReturnValue(material);
  return {seed, material, assertCleared() {
    for (const value of [seed,...Object.values(material)]) expect(value.every(b => b === 0)).toBe(true);
  }};
}

describe('workflow secret ownership and containment', () => {
  it('uses the current clock for recovery proofs and persists the derived handle', async () => {
    const fixture = setup();
    vi.mocked(fixture.provider.recover).mockResolvedValue(identityObject({
      ...requestObject().value, idCredPub: fixture.recovery.value.idCredPub,
    }));
    delete fixture.deps.now;
    vi.spyOn(Date,'now').mockReturnValue(NOW_MS);
    const recovered = await createIdentityWorkflow(fixture.deps).recover(recoveryInput());
    expect(vi.mocked(fixture.crypto.recovery).mock.calls[0]![0].timestamp).toBe(Math.floor(NOW_MS/1000));
    expect(fixture.store.records.get(recovered.identityId)?.status).toBe('ready');
    expect(fixture.store.records.size).toBe(1);
  });
  it('rejects invalid identity handles before reading state', async () => {
    const fixture = setup();
    await expect(createIdentityWorkflow(fixture.deps).status({ identityId: '../identity' })).rejects.toMatchObject({code:'INVALID_INPUT'});
    expect(fixture.store.load).not.toHaveBeenCalled();
  });
  it('rejects ambiguous callback fragments before fetching identity state', async () => {
    const fixture = setup(); fixture.store.records.set(IDENTITY_ID,awaitingRecord());
    await expect(createIdentityWorkflow(fixture.deps).status({identityId:IDENTITY_ID,callbackUrl:`ccd-id-manager://identity/${IDENTITY_ID}#code_uri=https://issuer.example.test/result&code_uri=https://issuer.example.test/other`})).rejects.toMatchObject({code:'INVALID_INPUT'});
    expect(fixture.provider.retrieve).not.toHaveBeenCalled();
  });
  it('does not retrieve a pending identity after its pinned issuer context changes', async () => {
    const fixture = setup(); fixture.store.records.set(IDENTITY_ID,awaitingRecord());
    vi.mocked(fixture.deps.loadContext).mockResolvedValue({...context(), recoveryUrl:'https://issuer.example.test/changed'});
    await expect(createIdentityWorkflow(fixture.deps).status({
      identityId: IDENTITY_ID,
      callbackUrl: `ccd-id-manager://identity/${IDENTITY_ID}#code_uri=${encodeURIComponent('https://issuer.example.test/result')}`,
    })).rejects.toMatchObject({code:'CONTEXT_MISMATCH'});
    expect(fixture.provider.retrieve).not.toHaveBeenCalled();
  });
  it('normalizes external public keys with the shared Ed25519 parser', async () => {
    const fixture = setup(); fixture.store.records.set(IDENTITY_ID,readyRecord());
    await expect(createIdentityWorkflow(fixture.deps).prepareAccount({identityId:IDENTITY_ID,credentialNumber:0,publicKeys:{'0':` ${PUBLIC_KEY.toUpperCase()} `},credentialThreshold:1,expirySeconds:NOW_MS/1000+600})).resolves.toHaveProperty('credDeploymentHex');
    expect(vi.mocked(fixture.crypto.credential).mock.calls[0]![0].credentialPublicKeys.keys[0]).toEqual({schemeId:'Ed25519',verifyKey:PUBLIC_KEY});
  });
  it('rejects an expired identity before hardware access', async () => {
    const fixture = setup(); const record = readyRecord();
    record.identity!.value.attributeList.validTo = '202611';
    fixture.store.records.set(IDENTITY_ID,record);
    await expect(createIdentityWorkflow(fixture.deps).prepareAccount({identityId:IDENTITY_ID,credentialNumber:0,publicKeys:{'0':PUBLIC_KEY},credentialThreshold:1,expirySeconds:NOW_MS/1000+600})).rejects.toMatchObject({code:'IDENTITY_NOT_READY'});
    expect(fixture.sources.createAgreement).toHaveBeenCalledTimes(2);
  });
  it.each([false,true])('clears root and identity scalars after request, including SDK failure=%s', async fails => {
    const owned = ownedBuffers();
    const fixture = setup();
    if (fails) vi.mocked(fixture.crypto.request).mockImplementation(() => { throw new Error('private SDK detail'); });
    const operation = createIdentityWorkflow(fixture.deps).request(requestInput());
    if (fails) await expect(operation).rejects.toMatchObject({code:'CRYPTO_FAILED'});
    else await expect(operation).resolves.toMatchObject({status:'pending'});
    owned.assertCleared();
  });
  it('clears secrets before making the recovery HTTP request', async () => {
    const owned = ownedBuffers();
    const fixture = setup();
    vi.mocked(fixture.provider.recover).mockImplementation(async () => {
      owned.assertCleared();
      throw new Error('private provider detail');
    });
    await expect(createIdentityWorkflow(fixture.deps).recover(recoveryInput())).rejects.toMatchObject({code:'PROVIDER_FAILED'});
    expect(fixture.store.create).not.toHaveBeenCalled();
  });
  it.each([false,true])('clears every derived credential opening after success/failure=%s', async fails => {
    const owned = ownedBuffers();
    const identityId = deriveIdentityStorageMaterial(owned.seed).fileId;
    const openings: Buffer[] = [];
    vi.spyOn(materialCore,'deriveAttributeRandomness').mockImplementation(() => {
      const opening = Buffer.alloc(32, 5); openings.push(opening); return opening;
    });
    const fixture = setup();
    fixture.store.records.set(identityId, readyRecord({ id: identityId }));
    if (fails) vi.mocked(fixture.crypto.credential).mockImplementation(() => { throw new Error('private credential detail'); });
    const operation = createIdentityWorkflow(fixture.deps).prepareAccount({identityId,credentialNumber:0,publicKeys:{'0':PUBLIC_KEY},credentialThreshold:1,expirySeconds:NOW_MS/1000+600});
    if (fails) await expect(operation).rejects.toMatchObject({code:'CRYPTO_FAILED'});
    else await expect(operation).resolves.toHaveProperty('credDeploymentHex');
    expect(openings.length).toBeGreaterThan(0);
    for (const opening of openings) expect(opening.every(b => b === 0)).toBe(true);
    owned.assertCleared();
  });
  it('clears partial openings if a later derivation fails', async () => {
    const owned = ownedBuffers();
    const identityId = deriveIdentityStorageMaterial(owned.seed).fileId;
    const opening = Buffer.alloc(32,5);
    vi.spyOn(materialCore,'deriveAttributeRandomness').mockReturnValueOnce(opening).mockImplementation(() => {throw new Error('private opening detail');});
    const fixture = setup(); fixture.store.records.set(identityId, readyRecord({ id: identityId }));
    await expect(createIdentityWorkflow(fixture.deps).prepareAccount({identityId,credentialNumber:0,publicKeys:{'0':PUBLIC_KEY},credentialThreshold:1,expirySeconds:NOW_MS/1000+600})).rejects.toMatchObject({code:'CRYPTO_FAILED'});
    expect(opening.every(b => b === 0)).toBe(true); owned.assertCleared();
  });
  it('reports unmet device authorization without a prompt or retained native cause', async () => {
    const fixture = setup();
    fixture.device.agree.mockRejectedValue(new IdentityHardwareError('AUTHORIZATION_REQUIRED'));
    await expect(createIdentityWorkflow(fixture.deps).request(requestInput())).rejects.toMatchObject({code:'AUTHORIZATION_REQUIRED'});
    expect(fixture.store.create).not.toHaveBeenCalled();
  });
  it('wraps default SDK failures without leaking derivation inputs', async () => {
    const fixture = setup();
    delete fixture.deps.crypto;
    let failure: unknown;
    try { await createIdentityWorkflow(fixture.deps).request(requestInput()); }
    catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(IdentityWorkflowError);
    expect(failure).toHaveProperty('code','CRYPTO_FAILED');
    expect(failure).not.toHaveProperty('cause');
    expect(String(failure)).not.toContain('idCredSec');
    expect(fixture.store.create).not.toHaveBeenCalled();
    expect(fixture.device.transferred[0]!.every(b => b === 0)).toBe(true);
  });
});
