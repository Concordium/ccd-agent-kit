import { describe,expect,it,vi } from 'vitest';

import { createIdentityWorkflow,IdentityWorkflowError } from '../../src/core/identityWorkflow.js';
import {
  IDENTITY_ID,
  awaitingRecord,
identityObject,
NETWORK,
readyRecord,
requestInput,
requestObject,
setup,
SOURCE_ID,
sourceRecord,
} from '../workflowFixtures.js';

const defaultLabel = (identityIndex = 2) => `@ID-${SOURCE_ID.slice(3)}-7-${identityIndex}`;
const defaultBareLabel = (identityIndex = 2) => defaultLabel(identityIndex).slice(1);

function recoveredIdentity(fixture: ReturnType<typeof setup>) {
  return identityObject({ ...requestObject().value, idCredPub: fixture.recovery.value.idCredPub });
}

async function captureFailure(operation: () => Promise<unknown>): Promise<unknown> {
  try { await operation(); } catch (error) { return error; }
  throw new Error('Expected operation to fail');
}

describe('identity workflow labels', () => {
  it('rejects a request label mode without a label before resolving protected state', async () => {
    const fixture = setup();

    await expect(createIdentityWorkflow(fixture.deps).request({
      ...requestInput(), mode: 'hard', label: undefined,
    } as never)).rejects.toMatchObject({ code: 'INVALID_INPUT' });

    expect(fixture.sources.resolve).not.toHaveBeenCalled();
    expect(fixture.store.bootstrapNetwork).not.toHaveBeenCalled();
    expect(fixture.crypto.request).not.toHaveBeenCalled();
  });

  it('fails closed when protected state contains an ambiguous identity label', async () => {
    const fixture = setup();
    const otherId = 'ab'.repeat(32);
    fixture.store.records.set(IDENTITY_ID, readyRecord({ label: 'Duplicate' }));
    fixture.store.records.set(otherId, readyRecord({ id: otherId, label: '@duplicate' }));

    await expect(createIdentityWorkflow(fixture.deps).status({ identityId: 'duplicate' }))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' });

    expect(fixture.store.load).not.toHaveBeenCalled();
    expect(fixture.provider.recover).not.toHaveBeenCalled();
  });

  it('fails closed when label mutation encounters malformed protected label metadata', async () => {
    const fixture = setup();
    const malformed = readyRecord();
    (malformed as { label?: string }).label = 'bad label';
    fixture.store.records.set(IDENTITY_ID, malformed);

    await expect(createIdentityWorkflow(fixture.deps).setOperatorIdentityLabel({
      identityId: IDENTITY_ID, label: 'Replacement', mode: 'hard',
    })).rejects.toMatchObject({ code: 'INVALID_INPUT' });

    expect(fixture.store.setIdentityLabel).not.toHaveBeenCalled();
    expect(fixture.store.records.get(IDENTITY_ID)).toEqual(malformed);
  });

  it('treats an identical operator label assignment as an idempotent read', async () => {
    const fixture = setup();
    const existing = readyRecord({ label: 'Existing' });
    fixture.store.records.set(IDENTITY_ID, existing);

    await expect(createIdentityWorkflow(fixture.deps).setOperatorIdentityLabel({
      identityId: IDENTITY_ID, label: 'Existing', mode: 'hard',
    })).resolves.toMatchObject({ identityId: IDENTITY_ID, label: 'Existing', status: 'issued' });

    expect(fixture.store.setIdentityLabel).not.toHaveBeenCalled();
    expect(fixture.store.records.get(IDENTITY_ID)).toEqual(existing);
  });

  it('assigns the stable default to each new request and recovery record', async () => {
    const requested = setup();
    const requestedSummary = await createIdentityWorkflow(requested.deps).request(requestInput());
    expect(requestedSummary).toMatchObject({ identityId: IDENTITY_ID, label: defaultBareLabel() });
    expect(requested.store.records.get(IDENTITY_ID)).toMatchObject({ label: defaultLabel() });

    const recovered = setup();
    vi.mocked(recovered.provider.recover).mockResolvedValue(recoveredIdentity(recovered));
    const recoveredSummary = await createIdentityWorkflow(recovered.deps).recover({
      ...requestInput(), identityIndex: 2,
    });
    expect(recoveredSummary).toMatchObject({ identityId: IDENTITY_ID, label: defaultBareLabel() });
    expect(recovered.store.records.get(IDENTITY_ID)).toMatchObject({ label: defaultLabel() });
  });

  it('builds the default from the stable source id rather than its mutable label', async () => {
    const fixture = setup();
    vi.mocked(fixture.sources.resolve).mockResolvedValue({ ...sourceRecord(), label: 'renamed-source' });
    const summary = await createIdentityWorkflow(fixture.deps).request({ ...requestInput(), source: 'renamed-source' });

    expect(summary).toMatchObject({ label: defaultBareLabel() });
    expect(fixture.sources.resolve).toHaveBeenCalledWith('renamed-source');
  });

  it('assigns the default when request first finds the identity remotely and when discovery creates it', async () => {
    const remoteRequest = setup();
    vi.mocked(remoteRequest.provider.recover).mockResolvedValue(recoveredIdentity(remoteRequest));
    await expect(createIdentityWorkflow(remoteRequest.deps).request(requestInput()))
      .resolves.toMatchObject({ outcome: 'identity_already_exists', label: defaultBareLabel() });
    expect(remoteRequest.store.records.get(IDENTITY_ID)).toMatchObject({ label: defaultLabel() });

    const discovery = setup();
    vi.mocked(discovery.provider.recover).mockResolvedValueOnce(recoveredIdentity(discovery))
      .mockRejectedValue(new IdentityWorkflowError('IDENTITY_NOT_FOUND'));
    await createIdentityWorkflow(discovery.deps).discoverIdentities({
      source: SOURCE_ID, identityProviderIndex: 7, startIndex: 2, endIndex: 2,
    });
    expect(discovery.store.records.get(IDENTITY_ID)).toMatchObject({ label: defaultLabel() });
  });

  it.each([
    ['Ada', undefined, 'Ada'],
    ['agent-label', 'soft', '@agent-label'],
  ] as const)(
    'stores an approved explicit request label only on a new record: %s/%s',
    async (label, mode, stored) => {
      const fixture = setup();
      const summary = await createIdentityWorkflow(fixture.deps).request({
        ...requestInput(), label, ...(mode === undefined ? {} : { mode }),
      });
      expect(summary).toMatchObject({ label });
      expect(fixture.store.records.get(IDENTITY_ID)).toMatchObject({ label: stored });
    },
  );

  it('applies an explicit request label when the first local record is a remote recovery', async () => {
    const fixture = setup();
    vi.mocked(fixture.provider.recover).mockResolvedValue(recoveredIdentity(fixture));

    await expect(createIdentityWorkflow(fixture.deps).request({ ...requestInput(), label: 'RecoveredName' }))
      .resolves.toMatchObject({ outcome: 'identity_already_exists', label: 'RecoveredName' });
    expect(fixture.store.records.get(IDENTITY_ID)).toMatchObject({ label: 'RecoveredName' });
  });

  it.each([undefined, '@kept', 'Protected'] as const)(
    'preserves an existing %s label while recovery restores missing ciphertext',
    async (label) => {
      const fixture = setup();
      const existing = readyRecord(label === undefined ? {} : { label });
      delete existing.identity;
      fixture.store.records.set(IDENTITY_ID, existing);
      vi.mocked(fixture.provider.recover).mockResolvedValue(recoveredIdentity(fixture));

      const summary = await createIdentityWorkflow(fixture.deps).recover({ ...requestInput(), identityIndex: 2 });

      if (label === undefined) {
        expect(summary).not.toHaveProperty('label');
        expect(fixture.store.records.get(IDENTITY_ID)).not.toHaveProperty('label');
      } else {
        expect(summary).toMatchObject({ label: label.startsWith('@') ? label.slice(1) : label });
        expect(fixture.store.records.get(IDENTITY_ID)).toMatchObject({ label });
      }
    },
  );

  it.each([
    ['protected', 'ExistingName'],
    ['agent-owned', '@existing'],
    ['legacy missing label', undefined],
  ] as const)('does not relabel an existing %s record when request supplies a label', async (_case, label) => {
    const fixture = setup();
    fixture.store.records.set(IDENTITY_ID, readyRecord(label === undefined ? {} : { label }));

    const result = await createIdentityWorkflow(fixture.deps).request({
      ...requestInput(), label: 'replacement', mode: 'soft',
    });

    expect(result).toMatchObject({ outcome: 'identity_already_exists' });
    if (label === undefined) {
      expect(result).not.toHaveProperty('label');
      expect(fixture.store.records.get(IDENTITY_ID)).not.toHaveProperty('label');
    } else {
      expect(result).toMatchObject({ label: label.startsWith('@') ? label.slice(1) : label });
      expect(fixture.store.records.get(IDENTITY_ID)).toMatchObject({ label });
    }
  });

  it('keeps labels out of deterministic identity and cryptographic inputs', async () => {
    const first = setup();
    const second = setup();
    await createIdentityWorkflow(first.deps).request({ ...requestInput(), label: 'First' });
    await createIdentityWorkflow(second.deps).request({ ...requestInput(), label: 'Second', mode: 'soft' });

    expect([...first.store.records.allValues()][0]?.id).toBe([...second.store.records.allValues()][0]?.id);
    expect([...first.store.records.allValues()][0]?.contextHash).toBe([...second.store.records.allValues()][0]?.contextHash);
    expect(vi.mocked(first.crypto.request).mock.calls[0]?.[0]).toEqual(vi.mocked(second.crypto.request).mock.calls[0]?.[0]);
    expect(vi.mocked(first.sources.createAgreement).mock.calls)
      .toEqual(vi.mocked(second.sources.createAgreement).mock.calls);
  });

  it.each([undefined, '@old'] as const)('allows an agent to label an %s record and adds the marker', async (current) => {
    const fixture = setup();
    fixture.store.records.set(IDENTITY_ID, readyRecord(current === undefined ? {} : { label: current }));

    const result = await createIdentityWorkflow(fixture.deps).setAgentIdentityLabel({ identityId: IDENTITY_ID, label: 'new_label' });

    expect(result).toMatchObject({ identityId: IDENTITY_ID, label: 'new_label' });
    expect(fixture.store.setIdentityLabel).toHaveBeenCalledWith({
      network: NETWORK, identityId: IDENTITY_ID, label: '@new_label', authority: 'agent',
    });
  });

  it('delegates an explicit operator mode as the corresponding stored label', async () => {
    const fixture = setup();
    fixture.store.records.set(IDENTITY_ID, readyRecord({ label: '@Ada' }));

    await expect(createIdentityWorkflow(fixture.deps).setOperatorIdentityLabel({
      identityId: IDENTITY_ID, label: 'Ada', mode: 'hard',
    })).resolves.toMatchObject({ identityId: IDENTITY_ID, label: 'Ada' });
    expect(fixture.store.setIdentityLabel).toHaveBeenCalledWith({
      network: NETWORK, identityId: IDENTITY_ID, label: 'Ada', authority: 'operator',
    });
  });

  it('translates a missing operator label without calling storage mutation', async () => {
    const fixture = setup();
    fixture.store.records.set(IDENTITY_ID, readyRecord());

    const failure = await captureFailure(() => createIdentityWorkflow(fixture.deps).setOperatorIdentityLabel({
      identityId: IDENTITY_ID, operation: 'set', mode: 'hard',
    }));
    expect(failure).toBeInstanceOf(IdentityWorkflowError);
    expect(failure).toMatchObject({ code: 'LABEL_REQUIRED' });
    expect(fixture.store.setIdentityLabel).not.toHaveBeenCalled();
  });

  it('rejects an agent-supplied mode before storage mutation', async () => {
    const fixture = setup();
    fixture.store.records.set(IDENTITY_ID, readyRecord());

    const failure = await captureFailure(() => createIdentityWorkflow(fixture.deps).setAgentIdentityLabel({
      identityId: IDENTITY_ID, label: 'Agent', mode: 'hard',
    }));
    expect(failure).toBeInstanceOf(IdentityWorkflowError);
    expect(failure).toMatchObject({ code: 'INVALID_INPUT' });
    expect(fixture.store.setIdentityLabel).not.toHaveBeenCalled();
  });

  it.each([
    ['within deadline', 1_900_000_000_000 - 1_000, 'pending', true],
    ['at deadline', 1_900_000_000_000 - 86_400_000, 'unknown', false],
  ] as const)('returns the same public projection as status/list when labeling %s', async (
    _case, reservedAt, status, hasUrl,
  ) => {
    const fixture = setup({ now: () => 1_900_000_000_000, getIdentityRequestTimeoutMs: async () => 86_400_000 });
    const record = { ...awaitingRecord(),
      requestAttemptId: '018f47a2-43d2-7ad9-8b5e-89d810f95a22',
      authorizationUrl: 'https://verification.example/continue', label: '@old' };
    fixture.store.records.set(IDENTITY_ID, record);
    fixture.store.readIdentityRequestReservation.mockResolvedValue({ state: 'reserved', reservedAt });
    const workflow = createIdentityWorkflow(fixture.deps);

    const renamed = await workflow.setAgentIdentityLabel({ identityId: IDENTITY_ID, label: 'next' });
    const listed = (await workflow.list({}))[0];
    const direct = await workflow.status({ identityId: IDENTITY_ID });
    expect(renamed).toEqual(listed);
    expect(renamed).toEqual(direct);
    expect(renamed).toMatchObject({ status, label: 'next' });
    if (hasUrl) expect(renamed).toHaveProperty('authorizationUrl', 'https://verification.example/continue');
    else expect(renamed).not.toHaveProperty('authorizationUrl');
  });

  it('rejects agent replacement of a protected label atomically and without hardware or provider work', async () => {
    const fixture = setup();
    const original = readyRecord({ label: 'Protected' });
    fixture.store.records.set(IDENTITY_ID, original);

    const failure = await captureFailure(() => createIdentityWorkflow(fixture.deps).setAgentIdentityLabel({
      identityId: IDENTITY_ID, label: 'agent',
    }));
    expect(failure).toBeInstanceOf(IdentityWorkflowError);
    expect(failure).toMatchObject({ code: 'LABEL_PROTECTED' });
    expect(fixture.store.records.get(IDENTITY_ID)).toEqual(original);
    expect(fixture.sources.resolve).not.toHaveBeenCalled();
    expect(fixture.sources.createAgreement).not.toHaveBeenCalled();
    expect(fixture.provider.recover).not.toHaveBeenCalled();
  });

  it('removes an operator label and keeps the identity unlabeled through status, recovery, and reconciliation', async () => {
    const fixture = setup();
    const existing = readyRecord({ label: defaultLabel() });
    fixture.store.records.set(IDENTITY_ID, existing);
    const workflow = createIdentityWorkflow(fixture.deps);

    const removed = await workflow.setOperatorIdentityLabel({ identityId: defaultBareLabel(), operation: 'remove' });
    expect(removed).not.toHaveProperty('label');
    expect(fixture.store.records.get(IDENTITY_ID)).not.toHaveProperty('label');
    await expect(workflow.status({ identityId: IDENTITY_ID })).resolves.not.toHaveProperty('label');
    await expect(workflow.status({ identityId: defaultBareLabel() }))
      .rejects.toMatchObject({ code: 'IDENTITY_NOT_FOUND' });

    const withoutCiphertext = fixture.store.records.get(IDENTITY_ID)!;
    delete withoutCiphertext.identity;
    fixture.store.records.set(IDENTITY_ID, withoutCiphertext);
    vi.mocked(fixture.provider.recover).mockResolvedValue(recoveredIdentity(fixture));
    await expect(workflow.recover({ ...requestInput(), identityIndex: 2 }))
      .resolves.not.toHaveProperty('label');
    await expect(workflow.reconcileAccountOpening({ identityId: IDENTITY_ID })).resolves.toMatchObject({
      identityId: IDENTITY_ID, status: 'no_pending',
    });
    expect(fixture.store.records.get(IDENTITY_ID)).not.toHaveProperty('label');
  });

  it('lets MCP remove only a soft label and preserves a hard label on protected removal', async () => {
    const soft = setup();
    soft.store.records.set(IDENTITY_ID, readyRecord({ label: '@AgentLabel' }));
    await expect(createIdentityWorkflow(soft.deps).setAgentIdentityLabel({
      identityId: IDENTITY_ID, operation: 'remove',
    })).resolves.not.toHaveProperty('label');
    expect(soft.store.records.get(IDENTITY_ID)).not.toHaveProperty('label');

    const hard = setup();
    const original = readyRecord({ label: 'OperatorLabel' });
    hard.store.records.set(IDENTITY_ID, original);
    const failure = await captureFailure(() => createIdentityWorkflow(hard.deps).setAgentIdentityLabel({
      identityId: IDENTITY_ID, operation: 'remove',
    }));
    expect(failure).toBeInstanceOf(IdentityWorkflowError);
    expect(failure).toMatchObject({ code: 'LABEL_PROTECTED' });
    expect(hard.store.records.get(IDENTITY_ID)).toEqual(original);
  });

  it('trims and case-folds bare label selection while returning stored spelling and the canonical identity id', async () => {
    const fixture = setup();
    fixture.store.records.set(IDENTITY_ID, readyRecord({ label: '@ted' }));
    const workflow = createIdentityWorkflow(fixture.deps);

    await expect(workflow.status({ identityId: ' TeD ' }))
      .resolves.toMatchObject({ identityId: IDENTITY_ID, label: 'ted' });
    await expect(workflow.status({ identityId: '@ted' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(workflow.reconcileAccountOpening({ identityId: 'TED' })).resolves.toEqual({
      network: NETWORK, identityId: IDENTITY_ID, status: 'no_pending',
    });
  });

  it.each([
    { identityId: IDENTITY_ID, label: '@bad' },
    { identityId: IDENTITY_ID, label: 'ok', authority: 'operator' },
  ])('rejects invalid or non-strict agent label input before store access: %j', async (input) => {
    const fixture = setup();
    fixture.store.records.set(IDENTITY_ID, readyRecord());
    const failure = await captureFailure(() => createIdentityWorkflow(fixture.deps).setAgentIdentityLabel(input));
    expect(failure).toBeInstanceOf(IdentityWorkflowError);
    expect(failure).toMatchObject({ code: 'INVALID_INPUT' });
    expect(fixture.store.setIdentityLabel).not.toHaveBeenCalled();
  });

  it('surfaces missing identities and collisions without changing existing state', async () => {
    const missing = setup();
    const missingFailure = await captureFailure(() => createIdentityWorkflow(missing.deps).setOperatorIdentityLabel({
      identityId: IDENTITY_ID, label: 'Ada',
    }));
    expect(missingFailure).toBeInstanceOf(IdentityWorkflowError);
    expect(missingFailure).toMatchObject({ code: 'IDENTITY_NOT_FOUND' });
    expect(missing.store.records.allValues()).toEqual([]);

    const collision = setup();
    const original = readyRecord({ label: '@Original' });
    collision.store.records.set(IDENTITY_ID, original);
    collision.store.setIdentityLabel.mockRejectedValueOnce(new IdentityWorkflowError('LABEL_IN_USE'));
    const collisionFailure = await captureFailure(() => createIdentityWorkflow(collision.deps).setOperatorIdentityLabel({
      identityId: IDENTITY_ID, label: ' taken ',
    }));
    expect(collisionFailure).toBeInstanceOf(IdentityWorkflowError);
    expect(collisionFailure).toMatchObject({ code: 'LABEL_IN_USE' });
    expect(collision.store.records.get(IDENTITY_ID)).toEqual(original);
  });

  it('labeling and selector lookup do not perform signing, provider, or account work', async () => {
    const fixture = setup();
    fixture.store.records.set(IDENTITY_ID, readyRecord({ label: '@quiet' }));
    await createIdentityWorkflow(fixture.deps).setOperatorIdentityLabel({ identityId: ' QUIET ', label: 'Quiet' });
    await createIdentityWorkflow(fixture.deps).status({ identityId: 'quiet' });

    expect(fixture.crypto.request).not.toHaveBeenCalled();
    expect(fixture.crypto.recovery).not.toHaveBeenCalled();
    expect(fixture.crypto.credential).not.toHaveBeenCalled();
    expect(fixture.provider.recover).not.toHaveBeenCalled();
    expect(fixture.createAccountObserver).not.toHaveBeenCalled();
  });

  it('accepts the 49-character agent value at the public workflow boundary', async () => {
    const fixture = setup();
    fixture.store.records.set(IDENTITY_ID, readyRecord());
    const label = `A${'b'.repeat(48)}`;
    await expect(createIdentityWorkflow(fixture.deps).setAgentIdentityLabel({ identityId: IDENTITY_ID, label }))
      .resolves.toMatchObject({ label });
  });

});
