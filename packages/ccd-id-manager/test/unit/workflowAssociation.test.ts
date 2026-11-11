import { describe,expect,it,vi } from 'vitest';

import { createIdentityWorkflow,IdentityWorkflowError } from '../../src/core/identityWorkflow.js';
import {
GENESIS_HASH,
IDENTITY_ID,
  NETWORK,
  awaitingRecord,
readyRecord,
selection,
setup,
SOURCE_ID,
} from '../workflowFixtures.js';

function historicalRecord() {
  const record = readyRecord({ selection: { ...selection(), device: '12345678' } });
  delete (record as typeof record & { sourceId?: string }).sourceId;
  return record;
}

describe('historical identity source association', () => {
  it('projects only the safe source id through associated list and status summaries', async () => {
    const fixture = setup();
    fixture.store.records.set(IDENTITY_ID, readyRecord());
    const workflow = createIdentityWorkflow(fixture.deps);

    const listed = await workflow.list({});
    const status = await workflow.status({ identityId: IDENTITY_ID });

    expect(listed[0]).toMatchObject({ sourceId: SOURCE_ID });
    expect(status).toMatchObject({ sourceId: SOURCE_ID });
    expect(JSON.stringify({ listed, status })).not.toMatch(/rootPublicKey|device|locator|fingerprint/i);
  });

  it('reserves the known-used index then adds only sourceId to the existing record', async () => {
    const fixture = setup();
    const record = historicalRecord();
    record.selection.walletProxyUrl = 'https://historical.example.test/proxy';
    fixture.store.records.set(IDENTITY_ID, record);
    const before = structuredClone(record);
    const order: string[] = [];
    fixture.store.reserveIdentityIndex.mockImplementationOnce(async () => { order.push('reserve'); });
    fixture.store.save.mockImplementationOnce(async (updated) => {
      order.push('save');
      fixture.store.records.set(updated.id, structuredClone(updated));
    });

    const result = await createIdentityWorkflow(fixture.deps).associateIdentitySource({
      identityId: IDENTITY_ID, source: SOURCE_ID,
    });

    expect(result).toEqual({
      identityId: IDENTITY_ID, network: NETWORK,
      identityProviderIndex: selection().identityProviderIndex,
      identityIndex: selection().identityIndex, status: 'issued', sourceId: SOURCE_ID,
    });
    expect(order).toEqual(['reserve', 'save']);
    expect(fixture.store.reserveIdentityIndex).toHaveBeenCalledWith({
      genesisHash: GENESIS_HASH, sourceId: SOURCE_ID, sdkNetwork: 'Testnet', identityProviderIndex: 7,
      identityIndex: 2, mode: 'used',
    });
    expect(fixture.store.records.get(IDENTITY_ID)).toEqual({ ...before, sourceId: SOURCE_ID });
    expect(fixture.store.loadIdentity).toHaveBeenCalledOnce();
    expect(fixture.deps.loadContext).toHaveBeenCalledOnce();
  });

  it('preserves authenticated failure provenance while associating a historical record', async () => {
    const fixture = setup();
    const attempt = '018f47a2-43d2-7ad9-8b5e-89d810f95a22';
    const record = historicalRecord();
    Object.assign(record, {
      status: 'error', requestAttemptId: attempt,
      confirmedFailure: { kind: 'authenticated_key_failure', requestAttemptId: attempt },
    });
    fixture.store.records.set(IDENTITY_ID, record);

    await expect(createIdentityWorkflow(fixture.deps).associateIdentitySource({
      identityId: IDENTITY_ID, source: SOURCE_ID,
    })).resolves.toMatchObject({ status: 'failed', sourceId: SOURCE_ID });
    expect(fixture.store.records.get(IDENTITY_ID)).toMatchObject({
      status: 'error', sourceId: SOURCE_ID,
      confirmedFailure: { kind: 'authenticated_key_failure', requestAttemptId: attempt },
    });
  });

  it('associates trusted historical metadata when its encrypted identity file is missing', async () => {
    const fixture = setup();
    const record = { ...awaitingRecord(), status: 'pending' as const,
      selection: { ...selection(), device: '12345678' } };
    delete (record as typeof record & { sourceId?: string }).sourceId;
    fixture.store.records.set(IDENTITY_ID, record);
    fixture.store.loadIdentity.mockRejectedValueOnce(new IdentityWorkflowError('IDENTITY_FILE_MISSING'));

    await expect(createIdentityWorkflow(fixture.deps).associateIdentitySource({
      identityId: IDENTITY_ID, source: SOURCE_ID,
    })).resolves.toMatchObject({ sourceId: SOURCE_ID, status: 'pending' });
    expect(fixture.crypto.recovery).toHaveBeenCalledOnce();
    expect(fixture.store.records.get(IDENTITY_ID)).toEqual({ ...record, sourceId: SOURCE_ID });
    expect(fixture.store.reserveIdentityIndex).not.toHaveBeenCalled();
  });

  it('rejects missing-ciphertext association when derived recovery binding differs', async () => {
    const fixture = setup();
    const record = historicalRecord();
    delete record.identity;
    fixture.store.records.set(IDENTITY_ID, record);
    fixture.store.loadIdentity.mockRejectedValueOnce(new IdentityWorkflowError('IDENTITY_FILE_MISSING'));
    vi.mocked(fixture.crypto.recovery).mockReturnValue({
      ...fixture.recovery, value: { ...fixture.recovery.value, idCredPub: 'ff'.repeat(48) },
    });

    await expect(createIdentityWorkflow(fixture.deps).associateIdentitySource({
      identityId: IDENTITY_ID, source: SOURCE_ID,
    })).rejects.toMatchObject({ code: 'ASSOCIATION_MISMATCH' });
    expect(fixture.store.reserveIdentityIndex).not.toHaveBeenCalled();
    expect(fixture.store.save).not.toHaveBeenCalled();
  });

  it.each([
    ['root pin', () => ({ rootPublicKey: '04' + '11'.repeat(64) })],
    ['historical locator', () => ({ device: '99999999' })],
  ])('rejects a mismatched %s without reservation or record mutation', async (_label, sourcePatch) => {
    const fixture = setup();
    const record = historicalRecord();
    fixture.store.records.set(IDENTITY_ID, record);
    const patch = sourcePatch() as { rootPublicKey?: string; device?: string };
    vi.mocked(fixture.sources.resolve).mockResolvedValue({
      ...await fixture.sources.resolve(SOURCE_ID),
      ...patch,
      backends: [{ backend: 'yubikey-piv', locations: [{ serial: patch.device ?? '12345678' }] }],
    } as never);

    await expect(createIdentityWorkflow(fixture.deps).associateIdentitySource({
      identityId: IDENTITY_ID, source: SOURCE_ID,
    })).rejects.toMatchObject({ code: 'ASSOCIATION_MISMATCH' });
    expect(fixture.store.reserveIdentityIndex).not.toHaveBeenCalled();
    expect(fixture.store.save).not.toHaveBeenCalled();
    expect(fixture.store.records.get(IDENTITY_ID)).toEqual(record);
  });

  it('preserves the unassociated record when the post-reservation save fails', async () => {
    const fixture = setup();
    const record = historicalRecord();
    fixture.store.records.set(IDENTITY_ID, record);
    fixture.store.save.mockRejectedValueOnce(new Error('private storage path'));

    await expect(createIdentityWorkflow(fixture.deps).associateIdentitySource({
      identityId: IDENTITY_ID, source: SOURCE_ID,
    })).rejects.toMatchObject({ code: 'STORAGE_FAILED' });
    expect(fixture.store.reserveIdentityIndex).toHaveBeenCalledOnce();
    expect(fixture.store.records.get(IDENTITY_ID)).toEqual(record);
  });

  it.each(['deterministic identity id', 'fresh context'] as const)(
    'refuses association when the %s does not match',
    async (mismatch) => {
      const fixture = setup();
      const record = historicalRecord();
      if (mismatch === 'deterministic identity id') record.id = 'ff'.repeat(32);
      else record.contextHash = 'ff'.repeat(32);
      fixture.store.records.set(record.id, record);

      await expect(createIdentityWorkflow(fixture.deps).associateIdentitySource({
        identityId: record.id, source: SOURCE_ID,
      })).rejects.toMatchObject({ code: 'ASSOCIATION_MISMATCH' });
      expect(fixture.store.reserveIdentityIndex).not.toHaveBeenCalled();
      expect(fixture.store.save).not.toHaveBeenCalled();
      expect(fixture.store.records.get(record.id)).toEqual(record);
    },
  );

  it('rejects already-associated records without deriving or rewriting them', async () => {
    const fixture = setup();
    fixture.store.records.set(IDENTITY_ID, readyRecord());

    await expect(createIdentityWorkflow(fixture.deps).associateIdentitySource({
      identityId: IDENTITY_ID, source: SOURCE_ID,
    })).rejects.toMatchObject({ code: 'ASSOCIATION_MISMATCH' });
    expect(fixture.sources.createAgreement).not.toHaveBeenCalled();
    expect(fixture.store.reserveIdentityIndex).not.toHaveBeenCalled();
    expect(fixture.store.save).not.toHaveBeenCalled();
  });

  it('maps identity-source resolution failure to association mismatch without mutation', async () => {
    const fixture = setup();
    const record = historicalRecord();
    fixture.store.records.set(IDENTITY_ID, record);
    vi.mocked(fixture.sources.resolve).mockRejectedValueOnce(new Error('private source catalog failure'));

    await expect(createIdentityWorkflow(fixture.deps).associateIdentitySource({
      identityId: IDENTITY_ID, source: SOURCE_ID,
    })).rejects.toMatchObject({ code: 'ASSOCIATION_MISMATCH' });

    expect(fixture.store.records.get(IDENTITY_ID)).toEqual(record);
    expect(fixture.sources.createAgreement).not.toHaveBeenCalled();
    expect(fixture.store.reserveIdentityIndex).not.toHaveBeenCalled();
    expect(fixture.store.save).not.toHaveBeenCalled();
  });

  it('keeps list, ready status, and reconciliation readable for historical unassociated records', async () => {
    const fixture = setup();
    fixture.store.records.set(IDENTITY_ID, historicalRecord());
    const workflow = createIdentityWorkflow(fixture.deps);

    await expect(workflow.list({})).resolves.toHaveLength(1);
    await expect(workflow.status({ identityId: IDENTITY_ID })).resolves.toMatchObject({ status: 'issued' });
    expect((await workflow.list({}))[0]).not.toHaveProperty('sourceId');
    expect(await workflow.status({ identityId: IDENTITY_ID })).not.toHaveProperty('sourceId');
    await expect(workflow.reconcileAccountOpening({ identityId: IDENTITY_ID }))
      .resolves.toMatchObject({ status: 'no_pending' });
    expect(fixture.sources.createAgreement).not.toHaveBeenCalled();
  });

  it.each(['discoverAccountCredentials', 'prepareAccount'] as const)(
    'requires association before %s can derive from a historical record',
    async (operation) => {
      const fixture = setup();
      fixture.store.records.set(IDENTITY_ID, historicalRecord());
      const workflow = createIdentityWorkflow(fixture.deps);
      const pending = operation === 'discoverAccountCredentials'
        ? workflow.discoverAccountCredentials({ identityId: IDENTITY_ID })
        : workflow.prepareAccount({
          identityId: IDENTITY_ID, publicKeys: { '0': 'e6e387ecae9f68f3547da5546bf02d1ee071a7efb95a2e53781c9b482ef3d8e1' }, credentialThreshold: 1,
          expirySeconds: 1_800_000_000 + 600,
        });

      await expect(pending).rejects.toMatchObject({ code: 'SOURCE_NOT_ASSOCIATED' });
      expect(fixture.sources.createAgreement).not.toHaveBeenCalled();
      expect(fixture.crypto.credential).not.toHaveBeenCalled();
    },
  );
});
