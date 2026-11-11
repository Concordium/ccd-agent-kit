import { describe,expect,it,vi } from 'vitest';

import { IdentityHardwareError } from '@ccd-agent-kit/piv-utils';
import { createIdentityWorkflow,IdentityWorkflowError } from '../../src/core/identityWorkflow.js';
import { expectSanitized } from '../helpers.js';
import {
awaitingRecord,
context,
IDENTITY_ID,
NOW_MS,
PUBLIC_KEY,
readyRecord,
recoveryInput,
setup,
} from '../workflowFixtures.js';

const input = () => recoveryInput();

async function rejects(promise: Promise<unknown>, code: string) {
  let failure: unknown;
  try { await promise; } catch (error) { failure = error; }
  expectSanitized(failure, IdentityWorkflowError, code);
}

describe('IdentityWorkflow guarded edges', () => {
  it('uses the deterministic derived file identifier', async () => {
    const fixture = setup();
    const summary = await createIdentityWorkflow(fixture.deps).request(input());
    expect(summary.identityId).toBe(IDENTITY_ID);
    expect(fixture.store.records.has(summary.identityId)).toBe(true);
  });

  it('canonicalizes array-valued public context before binding the request', async () => {
    const fixture = setup({
      loadContext: async () => context({
        globalContext: { ...context().globalContext, testVector: [{ z: 1, a: 2 }] } as never,
      }),
    });
    await expect(createIdentityWorkflow(fixture.deps).request(input())).resolves.toMatchObject({
      identityId: IDENTITY_ID,
    });
  });

  it('rejects a malformed SDK recovery envelope before provider or storage', async () => {
    const fixture = setup();
    vi.mocked(fixture.crypto.recovery).mockReturnValue({ ...fixture.recovery, v: 1 });
    await rejects(createIdentityWorkflow(fixture.deps).recover(input()), 'CRYPTO_FAILED');
    expect(fixture.provider.recover).not.toHaveBeenCalled();
    expect(fixture.store.create).not.toHaveBeenCalled();
  });

  it('rejects malformed recovery idCredPub before provider use', async () => {
    const fixture = setup();
    vi.mocked(fixture.crypto.recovery).mockReturnValue({
      ...fixture.recovery,
      value: { ...fixture.recovery.value, idCredPub: 'not-hex' },
    });
    await rejects(createIdentityWorkflow(fixture.deps).recover(input()), 'CRYPTO_FAILED');
    expect(fixture.provider.recover).not.toHaveBeenCalled();
  });

  it('maps hardware authorization distinctly while sanitizing other native failures', async () => {
    for (const [hardwareCode, workflowCode] of [
      ['AUTHORIZATION_REQUIRED', 'AUTHORIZATION_REQUIRED'],
      ['DEVICE_FAILED', 'CRYPTO_FAILED'],
    ] as const) {
      const fixture = setup();
      vi.mocked(fixture.sources.createAgreement).mockResolvedValue({
        agree: vi.fn(async () => { throw new IdentityHardwareError(hardwareCode); }),
      });
      await rejects(createIdentityWorkflow(fixture.deps).request(input()), workflowCode);
      expect(fixture.store.create).not.toHaveBeenCalled();
    }
  });

  it('rejects a loaded record whose stored ID differs from the requested handle', async () => {
    const fixture = setup();
    fixture.store.load.mockResolvedValue({
      ...readyRecord(),
      id: 'ff'.repeat(32),
    });
    await rejects(createIdentityWorkflow(fixture.deps).status({ identityId: IDENTITY_ID }), 'STORAGE_FAILED');
    expect(fixture.deps.loadContext).not.toHaveBeenCalled();
  });

  it('preserves an unexpected storage failure while checking for recoverable identity state', async () => {
    const fixture = setup();
    fixture.store.load.mockRejectedValue(new Error('private storage failure'));
    await rejects(createIdentityWorkflow(fixture.deps).recover(input()), 'STORAGE_FAILED');
    expect(fixture.provider.recover).not.toHaveBeenCalled();
  });

  it('rejects completed retrieval when hardware derives a different identity file id', async () => {
    const fixture = setup();
    const otherId = 'ff'.repeat(32);
    const record = awaitingRecord();
    record.id = otherId;
    fixture.store.records.set(otherId, record);
    vi.mocked(fixture.provider.retrieve).mockResolvedValue({ status: 'done', identity: readyRecord().identity! });
    const otherCallback = `ccd-id-manager://identity/${otherId}#code_uri=${encodeURIComponent('https://issuer.example.test/v1/result/opaque')}`;

    await rejects(createIdentityWorkflow(fixture.deps).status({ identityId: otherId, callbackUrl: otherCallback }), 'IDENTITY_MISMATCH');
    expect(fixture.store.createIdentity).not.toHaveBeenCalled();
  });

  it.each([
    ['malformed', 'not-a-credential-id'],
    ['duplicate', 'aa'.repeat(48)],
  ])('rejects a %s credential identifier without persisting it', async (_case, credentialId) => {
    const fixture = setup();
    fixture.store.records.set(IDENTITY_ID, readyRecord());
    if (_case === 'duplicate') fixture.store.credentials.set(credentialId, {
      identityId: 'ff'.repeat(32), credentialNumber: 2, status: 'confirmed',
    });
    vi.mocked(fixture.crypto.credential).mockReturnValue({
      ...fixture.payload,
      unsignedCdi: { ...fixture.payload.unsignedCdi, credId: credentialId },
    });
    await rejects(createIdentityWorkflow(fixture.deps).prepareAccount({
      identityId: IDENTITY_ID, credentialNumber: 0, publicKeys: { '0': PUBLIC_KEY }, credentialThreshold: 1,
      expirySeconds: NOW_MS / 1000 + 60,
    }), 'CRYPTO_FAILED');
    expect(fixture.store.saveCredentials).not.toHaveBeenCalled();
  });

  it('rejects a persisted retrieval URL whose origin no longer matches the issuer', async () => {
    const fixture = setup();
    const record = { ...awaitingRecord(), status: 'pending' as const,
      retrievalUrl: 'https://attacker.example/result' };
    fixture.store.records.set(IDENTITY_ID, record);
    await rejects(createIdentityWorkflow(fixture.deps).status({ identityId: IDENTITY_ID }), 'INVALID_INPUT');
    expect(fixture.provider.retrieve).not.toHaveBeenCalled();
  });

  it('returns issued and callback-less pending summaries without provider access', async () => {
    for (const [record, publicStatus] of [
      [readyRecord(), 'issued'],
      [{ ...awaitingRecord(), status: 'pending' as const }, 'pending'],
    ] as const) {
      const fixture = setup();
      fixture.store.records.set(IDENTITY_ID, record);
      const result = await createIdentityWorkflow(fixture.deps).status({ identityId: IDENTITY_ID });
      expect(result.status).toBe(publicStatus);
      expect(fixture.provider.retrieve).not.toHaveBeenCalled();
    }
  });

  it('rejects an expired ready identity before context or hardware access', async () => {
    const fixture = setup();
    const record = readyRecord();
    record.identity!.value.attributeList.validTo = '202001';
    fixture.store.records.set(IDENTITY_ID, record);
    await rejects(createIdentityWorkflow(fixture.deps).prepareAccount({
      identityId: IDENTITY_ID,
      credentialNumber: 0,
      publicKeys: { '0': PUBLIC_KEY }, credentialThreshold: 1,
      expirySeconds: NOW_MS / 1000 + 60,
    }), 'IDENTITY_NOT_READY');
    expect(fixture.deps.loadContext).toHaveBeenCalledOnce();
    expect(fixture.sources.createAgreement).toHaveBeenCalledTimes(2);
  });

});
