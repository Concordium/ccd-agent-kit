import { describe,expect,it,vi } from 'vitest';
import { createIdentityWorkflow,identityContextHash } from '../../src/core/identityWorkflow.js';
import { IdentityWorkflowError } from '../../src/core/workflowErrors.js';
import type { StoredIdentity } from '../../src/core/workflowTypes.js';
import {
  IDENTITY_ID,NOW_MS,SOURCE_ID,awaitingRecord,context,identityObject,requestInput,setup,
} from '../workflowFixtures.js';

const postContext = () => context({
  issuance: { method: 'POST' },
});
const statusUrl = 'https://issuer.example.test/agent-id/context%2Fwith%20spaces/identity-object';
const attemptId = '018f47a2-43d2-7ad9-8b5e-89d810f95a22';
const created = {
  ctxId: 'context/with spaces',
  url: 'https://issuer.example.test/verify/context',
  statusUrl,
  network: 'Testnet' as const,
  expiresAt: new Date(NOW_MS + 60_000).toISOString(),
};

function postRecord(state: 'unconfirmed' | 'created' = 'created'): StoredIdentity {
  const record = awaitingRecord() as StoredIdentity & { postIssuance?: unknown };
  record.requestAttemptId = attemptId;
  record.postIssuance = state === 'unconfirmed'
    ? { status: 'unconfirmed' }
    : { status: 'created', url: created.url, ctxId: created.ctxId,
      network: created.network, expiresAt: created.expiresAt };
  return record;
}

function expectIssuedShape(record: unknown) {
  expect(record).toMatchObject({ status: 'ready', identity: expect.any(Object) });
  for (const field of ['request','requestAttemptId','postIssuance','authorizationUrl','retrievalUrl','confirmedFailure']) {
    expect(record).not.toHaveProperty(field);
  }
}

describe('POST identity issuance workflow', () => {
  it('durably saves unconfirmed before POST, then saves validated creation by complete-workflow CAS', async () => {
    const fixture = setup({ loadContext: vi.fn(async () => postContext()) });
    const order: string[] = [];
    fixture.store.create.mockImplementationOnce(async (record) => {
      order.push('unconfirmed');
      fixture.store.records.set(record.id, structuredClone(record));
    });
    vi.mocked(fixture.provider.createIssuanceContext).mockImplementationOnce(async () => {
      order.push('post');
      expect(fixture.store.records.get(IDENTITY_ID)).toMatchObject({
        status: 'awaiting_verification', postIssuance: { status: 'unconfirmed' },
      });
      return created;
    });
    fixture.store.save.mockImplementationOnce(async (record) => {
      order.push('created');
      fixture.store.records.set(record.id, structuredClone(record));
    });

    await expect(createIdentityWorkflow(fixture.deps).request(requestInput())).resolves.toMatchObject({
      identityId: IDENTITY_ID,
      status: 'pending',
      authorizationUrl: created.url,
    });

    expect(order).toEqual(['unconfirmed', 'post', 'created']);
    expect(fixture.provider.createIssuanceContext).toHaveBeenCalledExactlyOnceWith(
      context().issuanceUrl, fixture.request, context().network,
    );
    expect(fixture.store.create).toHaveBeenCalledWith(expect.objectContaining({
      postIssuance: { status: 'unconfirmed' },
    }));
    expect(fixture.store.save).toHaveBeenCalledWith(
      expect.objectContaining({ postIssuance: { status: 'created', url: created.url, statusUrl } }),
      expect.objectContaining({ postIssuance: { status: 'unconfirmed' } }),
    );
    expect(fixture.provider.recover).toHaveBeenCalledOnce();
    expect(fixture.provider.retrieve).not.toHaveBeenCalled();
  });

  it('retains unconfirmed durable state after POST transport failure and never retries implicitly', async () => {
    const fixture = setup({ loadContext: vi.fn(async () => postContext()) });
    vi.mocked(fixture.provider.createIssuanceContext).mockRejectedValue(new Error('private provider failure'));

    await expect(createIdentityWorkflow(fixture.deps).request(requestInput()))
      .rejects.toMatchObject({ code: 'PROVIDER_FAILED' });
    expect(fixture.store.records.get(IDENTITY_ID)).toMatchObject({ postIssuance: { status: 'unconfirmed' } });
    expect(fixture.store.save).not.toHaveBeenCalled();

    await expect(createIdentityWorkflow(fixture.deps).status({ identityId: IDENTITY_ID }))
      .rejects.toMatchObject({ code: 'PROVIDER_FAILED' });
    expect(fixture.provider.createIssuanceContext).toHaveBeenCalledOnce();
    expect(fixture.provider.pollIssuanceContext).not.toHaveBeenCalled();
    expect(fixture.provider.retrieve).not.toHaveBeenCalled();
  });

  it('retains unconfirmed state when creation persistence loses its compare-and-swap race', async () => {
    const fixture = setup({ loadContext: vi.fn(async () => postContext()) });
    fixture.store.save.mockRejectedValueOnce(new IdentityWorkflowError('INDEX_UNAVAILABLE'));

    await expect(createIdentityWorkflow(fixture.deps).request(requestInput()))
      .rejects.toMatchObject({ code: 'INDEX_UNAVAILABLE' });
    expect(fixture.store.records.get(IDENTITY_ID)).toMatchObject({ postIssuance: { status: 'unconfirmed' } });
    expect(fixture.provider.createIssuanceContext).toHaveBeenCalledOnce();
  });

  it('accepts a cross-origin human URL while persisting its separately derived status URL', async () => {
    const fixture = setup({ loadContext: vi.fn(async () => postContext()) });
    vi.mocked(fixture.provider.createIssuanceContext).mockResolvedValue({
      url: 'https://verification.example/continue', statusUrl, extension: 'ignored',
      ctxId: '', network: 'unexpected', expiresAt: 'not-a-date',
    } as never);

    await expect(createIdentityWorkflow(fixture.deps).request(requestInput())).resolves.toMatchObject({
      status: 'pending', authorizationUrl: 'https://verification.example/continue',
    });
    expect(fixture.store.records.get(IDENTITY_ID)).toMatchObject({
      status: 'awaiting_verification', postIssuance: {
        status: 'created', url: 'https://verification.example/continue', statusUrl,
      },
    });
  });

  it('keeps historical created records without status URL on legacy recovery', async () => {
    const fixture = setup({ loadContext: vi.fn(async () => postContext()) });
    const record = postRecord();
    fixture.store.records.set(IDENTITY_ID, record);
    await expect(createIdentityWorkflow(fixture.deps).status({ identityId: IDENTITY_ID })).resolves.toMatchObject({
      status: 'pending', authorizationUrl: created.url,
    });
    expect(fixture.provider.recover).toHaveBeenCalledOnce();
    expect(fixture.provider.pollIssuanceContext).not.toHaveBeenCalled();
    expect(fixture.provider.createIssuanceContext).not.toHaveBeenCalled();
    expect(fixture.provider.retrieve).not.toHaveBeenCalled();
    expect(fixture.store.records.get(IDENTITY_ID)).toEqual(record);
  });

  it('keeps a supplied legacy callback inert for a created POST attempt', async () => {
    const fixture = setup({ loadContext: vi.fn(async () => postContext()) });
    const record = postRecord();
    fixture.store.records.set(IDENTITY_ID, record);
    const callbackUrl = `ccd-id-manager://identity/${IDENTITY_ID}#code_uri=${encodeURIComponent('https://issuer.example.test/result')}`;
    await expect(createIdentityWorkflow(fixture.deps).status({ identityId: IDENTITY_ID, callbackUrl }))
      .resolves.toMatchObject({ status: 'pending', authorizationUrl: created.url });
    expect(fixture.provider.retrieve).not.toHaveBeenCalled();
    expect(fixture.provider.pollIssuanceContext).not.toHaveBeenCalled();
  });

  it('polls the persisted status URL instead of recovery and preserves pending state', async () => {
    const fixture = setup({ loadContext: vi.fn(async () => postContext()) });
    const record = { ...awaitingRecord(), requestAttemptId: attemptId };
    record.postIssuance = { status: 'created', url: created.url, statusUrl };
    fixture.store.records.set(IDENTITY_ID, record);

    await expect(createIdentityWorkflow(fixture.deps).status({ identityId: IDENTITY_ID }))
      .resolves.toMatchObject({ status: 'pending', authorizationUrl: created.url });
    expect(fixture.provider.pollIssuanceContext).toHaveBeenCalledExactlyOnceWith(statusUrl);
    expect(fixture.provider.recover).not.toHaveBeenCalled();
    expect(fixture.store.save).not.toHaveBeenCalled();
  });

  it('binds, encrypts, and persists an identity returned by the status endpoint', async () => {
    const fixture = setup({ loadContext: vi.fn(async () => postContext()) });
    const record = { ...awaitingRecord(), requestAttemptId: attemptId };
    record.postIssuance = { status: 'created', url: created.url, statusUrl };
    fixture.store.records.set(IDENTITY_ID, record);
    vi.mocked(fixture.provider.pollIssuanceContext).mockResolvedValue({
      status: 'done', identity: identityObject(record.request!.value),
    });

    await expect(createIdentityWorkflow(fixture.deps).status({ identityId: IDENTITY_ID }))
      .resolves.toMatchObject({ status: 'issued' });
    expect(fixture.store.createIdentity).toHaveBeenCalled();
    expectIssuedShape(fixture.store.records.get(IDENTITY_ID));
    const [, , completed, , , observed] = fixture.store.createIdentity.mock.calls[0]!;
    expect(observed).toMatchObject({ status: 'awaiting_verification', request: record.request,
      requestAttemptId: attemptId, postIssuance: record.postIssuance });
    expect(completed.workflow).toEqual(expect.objectContaining({ status: 'ready', contextHash: record.contextHash,
      idCredPub: record.idCredPub }));
    expect(completed.workflow).not.toHaveProperty('request');
    expect(completed.workflow).not.toHaveProperty('postIssuance');
    expect(fixture.provider.recover).not.toHaveBeenCalled();
  });

  it.each([
    'https://other.example/agent-id/ctx/identity-object',
    'https://issuer.example.test/other/ctx/identity-object',
    'https://issuer.example.test/agent-id/ctx/identity-object?token=secret',
  ])('rejects an untrusted persisted status URL without provider access: %s', async (untrustedStatusUrl) => {
    const fixture = setup({ loadContext: vi.fn(async () => postContext()) });
    const record = { ...awaitingRecord(), requestAttemptId: attemptId };
    record.postIssuance = { status: 'created', url: created.url, statusUrl: untrustedStatusUrl };
    fixture.store.records.set(IDENTITY_ID, record);

    await expect(createIdentityWorkflow(fixture.deps).status({ identityId: IDENTITY_ID }))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(fixture.provider.pollIssuanceContext).not.toHaveBeenCalled();
    expect(fixture.provider.recover).not.toHaveBeenCalled();
  });

  it('classifies provider-reported POST error as inconclusive without persisting authenticated failure', async () => {
    const fixture = setup({ loadContext: vi.fn(async () => postContext()) });
    const record = { ...awaitingRecord(), requestAttemptId: attemptId };
    record.postIssuance = { status: 'created', url: created.url, statusUrl };
    fixture.store.records.set(IDENTITY_ID, record);
    vi.mocked(fixture.provider.pollIssuanceContext).mockResolvedValue({ status: 'error', failure: 'key_failed' });

    await expect(createIdentityWorkflow(fixture.deps).status({ identityId: IDENTITY_ID }))
      .rejects.toMatchObject({ code: 'PROVIDER_FAILED' });
    expect(fixture.store.records.get(IDENTITY_ID)).toEqual(record);
    expect(fixture.store.save).not.toHaveBeenCalled();
  });

  it('keeps records without POST state on the legacy callback flow after configuration changes', async () => {
    const fixture = setup({ loadContext: vi.fn(async () => postContext()) });
    const legacy = awaitingRecord();
    fixture.store.records.set(IDENTITY_ID, legacy);
    await expect(createIdentityWorkflow(fixture.deps).status({ identityId: IDENTITY_ID }))
      .resolves.toMatchObject({ status: 'pending' });
    expect(fixture.provider.pollIssuanceContext).not.toHaveBeenCalled();
    expect(fixture.provider.retrieve).not.toHaveBeenCalled();
  });

  it('excludes only POST transport configuration from the historical context hash', () => {
    const legacy = context();
    const withPost = postContext();
    expect(identityContextHash(withPost)).toBe(identityContextHash(legacy));
    expect(identityContextHash(context({ recoveryUrl: 'https://issuer.example.test/v2/recover' })))
      .not.toBe(identityContextHash(legacy));
  });

  it.each(['request', 'recover', 'discover'] as const)(
    'bootstraps fresh verified network state before the first occupancy read for %s',
    async (operation) => {
      const fixture = setup();
      const order: string[] = [];
      fixture.store.bootstrapNetwork.mockImplementation(async () => { order.push('bootstrap'); });
      fixture.store.listIdentityReservations.mockImplementation(async () => { order.push('occupancy'); return []; });
      vi.mocked(fixture.provider.recover).mockRejectedValue(new IdentityWorkflowError('IDENTITY_NOT_FOUND'));

      if (operation === 'request') {
        await createIdentityWorkflow(fixture.deps).request(requestInput());
      } else if (operation === 'recover') {
        await expect(createIdentityWorkflow(fixture.deps).recover(requestInput() as never))
          .rejects.toMatchObject({ code: 'IDENTITY_NOT_FOUND' });
      } else {
        await createIdentityWorkflow(fixture.deps).discoverIdentities({
          network: requestInput().network, source: requestInput().source,
          identityProviderIndex: requestInput().identityProviderIndex, startIndex: 0, endIndex: 0,
        });
      }
      expect(order[0]).toBe('bootstrap');
      expect(order).toContain('occupancy');
    },
  );

  it('returns a partial discovery stream when fresh-network bootstrap fails closed', async () => {
    const fixture = setup();
    fixture.store.bootstrapNetwork.mockRejectedValue(new Error('partial local state'));
    await expect(createIdentityWorkflow(fixture.deps).discoverIdentities({
      network: requestInput().network, source: requestInput().source,
      identityProviderIndex: requestInput().identityProviderIndex, endIndex: 0,
    })).resolves.toMatchObject({
      streams: [{ partial: true, stopReason: 'error', errorCode: 'STORAGE_FAILED' }],
    });
    expect(fixture.store.listIdentityReservations).not.toHaveBeenCalled();
  });

  it('rejects a store record whose embedded ID differs from the requested key', async () => {
    const fixture = setup();
    fixture.store.load.mockResolvedValue({ ...awaitingRecord(), id: 'ab'.repeat(32) });
    await expect(createIdentityWorkflow(fixture.deps).associateIdentitySource({
      identityId: IDENTITY_ID, source: SOURCE_ID,
    })).rejects.toMatchObject({ code: 'STORAGE_FAILED' });
    expect(fixture.sources.createAgreement).not.toHaveBeenCalled();
  });
});
