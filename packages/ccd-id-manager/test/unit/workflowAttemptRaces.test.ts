import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
import { createIdentityWorkflow,IdentityWorkflowError } from '../../src/core/identityWorkflow.js';
import type { IdentityRetrieval } from '../../src/core/workflowTypes.js';
import {
awaitingRecord,
GENESIS_HASH,IDENTITY_ID,
identityObject,readyRecord,setup,
SOURCE_ID,
} from '../workflowFixtures.js';

const BASE_TIME = 1_900_000_000_000;
const scope = { genesisHash: GENESIS_HASH, sourceId: SOURCE_ID, sdkNetwork: 'Testnet' as const, identityProviderIndex: 7 };
const requestInput = { source: SOURCE_ID, identityProviderIndex: 7, identityIndex: 2 };
const callback = `ccd-id-manager://identity/${IDENTITY_ID}#code_uri=${encodeURIComponent('https://issuer.example.test/result/old')}`;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe('identity request attempt concurrency', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(BASE_TIME); });
  afterEach(() => vi.useRealTimers());

  it('does not release a request whose callback became pending during the absence check', async () => {
    const fixture = setup({ now: () => Date.now(), getIdentityRequestTimeoutMs: async () => 60_000 });
    fixture.store.records.set(IDENTITY_ID, awaitingRecord());
    await fixture.store.listExpiredIdentityReservations(scope, BASE_TIME, 60_000);
    vi.setSystemTime(BASE_TIME + 60_000);
    const started = deferred<void>();
    const absence = deferred<never>();
    vi.mocked(fixture.provider.recover).mockImplementation(async () => { started.resolve(); return absence.promise; });
    const workflow = createIdentityWorkflow(fixture.deps);
    const issuance = workflow.request(requestInput);
    const rejected = expect(issuance).rejects.toMatchObject({ code: 'INDEX_UNAVAILABLE' });
    await started.promise;
    await workflow.status({ identityId: IDENTITY_ID, callbackUrl: callback });
    absence.reject(new IdentityWorkflowError('IDENTITY_NOT_FOUND'));
    await rejected;
    expect(fixture.store.records.get(IDENTITY_ID)).toMatchObject({ status: 'pending', retrievalUrl: 'https://issuer.example.test/result/old' });
    await expect(fixture.store.listIdentityReservations(scope)).resolves.toContain(2);
    expect(fixture.crypto.request).not.toHaveBeenCalled();
  });

  it.each(['pending', 'done', 'failed'] as const)('does not let a late %s callback overwrite or consume a retried request', async (state) => {
    const fixture = setup({ now: () => Date.now(), getIdentityRequestTimeoutMs: async () => 60_000 });
    const original = awaitingRecord();
    fixture.store.records.set(IDENTITY_ID, original);
    await fixture.store.listExpiredIdentityReservations(scope, BASE_TIME, 60_000);
    vi.setSystemTime(BASE_TIME + 60_000);
    const started = deferred<void>();
    const response = deferred<IdentityRetrieval>();
    vi.mocked(fixture.provider.retrieve).mockImplementation(async () => { started.resolve(); return response.promise; });
    const workflow = createIdentityWorkflow(fixture.deps);
    const status = workflow.status({ identityId: IDENTITY_ID, callbackUrl: callback });
    const rejected = expect(status).rejects.toMatchObject({ code: 'INDEX_UNAVAILABLE' });
    await started.promise;
    await expect(workflow.request(requestInput)).resolves.toMatchObject({ outcome: 'requested' });
    const retried = structuredClone(fixture.store.records.get(IDENTITY_ID)!);
    const reservations = structuredClone(fixture.store.reservations);
    response.resolve(state === 'done' ? { status: 'done', identity: identityObject(original.request!.value) }
      : state === 'failed' ? { status: 'error', failure: 'key_failed' } : { status: 'pending' });
    await rejected;
    expect(retried).toHaveProperty('requestAttemptId');
    expect(fixture.store.records.get(IDENTITY_ID)).toEqual(retried);
    expect(retried).not.toHaveProperty('retrievalUrl');
    expect(fixture.store.reservations).toEqual(reservations);
  });

  it('promotes recovered metadata without rewriting surviving ciphertext', async () => {
    const fixture = setup();
    const identity = readyRecord().identity!;
    const original = { ...awaitingRecord(), status: 'error' as const };
    fixture.store.records.set(IDENTITY_ID, original);
    fixture.store.loadIdentity.mockResolvedValue(identity);
    vi.mocked(fixture.provider.recover).mockResolvedValue(identity);
    const result = await createIdentityWorkflow(fixture.deps).discoverIdentities({
      source: SOURCE_ID, identityProviderIndex: 7, startIndex: 2, endIndex: 2,
    });
    expect(result.streams[0]).toMatchObject({ used: [2], partial: false });
    expect(fixture.store.records.get(IDENTITY_ID)).toEqual(expect.objectContaining({ status: 'ready', identity }));
    expect(fixture.store.records.get(IDENTITY_ID)).not.toHaveProperty('request');
    expect(fixture.store.createIdentity).not.toHaveBeenCalled();
    expect(fixture.store.restoreIdentity).not.toHaveBeenCalled();
  });

  it('retires an expired attempt before reuse so an in-flight pending callback cannot revive it', async () => {
    const fixture = setup({ now: () => Date.now(), getIdentityRequestTimeoutMs: async () => 60_000 });
    const original = awaitingRecord();
    fixture.store.records.set(IDENTITY_ID, original);
    await fixture.store.listExpiredIdentityReservations(scope, BASE_TIME, 60_000);
    vi.setSystemTime(BASE_TIME + 60_000);
    const started = deferred<void>();
    const response = deferred<IdentityRetrieval>();
    vi.mocked(fixture.provider.retrieve).mockImplementation(async () => { started.resolve(); return response.promise; });
    const workflow = createIdentityWorkflow(fixture.deps);
    const status = workflow.status({ identityId: IDENTITY_ID, callbackUrl: callback });
    const rejected = expect(status).rejects.toMatchObject({ code: 'INDEX_UNAVAILABLE' });
    await started.promise;

    await workflow.discoverIdentities({ source: SOURCE_ID, identityProviderIndex: 7, endIndex: 2 });
    response.resolve({ status: 'pending' });
    await rejected;

    expect(fixture.store.records.get(IDENTITY_ID)).toEqual({ ...original, status: 'expired' });
    const retired = await workflow.status({ identityId: IDENTITY_ID });
    expect(retired).toMatchObject({ status: 'unknown' });
    expect(retired).not.toHaveProperty('authorizationUrl');
    await expect(fixture.store.listIdentityReservations(scope)).resolves.not.toContain(2);
    await expect(workflow.request(requestInput)).resolves.toMatchObject({ outcome: 'requested' });
  });
});
