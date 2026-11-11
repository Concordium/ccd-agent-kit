import { describe,expect,it,vi } from 'vitest';
import { createIdentityWorkflow } from '../../src/core/identityWorkflow.js';
import type { IdentityWorkflowDependencies } from '../../src/core/workflowTypes.js';
import {
IDENTITY_ID,SOURCE_ID,context,contextFingerprint,historicalSelection,identityObject,readyRecord,
recoveryInput,
requestObject,selection,
setup,
} from '../workflowFixtures.js';

const startInput = () => recoveryInput();

describe('deterministic identity recovery persistence', () => {
  it('recreates the same opaque identity file when registry and credentials survive file loss', async () => {
    const fixture = setup();
    const existing = readyRecord();
    fixture.store.records.set(IDENTITY_ID, existing);
    const credentials = {
      version: 1,
      credentials: {
        ['aa'.repeat(48)]: { identityId: IDENTITY_ID, credentialNumber: 0, status: 'confirmed' },
        ['bb'.repeat(48)]: {
          identityId: IDENTITY_ID, credentialNumber: 1, status: 'pending',
          expectedAccountAddress: 'account-expected', expirySeconds: 1_800_000_600,
        },
      },
    };
    const restoreIdentity = vi.fn(async () => undefined);
    const loadIdentity = vi.fn(async () => { throw Object.assign(new Error('missing'), { code: 'IDENTITY_FILE_MISSING' }); });
    const loadCredentials = vi.fn(async () => structuredClone(credentials));
    Object.assign(fixture.store, { restoreIdentity, loadIdentity, loadCredentials });
    vi.mocked(fixture.provider.recover).mockResolvedValue(identityObject({
      ...requestObject().value, idCredPub: fixture.recovery.value.idCredPub,
    }));

    const result = await createIdentityWorkflow(fixture.deps).recover(startInput());
    expect(result.identityId).toBe(IDENTITY_ID);
    expect(fixture.store.create).not.toHaveBeenCalled();
    expect(restoreIdentity).toHaveBeenCalledWith(
      expect.objectContaining({ caip2: selection().network, sdkNetwork: 'Testnet' }),
      IDENTITY_ID,
      expect.anything(),
      expect.anything(),
      expect.any(Buffer),
      expect.objectContaining({ status: 'ready', contextHash: existing.contextHash, idCredPub: existing.idCredPub }),
    );
    expect(await loadCredentials()).toEqual(credentials);
    expect(fixture.sources.createAgreement).toHaveBeenCalledOnce();
  });

  it('treats an old walletProxyUrl as inert metadata and preserves all surviving recovery state', async () => {
    const fixture = setup();
    const existing = readyRecord({ selection: historicalSelection() });
    const original = structuredClone(existing);
    fixture.store.records.set(IDENTITY_ID, existing);
    fixture.store.loadIdentity.mockRejectedValue(Object.assign(new Error('missing'), { code: 'IDENTITY_FILE_MISSING' }));
    const credentials = { version: 1 as const, credentials: {
      ['aa'.repeat(48)]: { identityId: IDENTITY_ID, credentialNumber: 0, status: 'confirmed' as const },
    } };
    fixture.store.loadCredentials.mockResolvedValue(structuredClone(credentials));
    vi.mocked(fixture.provider.recover).mockResolvedValue(identityObject({
      ...requestObject().value, idCredPub: fixture.recovery.value.idCredPub,
    }));

    await expect(createIdentityWorkflow(fixture.deps).recover(startInput())).resolves.toMatchObject({
      identityId: IDENTITY_ID, status: 'issued',
    });
    expect(fixture.store.restoreIdentity).toHaveBeenCalledOnce();
    const restored = fixture.store.restoreIdentity.mock.calls[0]![2];
    expect(restored.selection.walletProxyUrl).toBe(original.selection.walletProxyUrl);
    expect(restored.workflow).toMatchObject({
      status: 'ready', contextHash: original.contextHash, idCredPub: original.idCredPub,
    });
    for (const field of ['request','requestAttemptId','postIssuance','authorizationUrl','retrievalUrl','confirmedFailure']) {
      expect(restored.workflow).not.toHaveProperty(field);
    }
    expect(await fixture.store.loadCredentials(selection().network)).toEqual(credentials);
    expect(fixture.store.createIdentity).not.toHaveBeenCalled();
  });

  it('does not replace an existing decryptable deterministic identity', async () => {
    const fixture = setup();
    fixture.store.records.set(IDENTITY_ID, readyRecord());
    const loadIdentity = vi.fn(async () => readyRecord().identity);
    const restoreIdentity = vi.fn();
    Object.assign(fixture.store, { loadIdentity, restoreIdentity });
    await expect(createIdentityWorkflow(fixture.deps).recover(startInput())).rejects.toMatchObject({
      code: 'IDENTITY_ALREADY_EXISTS',
    });
    expect(fixture.provider.recover).not.toHaveBeenCalled();
    expect(restoreIdentity).not.toHaveBeenCalled();
    expect(fixture.store.records.get(IDENTITY_ID)).toEqual(readyRecord());
  });

  it('returns a normal ready summary when issuance targets an existing local identity', async () => {
    const fixture = setup();
    const existing = readyRecord();
    fixture.store.records.set(IDENTITY_ID, existing);

    await expect(createIdentityWorkflow(fixture.deps).request({
      source: SOURCE_ID, identityProviderIndex: existing.selection.identityProviderIndex,
      identityIndex: existing.selection.identityIndex,
    })).resolves.toMatchObject({
      identityId: IDENTITY_ID, status: 'issued', outcome: 'identity_already_exists',
    });

    expect(fixture.provider.recover).not.toHaveBeenCalled();
    expect(fixture.crypto.request).not.toHaveBeenCalled();
    expect(fixture.store.createIdentity).not.toHaveBeenCalled();
    expect(fixture.store.records.get(IDENTITY_ID)).toEqual(existing);
    for (const field of ['request','requestAttemptId','postIssuance','authorizationUrl','retrievalUrl','confirmedFailure']) {
      expect(existing).not.toHaveProperty(field);
    }
  });

  it('reuses an encrypted ready identity without requiring an in-memory identity attachment', async () => {
    const fixture = setup();
    const encrypted = readyRecord().identity!;
    const existing = readyRecord({ label: 'OperatorLabel' });
    delete existing.identity;
    fixture.store.records.set(IDENTITY_ID, existing);
    fixture.store.loadIdentity.mockResolvedValue(encrypted);

    await expect(createIdentityWorkflow(fixture.deps).request({
      source: SOURCE_ID, identityProviderIndex: existing.selection.identityProviderIndex,
      identityIndex: existing.selection.identityIndex,
    })).resolves.toMatchObject({
      identityId: IDENTITY_ID, status: 'issued', outcome: 'identity_already_exists', label: 'OperatorLabel',
    });

    expect(fixture.store.loadIdentity).toHaveBeenCalledOnce();
    expect(fixture.provider.recover).not.toHaveBeenCalled();
    expect(fixture.store.createIdentity).not.toHaveBeenCalled();
    expect(fixture.store.restoreIdentity).not.toHaveBeenCalled();
    expect(fixture.store.records.get(IDENTITY_ID)).toEqual(existing);
  });

  it('labels a newly issued identity as requested', async () => {
    const fixture = setup();

    await expect(createIdentityWorkflow(fixture.deps).request({
      source: SOURCE_ID,
      identityProviderIndex: 7, identityIndex: 2,
    })).resolves.toMatchObject({
      status: 'pending', outcome: 'requested',
    });
  });

  it('creates a new network index entry when no deterministic identity state exists', async () => {
    const fixture = setup();
    const bootstrapNetwork = vi.fn(async () => undefined);
    Object.assign(fixture.store, { bootstrapNetwork });
    vi.mocked(fixture.provider.recover).mockResolvedValue(identityObject({
      ...requestObject().value, idCredPub: fixture.recovery.value.idCredPub,
    }));
    const workflow = createIdentityWorkflow(fixture.deps as unknown as IdentityWorkflowDependencies);
    await expect(workflow.recover(startInput())).resolves.toMatchObject({ identityId: IDENTITY_ID, status: 'issued' });
    expect(bootstrapNetwork).toHaveBeenCalledWith(expect.objectContaining({
      caip2: selection().network, genesisHash: expect.stringMatching(/^[0-9a-f]{64}$/), sdkNetwork: 'Testnet',
    }));
    expect(fixture.store.createIdentity).toHaveBeenCalledOnce();
  });

  it('serves list and status metadata without device agreement or identity decryption', async () => {
    const fixture = setup();
    fixture.store.records.set(IDENTITY_ID, readyRecord());
    const loadIdentity = vi.fn(async () => { throw new Error('must not decrypt'); });
    Object.assign(fixture.store, { loadIdentity });
    const workflow = createIdentityWorkflow(fixture.deps);
    await expect(workflow.list({})).resolves.toHaveLength(1);
    await expect(workflow.status({ identityId: IDENTITY_ID })).resolves.toMatchObject({ status: 'issued' });
    expect(fixture.deps.resolveNetwork).toHaveBeenCalledTimes(2);
    expect(fixture.store.list).toHaveBeenCalledWith(selection().network);
    expect(fixture.store.load).toHaveBeenCalledWith(selection().network, IDENTITY_ID);
    expect(fixture.sources.createAgreement).not.toHaveBeenCalled();
    expect(fixture.deps.loadContext).not.toHaveBeenCalled();
    expect(fixture.provider.retrieve).not.toHaveBeenCalled();
    expect(fixture.provider.recover).not.toHaveBeenCalled();
    expect(loadIdentity).not.toHaveBeenCalled();
  });

  it('rejects recovery when surviving registry selection differs from the derived context', async () => {
    const fixture = setup();
    const existing = readyRecord();
    existing.selection = { ...existing.selection, identityIndex: existing.selection.identityIndex + 1 };
    fixture.store.records.set(IDENTITY_ID, existing);
    const original = structuredClone(existing);
    fixture.store.loadIdentity.mockRejectedValue(Object.assign(new Error('missing'), { code: 'IDENTITY_FILE_MISSING' }));
    vi.mocked(fixture.provider.recover).mockResolvedValue(identityObject({
      ...requestObject().value, idCredPub: fixture.recovery.value.idCredPub,
    }));
    await expect(createIdentityWorkflow(fixture.deps).recover(startInput())).rejects.toMatchObject({ code: 'CONTEXT_MISMATCH' });
    expect(fixture.provider.recover).not.toHaveBeenCalled();
    expect(fixture.store.restoreIdentity).not.toHaveBeenCalled();
    expect(fixture.store.createIdentity).not.toHaveBeenCalled();
    expect(fixture.store.records.get(IDENTITY_ID)).toEqual(original);
  });

  it('rejects a changed recovered credential identity before restoring surviving state', async () => {
    const fixture = setup();
    const existing = readyRecord();
    fixture.store.records.set(IDENTITY_ID, existing);
    fixture.store.loadIdentity.mockRejectedValue(Object.assign(new Error('missing'), { code: 'IDENTITY_FILE_MISSING' }));
    vi.mocked(fixture.crypto.recovery).mockReturnValue({
      ...fixture.recovery,
      value: { ...fixture.recovery.value, idCredPub: 'cd'.repeat(48) },
    });
    await expect(createIdentityWorkflow(fixture.deps).recover(startInput()))
      .rejects.toMatchObject({ code: 'CONTEXT_MISMATCH' });
    expect(fixture.provider.recover).not.toHaveBeenCalled();
    expect(fixture.store.restoreIdentity).not.toHaveBeenCalled();
  });

  it('rejects recovery pinned to an old AR subset before provider HTTP or record mutation', async () => {
    const current = context();
    const oldSubset = context({ arsInfos: { 1: current.arsInfos[1]!, 2: current.arsInfos[2]! } });
    const fixture = setup();
    const existing = readyRecord({ contextHash: contextFingerprint(oldSubset) });
    const original = structuredClone(existing);
    fixture.store.records.set(IDENTITY_ID, existing);
    fixture.store.loadIdentity.mockRejectedValue(Object.assign(new Error('missing'), { code: 'IDENTITY_FILE_MISSING' }));

    await expect(createIdentityWorkflow(fixture.deps).recover(startInput()))
      .rejects.toMatchObject({ code: 'CONTEXT_MISMATCH' });

    expect(fixture.provider.recover).not.toHaveBeenCalled();
    expect(fixture.store.restoreIdentity).not.toHaveBeenCalled();
    expect(fixture.store.createIdentity).not.toHaveBeenCalled();
    expect(fixture.store.save).not.toHaveBeenCalled();
    expect(fixture.store.records.get(IDENTITY_ID)).toEqual(original);
  });

  it.each([
    ['global parameters', context({ globalContext: { ...context().globalContext, genesisString: 'changed' } })],
    ['anonymity revoker', context({ arsInfos: {
      ...context().arsInfos,
      1: { ...context().arsInfos[1]!, arPublicKey: 'fe'.repeat(96) },
    } })],
    ['issuance endpoint', context({ issuanceUrl: 'https://changed.example/issue' })],
  ])('rejects changed %s before recovery HTTP and preserves surviving historical state', async (_name, currentContext) => {
    const fixture = setup({ loadContext: vi.fn(async () => currentContext) });
    const existing = readyRecord({ selection: historicalSelection() });
    const originalRecord = structuredClone(existing);
    const credentials = { version: 1 as const, credentials: {
      ['aa'.repeat(48)]: { identityId: IDENTITY_ID, credentialNumber: 0, status: 'confirmed' as const },
    } };
    fixture.store.records.set(IDENTITY_ID, existing);
    fixture.store.credentials.set('aa'.repeat(48), credentials.credentials['aa'.repeat(48)]!);
    fixture.store.loadIdentity.mockRejectedValue(Object.assign(new Error('missing'), { code: 'IDENTITY_FILE_MISSING' }));
    const originalIndex = await fixture.store.readIndex(selection().network);

    await expect(createIdentityWorkflow(fixture.deps).recover(startInput()))
      .rejects.toMatchObject({ code: 'CONTEXT_MISMATCH' });

    expect(fixture.provider.recover).not.toHaveBeenCalled();
    expect(fixture.store.restoreIdentity).not.toHaveBeenCalled();
    expect(fixture.store.createIdentity).not.toHaveBeenCalled();
    expect(fixture.store.records.get(IDENTITY_ID)).toEqual(originalRecord);
    expect(fixture.store.records.get(IDENTITY_ID)!.contextHash).toBe(originalRecord.contextHash);
    await expect(fixture.store.readIndex(selection().network)).resolves.toEqual(originalIndex);
    await expect(fixture.store.loadCredentials(selection().network)).resolves.toEqual(credentials);
  });
});
