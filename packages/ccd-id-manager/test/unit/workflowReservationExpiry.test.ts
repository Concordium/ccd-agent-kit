import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';

import { createIdentityWorkflow,IdentityWorkflowError } from '../../src/core/identityWorkflow.js';
import {
awaitingRecord,
GENESIS_HASH,IDENTITY_ID,
identityObject,
NETWORK,
requestObject,setup,
SOURCE_ID,
} from '../workflowFixtures.js';

const BASE_TIME = 1_900_000_000_000;
const TIMEOUT_MS = 60_000;
const scope = {
  genesisHash: GENESIS_HASH, sourceId: SOURCE_ID, sdkNetwork: 'Testnet' as const, identityProviderIndex: 7,
};

function expiryFixture() {
  const getIdentityRequestTimeoutMs = vi.fn(async () => TIMEOUT_MS);
  const fixture = setup({
    now: () => Date.now(),
    getIdentityRequestTimeoutMs,
  });
  return {
    ...fixture,
    getIdentityRequestTimeoutMs,
    expiryStore: fixture.store,
    reserve: (identityIndex: number, mode: 'explicit' | 'used' | 'failed' = 'explicit') => (
      fixture.store.reserveIdentityIndex({ ...scope, identityIndex, mode })
    ),
  };
}

const missing = () => new IdentityWorkflowError('IDENTITY_NOT_FOUND');
const request = (identityIndex = 0) => ({ source: SOURCE_ID, identityProviderIndex: 7, identityIndex });
const statusUrl = 'https://issuer.example.test/agent-id/ctx/identity-object';

async function expiredPostFixture(statusEndpoint = statusUrl) {
  const fixture = expiryFixture();
  await fixture.reserve(2);
  const record = awaitingRecord();
  record.postIssuance = {
    status: 'created', url: 'https://verification.example/continue', statusUrl: statusEndpoint,
  };
  fixture.store.records.set(IDENTITY_ID, record);
  vi.setSystemTime(BASE_TIME + TIMEOUT_MS);
  return { fixture, record };
}

describe('identity reservation expiry reconciliation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_TIME);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('releases a definitively absent stalled pre-record reservation and reuses its index', async () => {
    const fixture = expiryFixture();
    await fixture.reserve(0);
    vi.setSystemTime(BASE_TIME + TIMEOUT_MS);
    vi.mocked(fixture.provider.recover).mockRejectedValue(missing());

    await expect(createIdentityWorkflow(fixture.deps).request(request())).resolves.toMatchObject({
      identityIndex: 0, status: 'pending', outcome: 'requested',
    });

    expect(fixture.getIdentityRequestTimeoutMs).toHaveBeenCalledWith(NETWORK);
    expect(fixture.expiryStore.resolveIdentityReservation).toHaveBeenCalledWith({
      ...scope, identityIndex: 0, reservedAt: BASE_TIME, state: 'released', expectedWorkflow: null,
    });
    expect(fixture.crypto.request).toHaveBeenCalledOnce();
  });

  it('uses the 24-hour default timeout when no timeout dependency is configured', async () => {
    const fixture = setup({ now: () => Date.now() });
    const expiryStore = fixture.store;
    await fixture.store.reserveIdentityIndex({ ...scope, identityIndex: 0, mode: 'explicit' });
    vi.setSystemTime(BASE_TIME + 86_400_000);
    vi.mocked(fixture.provider.recover).mockRejectedValue(missing());

    await expect(createIdentityWorkflow(fixture.deps).request(request())).resolves.toMatchObject({
      identityIndex: 0, outcome: 'requested',
    });

    expect(fixture.store.listExpiredIdentityReservations).toHaveBeenCalledWith(scope, BASE_TIME + 86_400_000, 86_400_000);
    expect(expiryStore.resolveIdentityReservation).toHaveBeenCalledWith({
      ...scope, identityIndex: 0, reservedAt: BASE_TIME, state: 'released', expectedWorkflow: null,
    });
  });

  it('recovers a remote hit for an expired reservation and returns it instead of issuing', async () => {
    const fixture = expiryFixture();
    await fixture.reserve(0);
    vi.setSystemTime(BASE_TIME + TIMEOUT_MS + 1);
    vi.mocked(fixture.provider.recover).mockResolvedValue(identityObject({
      ...requestObject().value, idCredPub: fixture.recovery.value.idCredPub,
    }));

    await expect(createIdentityWorkflow(fixture.deps).request(request())).resolves.toMatchObject({
      identityIndex: 0, status: 'issued', outcome: 'identity_already_exists',
    });

    expect(fixture.store.reserveIdentityIndex).toHaveBeenCalledWith({
      ...scope, identityIndex: 0, mode: 'used',
    });
    expect(fixture.expiryStore.resolveIdentityReservation).not.toHaveBeenCalled();
    expect(fixture.store.createIdentity).toHaveBeenCalledOnce();
    expect(fixture.crypto.request).not.toHaveBeenCalled();
  });

  it('retains a provider-pending reservation and does not fall back to recovery', async () => {
    const fixture = expiryFixture();
    await fixture.reserve(2);
    const record = awaitingRecord();
    record.retrievalUrl = 'https://issuer.example.test/v1/result/opaque';
    fixture.store.records.set(IDENTITY_ID, record);
    vi.setSystemTime(BASE_TIME + TIMEOUT_MS);
    vi.mocked(fixture.provider.retrieve).mockResolvedValue({ status: 'pending' });

    await expect(createIdentityWorkflow(fixture.deps).request(request(2)))
      .rejects.toMatchObject({ code: 'INDEX_UNAVAILABLE' });

    expect(fixture.provider.retrieve).toHaveBeenCalledOnce();
    expect(fixture.provider.recover).not.toHaveBeenCalled();
    expect(fixture.expiryStore.resolveIdentityReservation).not.toHaveBeenCalled();
    expect(fixture.store.records.get(IDENTITY_ID)).toMatchObject({ status: 'awaiting_verification' });
  });

  it('uses recovery absence for a timed-out POST attempt without polling or resubmitting it', async () => {
    const fixture = expiryFixture();
    await fixture.reserve(2);
    const record = awaitingRecord() as ReturnType<typeof awaitingRecord> & { postIssuance: unknown };
    record.postIssuance = {
      status: 'created', ctxId: 'ctx/opaque', url: 'https://issuer.example.test/verify', network: 'Testnet',
      expiresAt: new Date(BASE_TIME + TIMEOUT_MS * 2).toISOString(),
    };
    fixture.store.records.set(IDENTITY_ID, record);
    vi.setSystemTime(BASE_TIME + TIMEOUT_MS);
    vi.mocked(fixture.provider.recover).mockRejectedValue(missing());

    await expect(createIdentityWorkflow(fixture.deps).request(request(2))).resolves.toMatchObject({
      status: 'pending', outcome: 'requested',
    });
    expect(fixture.provider.pollIssuanceContext).not.toHaveBeenCalled();
    expect(fixture.provider.createIssuanceContext).not.toHaveBeenCalled();
    expect(fixture.provider.recover).toHaveBeenCalled();
    expect(fixture.expiryStore.resolveIdentityReservation).toHaveBeenCalledWith(expect.objectContaining({
      identityIndex: 2, state: 'released',
    }));
  });

  it('polls a timed-out POST session first and preserves its reservation while pending', async () => {
    const { fixture,record } = await expiredPostFixture();
    vi.mocked(fixture.provider.pollIssuanceContext).mockResolvedValue({ status: 'pending' });

    await expect(createIdentityWorkflow(fixture.deps).request(request(2)))
      .rejects.toMatchObject({ code: 'INDEX_UNAVAILABLE' });

    expect(fixture.provider.pollIssuanceContext).toHaveBeenCalledExactlyOnceWith(statusUrl);
    expect(fixture.provider.recover).not.toHaveBeenCalled();
    expect(fixture.provider.createIssuanceContext).not.toHaveBeenCalled();
    expect(fixture.expiryStore.resolveIdentityReservation).not.toHaveBeenCalled();
    expect(fixture.store.records.get(IDENTITY_ID)).toEqual(record);
  });

  it('binds, encrypts, and marks used a timed-out POST session that completes', async () => {
    const { fixture,record } = await expiredPostFixture();
    vi.mocked(fixture.provider.pollIssuanceContext).mockResolvedValue({
      status: 'done', identity: identityObject(record.request!.value),
    });

    await expect(createIdentityWorkflow(fixture.deps).request(request(2))).resolves.toMatchObject({
      identityId: IDENTITY_ID, status: 'issued', outcome: 'identity_already_exists',
    });

    expect(fixture.provider.recover).not.toHaveBeenCalled();
    expect(fixture.store.reserveIdentityIndex).toHaveBeenCalledWith({ ...scope, identityIndex: 2, mode: 'used' });
    expect(fixture.store.restoreIdentity).toHaveBeenCalledOnce();
    const completed = fixture.store.records.get(IDENTITY_ID);
    expect(completed).toMatchObject({ status: 'ready', identity: expect.any(Object) });
    for (const field of ['request','requestAttemptId','postIssuance','authorizationUrl','retrievalUrl','confirmedFailure']) {
      expect(completed).not.toHaveProperty(field);
    }
    expect(fixture.store.restoreIdentity).toHaveBeenCalledWith(
      expect.any(Object), IDENTITY_ID, expect.objectContaining({ workflow: expect.objectContaining({ status: 'ready' }) }),
      expect.any(Object), expect.any(Uint8Array), expect.objectContaining({ request: record.request,
        postIssuance: record.postIssuance }),
    );
    expect(fixture.store.restoreIdentity.mock.calls[0]![5]).not.toHaveProperty('requestAttemptId');
  });

  it('preserves a timed-out POST reservation on provider-reported session error', async () => {
    const { fixture,record } = await expiredPostFixture();
    vi.mocked(fixture.provider.pollIssuanceContext).mockResolvedValue({ status: 'error', failure: 'key_failed' });

    await expect(createIdentityWorkflow(fixture.deps).request(request(2)))
      .rejects.toMatchObject({ code: 'DISCOVERY_INCOMPLETE' });

    expect(fixture.provider.recover).not.toHaveBeenCalled();
    expect(fixture.expiryStore.resolveIdentityReservation).not.toHaveBeenCalled();
    expect(fixture.store.save).not.toHaveBeenCalled();
    expect(fixture.store.records.get(IDENTITY_ID)).toEqual(record);
  });

  it('preserves a timed-out POST reservation when session polling fails', async () => {
    const { fixture,record } = await expiredPostFixture();
    vi.mocked(fixture.provider.pollIssuanceContext).mockRejectedValue(new Error('private provider failure'));

    await expect(createIdentityWorkflow(fixture.deps).request(request(2)))
      .rejects.toMatchObject({ code: 'DISCOVERY_INCOMPLETE' });

    expect(fixture.provider.recover).not.toHaveBeenCalled();
    expect(fixture.expiryStore.resolveIdentityReservation).not.toHaveBeenCalled();
    expect(fixture.store.records.get(IDENTITY_ID)).toEqual(record);
  });

  it.each([
    'https://other.example/agent-id/ctx/identity-object',
    'https://issuer.example.test/not-agent-id/ctx/identity-object',
    'https://issuer.example.test/agent-id/ctx/identity-object?token=secret',
  ])('rejects an invalid timed-out POST status endpoint without network or reservation changes: %s', async (endpoint) => {
    const { fixture,record } = await expiredPostFixture(endpoint);

    await expect(createIdentityWorkflow(fixture.deps).request(request(2)))
      .rejects.toMatchObject({ code: 'DISCOVERY_INCOMPLETE' });

    expect(fixture.provider.pollIssuanceContext).not.toHaveBeenCalled();
    expect(fixture.provider.recover).not.toHaveBeenCalled();
    expect(fixture.expiryStore.resolveIdentityReservation).not.toHaveBeenCalled();
    expect(fixture.store.records.get(IDENTITY_ID)).toEqual(record);
  });

  it('completes a timed-out POST attempt through recovery GET', async () => {
    const fixture = expiryFixture();
    await fixture.reserve(2);
    const record = awaitingRecord() as ReturnType<typeof awaitingRecord> & { postIssuance: unknown };
    record.postIssuance = {
      status: 'created', ctxId: 'ctx', url: 'https://issuer.example.test/verify', network: 'Testnet',
      expiresAt: new Date(BASE_TIME + TIMEOUT_MS * 2).toISOString(),
    };
    fixture.store.records.set(IDENTITY_ID, record);
    vi.setSystemTime(BASE_TIME + TIMEOUT_MS);
    vi.mocked(fixture.provider.recover).mockResolvedValue(identityObject({
      ...record.request!.value, idCredPub: fixture.recovery.value.idCredPub,
    }));

    await expect(createIdentityWorkflow(fixture.deps).request(request(2))).resolves.toMatchObject({
      status: 'issued', outcome: 'identity_already_exists',
    });
    expect(fixture.provider.pollIssuanceContext).not.toHaveBeenCalled();
    expect(fixture.provider.recover).toHaveBeenCalledOnce();
  });

  it('retains a POST reservation when recovery is inconclusive', async () => {
    const fixture = expiryFixture();
    await fixture.reserve(2);
    const record = awaitingRecord();
    record.postIssuance = {
      status: 'created', ctxId: 'ctx', url: 'https://issuer.example.test/verify', network: 'Testnet',
      expiresAt: new Date(BASE_TIME + TIMEOUT_MS * 2).toISOString(),
    };
    fixture.store.records.set(IDENTITY_ID, record);
    vi.setSystemTime(BASE_TIME + TIMEOUT_MS);
    vi.mocked(fixture.provider.recover).mockRejectedValue(new Error('provider unavailable'));

    await expect(createIdentityWorkflow(fixture.deps).request(request(2)))
      .rejects.toMatchObject({ code: 'DISCOVERY_INCOMPLETE' });
    expect(fixture.expiryStore.resolveIdentityReservation).not.toHaveBeenCalled();
    expect(fixture.provider.pollIssuanceContext).not.toHaveBeenCalled();
  });

  it('ignores historical POST context expiry and releases only after recovery absence', async () => {
    const fixture = expiryFixture();
    await fixture.reserve(2);
    const record = awaitingRecord() as ReturnType<typeof awaitingRecord> & { postIssuance: unknown };
    record.postIssuance = {
      status: 'created', ctxId: 'ctx', url: 'https://issuer.example.test/verify', network: 'Testnet',
      expiresAt: new Date(BASE_TIME + TIMEOUT_MS - 1).toISOString(),
    };
    fixture.store.records.set(IDENTITY_ID, record);
    vi.setSystemTime(BASE_TIME + TIMEOUT_MS);
    vi.mocked(fixture.provider.recover).mockRejectedValue(missing());

    await expect(createIdentityWorkflow(fixture.deps).request(request(2))).resolves.toMatchObject({
      status: 'pending', outcome: 'requested',
    });
    expect(fixture.provider.pollIssuanceContext).not.toHaveBeenCalled();
    expect(fixture.provider.recover).toHaveBeenCalled();
    expect(fixture.expiryStore.resolveIdentityReservation).toHaveBeenCalledWith(expect.objectContaining({
      identityIndex: 2, state: 'released', expectedWorkflow: expect.objectContaining({
        postIssuance: expect.objectContaining({ status: 'created', ctxId: 'ctx' }),
      }),
    }));
  });

  it('marks an explicit provider key failure permanently failed while preserving local pins', async () => {
    const fixture = expiryFixture();
    await fixture.reserve(2);
    const record = awaitingRecord();
    record.requestAttemptId = '018f47a2-43d2-7ad9-8b5e-89d810f95a22';
    record.retrievalUrl = 'https://issuer.example.test/v1/result/opaque';
    const pins = {
      sourceId: record.sourceId, selection: structuredClone(record.selection),
      contextHash: record.contextHash, idCredPub: record.idCredPub,
    };
    fixture.store.records.set(IDENTITY_ID, record);
    vi.setSystemTime(BASE_TIME + TIMEOUT_MS + 1);
    vi.mocked(fixture.provider.retrieve).mockResolvedValue({ status: 'error', failure: 'key_failed' });

    await expect(createIdentityWorkflow(fixture.deps).request(request(2)))
      .rejects.toMatchObject({ code: 'INDEX_UNAVAILABLE' });

    expect(fixture.store.save).toHaveBeenCalledWith(expect.objectContaining({
      status: 'error', confirmedFailure: {
        kind: 'authenticated_key_failure', requestAttemptId: record.requestAttemptId,
      },
    }),
      expect.objectContaining({ status: 'awaiting_verification' }), 'failed');
    expect([...fixture.store.reservations.values()][0]?.get(2)).toMatchObject({ state: 'failed' });
    expect(fixture.provider.recover).not.toHaveBeenCalled();
    expect(fixture.store.records.get(IDENTITY_ID)).toMatchObject({ ...pins, status: 'error' });
  });

  it('retains an unbound failure without treating it as permanent or trying absence recovery', async () => {
    const fixture = expiryFixture();
    await fixture.reserve(2);
    const record = awaitingRecord();
    record.retrievalUrl = 'https://issuer.example.test/v1/result/opaque';
    fixture.store.records.set(IDENTITY_ID, record);
    vi.setSystemTime(BASE_TIME + TIMEOUT_MS);
    vi.mocked(fixture.provider.retrieve).mockResolvedValue({ status: 'error', failure: 'unconfirmed' });

    await expect(createIdentityWorkflow(fixture.deps).request(request(2)))
      .rejects.toMatchObject({ code: 'DISCOVERY_INCOMPLETE' });

    expect(fixture.provider.recover).not.toHaveBeenCalled();
    expect(fixture.expiryStore.resolveIdentityReservation).not.toHaveBeenCalled();
    await expect(fixture.store.listExpiredIdentityReservations(scope, Date.now(), TIMEOUT_MS))
      .resolves.toEqual([{ identityIndex: 2, reservedAt: BASE_TIME }]);
    expect(fixture.store.records.get(IDENTITY_ID)).toEqual(record);
  });

  it('persists a completed retrieval for an expired request and returns the ready identity', async () => {
    const fixture = expiryFixture();
    await fixture.reserve(2);
    const record = awaitingRecord();
    record.retrievalUrl = 'https://issuer.example.test/v1/result/opaque';
    fixture.store.records.set(IDENTITY_ID, record);
    vi.setSystemTime(BASE_TIME + TIMEOUT_MS);
    vi.mocked(fixture.provider.retrieve).mockResolvedValue({
      status: 'done', identity: identityObject(record.request!.value),
    });

    await expect(createIdentityWorkflow(fixture.deps).request(request(2))).resolves.toMatchObject({
      identityId: IDENTITY_ID, status: 'issued', outcome: 'identity_already_exists',
    });

    expect(fixture.store.reserveIdentityIndex).toHaveBeenCalledWith({
      ...scope, identityIndex: 2, mode: 'used',
    });
    expect(fixture.expiryStore.resolveIdentityReservation).not.toHaveBeenCalled();
    const completed = fixture.store.records.get(IDENTITY_ID);
    expect(completed).toMatchObject({ status: 'ready', identity: expect.any(Object) });
    for (const field of ['request','requestAttemptId','postIssuance','authorizationUrl','retrievalUrl','confirmedFailure']) {
      expect(completed).not.toHaveProperty(field);
    }
    expect(fixture.provider.recover).not.toHaveBeenCalled();
    expect(fixture.crypto.request).not.toHaveBeenCalled();
  });

  it('reuses a definitively absent historical request without replacing its source or context pins', async () => {
    const fixture = expiryFixture();
    await fixture.reserve(2);
    const record = awaitingRecord();
    record.retrievalUrl = 'https://issuer.example.test/v1/result/opaque';
    const pins = {
      sourceId: record.sourceId, selection: structuredClone(record.selection),
      contextHash: record.contextHash, idCredPub: record.idCredPub,
    };
    fixture.store.records.set(IDENTITY_ID, record);
    vi.setSystemTime(BASE_TIME + TIMEOUT_MS + 1);
    vi.mocked(fixture.provider.retrieve).mockResolvedValue({ status: 'error' });
    vi.mocked(fixture.provider.recover).mockRejectedValue(missing());

    await expect(createIdentityWorkflow(fixture.deps).request(request(2))).resolves.toMatchObject({
      identityId: IDENTITY_ID, status: 'pending', outcome: 'requested',
    });

    expect(fixture.provider.retrieve).toHaveBeenCalledOnce();
    expect(fixture.provider.recover).toHaveBeenCalled();
    expect(fixture.store.records.get(IDENTITY_ID)).toMatchObject({ ...pins, status: 'awaiting_verification' });
    expect(fixture.expiryStore.resolveIdentityReservation).toHaveBeenCalledWith({
      ...scope, identityIndex: 2, reservedAt: BASE_TIME, state: 'released',
      expectedWorkflow: {
        status: 'awaiting_verification', contextHash: record.contextHash,
        idCredPub: record.idCredPub, request: record.request, retrievalUrl: record.retrievalUrl,
      },
    });
  });

  it('retains an expired reservation when recovery is ambiguous', async () => {
    const fixture = expiryFixture();
    await fixture.reserve(0);
    vi.setSystemTime(BASE_TIME + TIMEOUT_MS + 1);
    vi.mocked(fixture.provider.recover).mockRejectedValue(new Error('private network detail'));

    await expect(createIdentityWorkflow(fixture.deps).request(request()))
      .rejects.toMatchObject({ code: 'DISCOVERY_INCOMPLETE' });

    expect(fixture.expiryStore.resolveIdentityReservation).not.toHaveBeenCalled();
    expect(fixture.crypto.request).not.toHaveBeenCalled();
  });

  it('retains an expired reservation when its stored retrieval origin is no longer trusted', async () => {
    const fixture = expiryFixture();
    await fixture.reserve(2);
    const record = awaitingRecord();
    record.retrievalUrl = 'https://attacker.example/result';
    fixture.store.records.set(IDENTITY_ID, record);
    vi.setSystemTime(BASE_TIME + TIMEOUT_MS + 1);

    await expect(createIdentityWorkflow(fixture.deps).request(request(2)))
      .rejects.toMatchObject({ code: 'DISCOVERY_INCOMPLETE' });

    expect(fixture.provider.retrieve).not.toHaveBeenCalled();
    expect(fixture.provider.recover).not.toHaveBeenCalled();
    expect(fixture.expiryStore.resolveIdentityReservation).not.toHaveBeenCalled();
    expect(fixture.store.records.get(IDENTITY_ID)).toEqual(record);
  });

  it('preserves an authorization failure while reconciling an expired reservation', async () => {
    const fixture = expiryFixture();
    await fixture.reserve(0);
    vi.setSystemTime(BASE_TIME + TIMEOUT_MS + 1);
    fixture.device.agree.mockRejectedValueOnce(new Error('hardware unavailable'));

    await expect(createIdentityWorkflow(fixture.deps).request(request()))
      .rejects.toMatchObject({ code: 'CRYPTO_FAILED' });

    expect(fixture.expiryStore.resolveIdentityReservation).not.toHaveBeenCalled();
    expect(fixture.crypto.request).not.toHaveBeenCalled();
  });

  it('continues after a stale reservation compare-and-swap and reconciles later rows', async () => {
    const fixture = expiryFixture();
    await fixture.reserve(0);
    await fixture.reserve(1);
    vi.setSystemTime(BASE_TIME + TIMEOUT_MS + 1);
    vi.mocked(fixture.provider.recover).mockRejectedValue(missing());
    fixture.expiryStore.resolveIdentityReservation
      .mockRejectedValueOnce(new IdentityWorkflowError('INDEX_UNAVAILABLE'));

    await expect(createIdentityWorkflow(fixture.deps).request(request()))
      .rejects.toMatchObject({ code: 'INDEX_UNAVAILABLE' });

    expect(fixture.expiryStore.resolveIdentityReservation).toHaveBeenCalledTimes(2);
    expect(fixture.expiryStore.resolveIdentityReservation).toHaveBeenLastCalledWith({
      ...scope, identityIndex: 1, reservedAt: BASE_TIME, state: 'released', expectedWorkflow: null,
    });
    expect(fixture.crypto.request).not.toHaveBeenCalled();
  });

  it('does not probe a reservation before its timeout', async () => {
    const fixture = expiryFixture();
    await fixture.reserve(0);
    vi.setSystemTime(BASE_TIME + TIMEOUT_MS - 1);

    await expect(createIdentityWorkflow(fixture.deps).request(request()))
      .rejects.toMatchObject({ code: 'INDEX_UNAVAILABLE' });

    expect(fixture.provider.retrieve).not.toHaveBeenCalled();
    expect(fixture.provider.recover).not.toHaveBeenCalled();
    expect(fixture.expiryStore.resolveIdentityReservation).not.toHaveBeenCalled();
  });

  it.each(['used', 'failed'] as const)('never resets a permanent %s reservation after the timeout', async (state) => {
    const fixture = expiryFixture();
    await fixture.reserve(0, state);
    vi.setSystemTime(BASE_TIME + TIMEOUT_MS * 10);

    await expect(createIdentityWorkflow(fixture.deps).request(request()))
      .rejects.toMatchObject({ code: 'INDEX_UNAVAILABLE' });

    expect(fixture.provider.retrieve).not.toHaveBeenCalled();
    expect(fixture.provider.recover).not.toHaveBeenCalled();
    expect(fixture.expiryStore.resolveIdentityReservation).not.toHaveBeenCalled();
  });
});
