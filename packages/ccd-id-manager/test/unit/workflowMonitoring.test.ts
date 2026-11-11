import { describe,expect,it,vi } from 'vitest';

import { createIdentityWorkflow } from '../../src/core/identityWorkflow.js';
import { IdentityWorkflowError } from '../../src/core/workflowErrors.js';
import type { IdentityStore,StoredIdentity } from '../../src/core/workflowTypes.js';
import {
GENESIS_HASH,IDENTITY_ID,NETWORK,SOURCE_ID,awaitingRecord,identityObject,readyRecord,setup,
} from '../workflowFixtures.js';

const ATTEMPT = '018f47a2-43d2-7ad9-8b5e-89d810f95a22';
const OTHER_ATTEMPT = '018f47a2-43d2-7ad9-8b5e-89d810f95a23';
const NOW = 1_900_000_000_000;
const scope = {
  genesisHash: GENESIS_HASH, sourceId: SOURCE_ID, sdkNetwork: 'Testnet' as const,
  identityProviderIndex: 7, identityIndex: 2,
};

function monitoringFixture(record: StoredIdentity = { ...awaitingRecord(), requestAttemptId: ATTEMPT }) {
  const fixture = setup({ now: () => NOW, getIdentityRequestTimeoutMs: vi.fn(async () => 86_400_000) });
  fixture.store.records.set(IDENTITY_ID, structuredClone(record));
  const readIdentityRequestReservation = vi.fn<IdentityStore['readIdentityRequestReservation']>(
    async () => ({ state: 'reserved', reservedAt: NOW }),
  );
  Object.assign(fixture.store, { readIdentityRequestReservation });
  return { ...fixture, readIdentityRequestReservation };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function expectIssuedShape(record: unknown) {
  expect(record).toMatchObject({ status: 'ready', identity: expect.any(Object) });
  for (const field of ['request','requestAttemptId','postIssuance','authorizationUrl','retrievalUrl','confirmedFailure']) {
    expect(record).not.toHaveProperty(field);
  }
}

describe('identity public status projection', () => {
  it.each([
    ['awaiting_verification', 'pending'],
    ['pending', 'pending'],
    ['ready', 'issued'],
    ['error', 'unknown'],
    ['expired', 'unknown'],
  ] as const)('projects persisted %s as public %s without rewriting internal state', async (internal, publicStatus) => {
    const record: StoredIdentity = internal === 'ready'
      ? readyRecord()
      : { ...awaitingRecord(), status: internal };
    const fixture = monitoringFixture(record);
    const result = await createIdentityWorkflow(fixture.deps).status({ identityId: IDENTITY_ID });
    expect(result.status).toBe(publicStatus);
    expect(fixture.store.records.get(IDENTITY_ID)?.status).toBe(internal);
  });

  it('projects an attempt-bound authenticated key failure as failed', async () => {
    const record = {
      ...awaitingRecord(), status: 'error' as const, requestAttemptId: ATTEMPT,
      confirmedFailure: { kind: 'authenticated_key_failure' as const, requestAttemptId: ATTEMPT },
    };
    const fixture = monitoringFixture(record);
    fixture.readIdentityRequestReservation.mockResolvedValue({ state: 'failed', reservedAt: NOW });
    await expect(createIdentityWorkflow(fixture.deps).status({ identityId: IDENTITY_ID }))
      .resolves.toMatchObject({ status: 'failed' });
  });

  it('keeps an active generic error pending while its attempt-bound reservation is within deadline', async () => {
    const record = { ...awaitingRecord(), status: 'error' as const, requestAttemptId: ATTEMPT };
    const fixture = monitoringFixture(record);
    fixture.readIdentityRequestReservation.mockResolvedValue({ state: 'reserved', reservedAt: NOW - 5_000 });
    await expect(createIdentityWorkflow(fixture.deps).status({ identityId: IDENTITY_ID }))
      .resolves.toMatchObject({ status: 'pending' });
    expect(fixture.store.records.get(IDENTITY_ID)).toEqual(record);
  });

  it('projects an attempt-bound generic error with non-active reservation provenance as unknown', async () => {
    const record = { ...awaitingRecord(), status: 'error' as const, requestAttemptId: ATTEMPT };
    const fixture = monitoringFixture(record);
    fixture.readIdentityRequestReservation.mockResolvedValue({ state: 'released', reservedAt: NOW - 5_000 });
    await expect(createIdentityWorkflow(fixture.deps).status({ identityId: IDENTITY_ID }))
      .resolves.toMatchObject({ status: 'unknown' });
  });

  it.each(['awaiting_verification', 'error'] as const)(
    'projects a deadline-passed %s attempt with partially persisted used reservation as unknown', async (status) => {
    const fixture = monitoringFixture({ ...awaitingRecord(), status, requestAttemptId: ATTEMPT });
    fixture.readIdentityRequestReservation.mockResolvedValue({
      state: 'used', reservedAt: NOW - 86_400_000,
    });
    await expect(createIdentityWorkflow(fixture.deps).status({ identityId: IDENTITY_ID }))
      .resolves.toMatchObject({ status: 'unknown' });
    expect(fixture.store.resolveIdentityReservation).not.toHaveBeenCalled();
    },
  );

  it('keeps a used generic-error attempt pending before deadline and can retry it to issued', async () => {
    const record = { ...awaitingRecord(), status: 'error' as const, requestAttemptId: ATTEMPT };
    const fixture = monitoringFixture(record);
    fixture.readIdentityRequestReservation.mockResolvedValue({ state: 'used', reservedAt: NOW - 5_000 });
    vi.mocked(fixture.provider.recover).mockResolvedValue(identityObject(record.request!.value));
    await expect(createIdentityWorkflow(fixture.deps).monitorIdentity({
      network: NETWORK, identityId: IDENTITY_ID, expectedAttemptId: ATTEMPT,
    })).resolves.toMatchObject({ status: 'issued' });
    expect(fixture.store.records.get(IDENTITY_ID)).toMatchObject({ status: 'ready' });
    expect(fixture.readIdentityRequestReservation).toHaveBeenCalled();
  });

  it('projects a deadline-passed non-ready attempt as unknown without expiring or releasing it', async () => {
    const fixture = monitoringFixture();
    fixture.readIdentityRequestReservation.mockResolvedValue({
      state: 'reserved', reservedAt: NOW - 86_400_000,
    });
    await expect(createIdentityWorkflow(fixture.deps).status({ identityId: IDENTITY_ID }))
      .resolves.toMatchObject({ status: 'unknown' });
    expect(fixture.store.records.get(IDENTITY_ID)?.status).toBe('awaiting_verification');
    expect(fixture.store.resolveIdentityReservation).not.toHaveBeenCalled();
    expect(fixture.readIdentityRequestReservation).toHaveBeenCalledWith(scope);
  });

  it('uses the 24-hour projection deadline when no timeout dependency is configured', async () => {
    const fixture = monitoringFixture();
    delete fixture.deps.getIdentityRequestTimeoutMs;
    fixture.readIdentityRequestReservation.mockResolvedValue({
      state: 'reserved', reservedAt: NOW - 86_400_000,
    });
    await expect(createIdentityWorkflow(fixture.deps).status({ identityId: IDENTITY_ID }))
      .resolves.toMatchObject({ status: 'unknown' });
  });

  it('exposes authorization URLs only on pending summaries', async () => {
    const get = monitoringFixture({
      ...awaitingRecord(), requestAttemptId: ATTEMPT,
      authorizationUrl: 'https://issuer.example/verify',
    } as StoredIdentity);
    await expect(createIdentityWorkflow(get.deps).status({ identityId: IDENTITY_ID })).resolves.toMatchObject({
      status: 'pending', authorizationUrl: 'https://issuer.example/verify',
    });

    const issued = monitoringFixture(readyRecord());
    const summary = await createIdentityWorkflow(issued.deps).status({ identityId: IDENTITY_ID });
    expect(summary.status).toBe('issued');
    expect(summary).not.toHaveProperty('authorizationUrl');
  });
});

describe('monitorIdentity recovery checks', () => {
  it('rejects an invalid identity ID before storage or provider access', async () => {
    const fixture = monitoringFixture();
    await expect(createIdentityWorkflow(fixture.deps).monitorIdentity({
      network: NETWORK, identityId: '../private', expectedAttemptId: ATTEMPT,
    })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(fixture.store.load).not.toHaveBeenCalled();
    expect(fixture.provider.recover).not.toHaveBeenCalled();
  });

  it.each([
    ['GET attempt', undefined],
    ['POST attempt', { status: 'created', url: 'https://verification.example/continue' }],
    ['historical POST attempt', {
      status: 'created', url: 'https://verification.example/continue', ctxId: 'old',
      network: 'Testnet', expiresAt: '2026-10-17T00:00:00.000Z',
    }],
  ] as const)('keeps configured recovery GET for a legacy %s without a status URL', async (_name, postIssuance) => {
    const record = { ...awaitingRecord(), requestAttemptId: ATTEMPT,
      ...(postIssuance === undefined ? {} : { postIssuance }) } as StoredIdentity;
    const fixture = monitoringFixture(record);
    vi.mocked(fixture.provider.recover).mockRejectedValue(new IdentityWorkflowError('IDENTITY_NOT_FOUND'));

    await expect(createIdentityWorkflow(fixture.deps).monitorIdentity({
      network: NETWORK, identityId: IDENTITY_ID, expectedAttemptId: ATTEMPT,
    })).resolves.toMatchObject({ status: 'pending' });
    expect(fixture.provider.recover).toHaveBeenCalledOnce();
    expect(fixture.provider.retrieve).not.toHaveBeenCalled();
    expect(fixture.provider.pollIssuanceContext).not.toHaveBeenCalled();
    expect(fixture.provider.createIssuanceContext).not.toHaveBeenCalled();
  });

  it.each([
    ['GET attempt', undefined],
    ['POST attempt', { status: 'created', url: 'https://verification.example/continue' }],
  ] as const)('allows explicit status to complete an issued %s after the monitor deadline', async (_name, postIssuance) => {
    const record = {
      ...awaitingRecord(), requestAttemptId: ATTEMPT,
      ...(postIssuance === undefined ? {} : { postIssuance }),
    } as StoredIdentity;
    const explicit = monitoringFixture(record);
    explicit.readIdentityRequestReservation.mockResolvedValue({
      state: 'reserved', reservedAt: NOW - 86_400_000,
    });
    vi.mocked(explicit.provider.recover).mockResolvedValue(identityObject(record.request!.value));
    await expect(createIdentityWorkflow(explicit.deps).status({ identityId: IDENTITY_ID }))
      .resolves.toMatchObject({ status: 'issued' });
    expect(explicit.provider.recover).toHaveBeenCalledOnce();

    const background = monitoringFixture(record);
    background.readIdentityRequestReservation.mockResolvedValue({
      state: 'reserved', reservedAt: NOW - 86_400_000,
    });
    await expect(createIdentityWorkflow(background.deps).monitorIdentity({
      network: NETWORK, identityId: IDENTITY_ID, expectedAttemptId: ATTEMPT,
    })).resolves.toMatchObject({ status: 'unknown' });
    expect(background.provider.recover).not.toHaveBeenCalled();
    expect(background.sources.createAgreement).not.toHaveBeenCalled();
  });

  it('persists a valid recovered identity through the existing encrypted conditional completion path', async () => {
    const fixture = monitoringFixture();
    const record = fixture.store.records.get(IDENTITY_ID)!;
    fixture.readIdentityRequestReservation.mockResolvedValue({ state: 'used', reservedAt: NOW });
    vi.mocked(fixture.provider.recover).mockResolvedValue(identityObject(record.request!.value));
    await expect(createIdentityWorkflow(fixture.deps).monitorIdentity({
      network: NETWORK, identityId: IDENTITY_ID, expectedAttemptId: ATTEMPT,
    })).resolves.toMatchObject({ status: 'issued' });
    expect(fixture.store.createIdentity).toHaveBeenCalledWith(
      expect.objectContaining({ caip2: NETWORK }), IDENTITY_ID, expect.any(Object),
      expect.any(Object), expect.any(Uint8Array), expect.objectContaining({ requestAttemptId: ATTEMPT }),
    );
    expectIssuedShape(fixture.store.records.get(IDENTITY_ID));
    const [, , completed, , , observed] = fixture.store.createIdentity.mock.calls[0]!;
    expect(completed.workflow).toMatchObject({ status: 'ready' });
    expect(observed).toMatchObject({ status: 'awaiting_verification', requestAttemptId: ATTEMPT,
      request: expect.any(Object) });
    for (const field of ['request','requestAttemptId','postIssuance','authorizationUrl','retrievalUrl','confirmedFailure']) {
      expect(completed.workflow).not.toHaveProperty(field);
    }
  });

  it('monitor polls a new POST attempt status URL and persists a completed identity', async () => {
    const statusUrl = 'https://issuer.example.test/agent-id/context/identity-object';
    const record = { ...awaitingRecord(), requestAttemptId: ATTEMPT, postIssuance: {
      status: 'created' as const, url: 'https://verification.example/continue', statusUrl,
    } };
    const fixture = monitoringFixture(record);
    vi.mocked(fixture.provider.pollIssuanceContext).mockResolvedValue({
      status: 'done', identity: identityObject(record.request!.value),
    });

    await expect(createIdentityWorkflow(fixture.deps).monitorIdentity({
      network: NETWORK, identityId: IDENTITY_ID, expectedAttemptId: ATTEMPT,
    })).resolves.toMatchObject({ status: 'issued' });
    expect(fixture.provider.pollIssuanceContext).toHaveBeenCalledExactlyOnceWith(statusUrl);
    expect(fixture.provider.recover).not.toHaveBeenCalled();
    expectIssuedShape(fixture.store.records.get(IDENTITY_ID));
  });

  it('rejects monitor completion when the derived storage identity differs from the selected record', async () => {
    const otherId = 'ab'.repeat(32);
    const record = { ...awaitingRecord(), id: otherId, requestAttemptId: ATTEMPT };
    const fixture = monitoringFixture(record);
    fixture.store.records.set(otherId, record);
    vi.mocked(fixture.provider.recover).mockResolvedValue(identityObject(record.request!.value));
    await expect(createIdentityWorkflow(fixture.deps).monitorIdentity({
      network: NETWORK, identityId: otherId, expectedAttemptId: ATTEMPT,
    })).rejects.toMatchObject({ code: 'IDENTITY_MISMATCH' });
    expect(fixture.store.createIdentity).not.toHaveBeenCalled();
  });

  it('treats generic provider and locked-source failures as inconclusive and preserves durable state', async () => {
    for (const configure of [
      (fixture: ReturnType<typeof monitoringFixture>) => vi.mocked(fixture.provider.recover)
        .mockRejectedValue(new Error('private provider endpoint')),
      (fixture: ReturnType<typeof monitoringFixture>) => vi.mocked(fixture.sources.createAgreement)
        .mockRejectedValue(new Error('PIN required for /private/device')),
    ]) {
      const fixture = monitoringFixture();
      const original = structuredClone(fixture.store.records.get(IDENTITY_ID));
      configure(fixture);
      await expect(createIdentityWorkflow(fixture.deps).monitorIdentity({
        network: NETWORK, identityId: IDENTITY_ID, expectedAttemptId: ATTEMPT,
      })).rejects.toBeInstanceOf(Error);
      expect(fixture.store.records.get(IDENTITY_ID)).toEqual(original);
      expect(fixture.store.save).not.toHaveBeenCalled();
      expect(fixture.store.resolveIdentityReservation).not.toHaveBeenCalled();
    }
  });

  it('rejects stale and late completions without changing the newer attempt or reservation', async () => {
    const fixture = monitoringFixture();
    const recovery = deferred<ReturnType<typeof identityObject>>();
    vi.mocked(fixture.provider.recover).mockReturnValue(recovery.promise);
    const operation = createIdentityWorkflow(fixture.deps).monitorIdentity({
      network: NETWORK, identityId: IDENTITY_ID, expectedAttemptId: ATTEMPT,
    });
    await vi.waitFor(() => expect(fixture.provider.recover).toHaveBeenCalledOnce());
    const current = fixture.store.records.get(IDENTITY_ID)!;
    if (current.status === 'ready') throw new Error('expected lifecycle record');
    const newer = { ...current, requestAttemptId: OTHER_ATTEMPT };
    fixture.store.records.set(IDENTITY_ID, newer);
    recovery.resolve(identityObject(newer.request!.value));
    await expect(operation).rejects.toMatchObject({ code: 'INDEX_UNAVAILABLE' });
    expect(fixture.store.records.get(IDENTITY_ID)).toEqual(newer);
    expect(fixture.store.resolveIdentityReservation).not.toHaveBeenCalled();
  });

  it('does no provider or hardware work when the expected attempt is already stale', async () => {
    const fixture = monitoringFixture({ ...awaitingRecord(), requestAttemptId: OTHER_ATTEMPT });
    await expect(createIdentityWorkflow(fixture.deps).monitorIdentity({
      network: NETWORK, identityId: IDENTITY_ID, expectedAttemptId: ATTEMPT,
    })).rejects.toMatchObject({ code: 'INDEX_UNAVAILABLE' });
    expect(fixture.provider.recover).not.toHaveBeenCalled();
    expect(fixture.sources.createAgreement).not.toHaveBeenCalled();
  });
});
