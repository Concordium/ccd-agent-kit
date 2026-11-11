import { describe,expect,it,vi } from 'vitest';
import { createIdentityWorkflow,IdentityWorkflowError } from '../../src/core/identityWorkflow.js';
import type { IdentityWorkflowDependencies } from '../../src/core/workflowTypes.js';
import { credentialPayload,IDENTITY_ID,NETWORK,NOW_MS,PUBLIC_KEY,readyRecord,setup } from '../workflowFixtures.js';

type CredentialRecord = {
  identityId: string;
  credentialNumber: number;
  status: 'pending' | 'confirmed';
  expectedAccountAddress?: string;
  expirySeconds?: number;
};

type FinalizedAccountResult =
  | { exists: false; sourceBlock: { hash: string; height: string; time: string }; genesisHash: string }
  | {
      exists: true;
      canonicalAddress: string;
      sourceBlock: { hash: string; height: string; time: string };
      observation: {
        accountThreshold: string;
        credentials: Record<string, unknown>;
        sourceBlock: { hash: string; height: string; time: string };
      };
      genesisHash: string;
    };

function registryFixture() {
  const fixture = setup();
  fixture.store.records.set(IDENTITY_ID, readyRecord());
  const credentials = new Map<string, CredentialRecord>();
  let tail = Promise.resolve();
  const withMutation = vi.fn(async <T>(_network: string, operation: () => Promise<T>): Promise<T> => {
    const prior = tail;
    let release!: () => void;
    tail = new Promise<void>((resolve) => { release = resolve; });
    await prior;
    try { return await operation(); } finally { release(); }
  });
  const loadCredentials = vi.fn(async () => ({
    version: 1 as const,
    credentials: Object.fromEntries([...credentials].map(([id, value]) => [id, structuredClone(value)])),
  }));
  const saveCredentials = vi.fn(async (_network: string, registry: { credentials: Record<string, CredentialRecord> }) => {
    credentials.clear();
    for (const [id, value] of Object.entries(registry.credentials)) credentials.set(id, structuredClone(value));
  });
  Object.assign(fixture.store, { withMutation, loadCredentials, saveCredentials });
  const observeFinalizedAccount = vi.fn<(_selector: { type: 'address'; address: string }) => Promise<FinalizedAccountResult>>(async () => ({
    exists: false,
    sourceBlock: { hash: 'ab'.repeat(32), height: '7', time: new Date(NOW_MS).toISOString() },
    genesisHash: '12'.repeat(32),
  }));
  const createAccountObserver = vi.fn(async () => observeFinalizedAccount);
  const resolveNetwork = vi.fn((selector?: string) => (
    selector === undefined || selector === 'localnet' || selector === NETWORK.slice(4) || selector === NETWORK ? NETWORK : selector
  ));
  const deps = { ...fixture.deps, createAccountObserver, resolveNetwork } as unknown as IdentityWorkflowDependencies;
  return { ...fixture, deps, credentials, withMutation, loadCredentials, saveCredentials, createAccountObserver, observeFinalizedAccount, resolveNetwork };
}

const prepare = (credentialNumber?: number) => ({
  identityId: IDENTITY_ID,
  ...(credentialNumber === undefined ? {} : { credentialNumber }),
  publicKeys: { '0': PUBLIC_KEY }, credentialThreshold: 1,
  expirySeconds: NOW_MS / 1000 + 600,
});

describe('durable credential allocation', () => {
  it('allocates the lowest unused number across pending and confirmed records', async () => {
    const fixture = registryFixture();
    fixture.credentials.set('11'.repeat(48), { identityId: IDENTITY_ID, credentialNumber: 0, status: 'confirmed' });
    fixture.credentials.set('22'.repeat(48), { identityId: IDENTITY_ID, credentialNumber: 2, status: 'confirmed' });
    const result = await createIdentityWorkflow(fixture.deps).prepareAccount(prepare());
    expect(result.credentialNumber).toBe(1);
    expect(fixture.crypto.credential).toHaveBeenCalledWith(expect.objectContaining({ credNumber: 1 }), expect.anything());
    expect(fixture.credentials.get(credentialPayload().unsignedCdi.credId)).toMatchObject({
      identityId: IDENTITY_ID, credentialNumber: 1, status: 'pending',
      expectedAccountAddress: result.accountAddress, expirySeconds: result.expirySeconds,
    });
  });

  it.each([0, 2])('rejects explicit used number %i before hardware use', async (credentialNumber) => {
    const fixture = registryFixture();
    fixture.credentials.set('11'.repeat(48), { identityId: IDENTITY_ID, credentialNumber: 0, status: 'confirmed' });
    fixture.credentials.set('22'.repeat(48), { identityId: IDENTITY_ID, credentialNumber: 2, status: 'confirmed' });
    await expect(createIdentityWorkflow(fixture.deps).prepareAccount(prepare(credentialNumber))).rejects.toMatchObject({
      code: 'CREDENTIAL_NUMBER_USED',
    });
    expect(fixture.sources.createAgreement).not.toHaveBeenCalled();
    expect(fixture.crypto.credential).not.toHaveBeenCalled();
  });

  it('enforces one pending account opening per identity', async () => {
    const fixture = registryFixture();
    fixture.credentials.set('22'.repeat(48), {
      identityId: IDENTITY_ID, credentialNumber: 2, status: 'pending',
      expectedAccountAddress: 'account-two', expirySeconds: NOW_MS / 1000 + 300,
    });
    await expect(createIdentityWorkflow(fixture.deps).prepareAccount(prepare())).rejects.toMatchObject({ code: 'ACCOUNT_OPENING_PENDING' });
    expect(fixture.crypto.credential).not.toHaveBeenCalled();
  });

  it('bounds automatic and explicit allocation by min(maxAccounts, 256)', async () => {
    const fixture = registryFixture();
    const record = readyRecord();
    record.identity!.value.attributeList.maxAccounts = 300;
    fixture.store.records.set(IDENTITY_ID, record);
    for (let number = 0; number < 256; number += 1) {
      fixture.credentials.set(number.toString(16).padStart(96, '0'), {
        identityId: IDENTITY_ID, credentialNumber: number, status: 'confirmed',
      });
    }
    await expect(createIdentityWorkflow(fixture.deps).prepareAccount(prepare())).rejects.toMatchObject({ code: 'CREDENTIAL_LIMIT' });
    await expect(createIdentityWorkflow(fixture.deps).prepareAccount(prepare(256))).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(fixture.crypto.credential).not.toHaveBeenCalled();
  });

  it('serializes concurrent callers and only persists one pending opening', async () => {
    const fixture = registryFixture();
    const workflow = createIdentityWorkflow(fixture.deps);
    const results = await Promise.allSettled([workflow.prepareAccount(prepare()), workflow.prepareAccount(prepare())]);
    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(({ status }) => status === 'rejected')).toHaveLength(1);
    expect([...fixture.credentials.values()].filter(({ status }) => status === 'pending')).toHaveLength(1);
    expect(fixture.withMutation).toHaveBeenCalledTimes(2);
  });

  it('does not return a handoff when credential-registry persistence fails', async () => {
    const fixture = registryFixture();
    fixture.saveCredentials.mockRejectedValueOnce(new Error('private path'));
    await expect(createIdentityWorkflow(fixture.deps).prepareAccount(prepare())).rejects.toMatchObject({ code: 'STORAGE_FAILED' });
    expect(fixture.crypto.credential).toHaveBeenCalledOnce();
    expect(fixture.credentials.size).toBe(0);
  });
});

describe('finalized account-opening reconciliation', () => {
  function pendingFixture(expirySeconds = NOW_MS / 1000 + 60) {
    const fixture = registryFixture();
    fixture.credentials.set('aa'.repeat(48), {
      identityId: IDENTITY_ID, credentialNumber: 1, status: 'pending',
      expectedAccountAddress: 'account-expected', expirySeconds,
    });
    return fixture;
  }

  it('confirms an observed account even when the same finalized block is after expiry', async () => {
    const fixture = pendingFixture(NOW_MS / 1000 - 1);
    fixture.observeFinalizedAccount.mockResolvedValue({
      exists: true,
      canonicalAddress: 'account-expected', genesisHash: '12'.repeat(32),
      sourceBlock: { hash: 'ab'.repeat(32), height: '7', time: new Date(NOW_MS + 1_000).toISOString() },
      observation: { accountThreshold: '1', credentials: { 0: { credentialId: 'aa'.repeat(48) } }, sourceBlock: {
        hash: 'ab'.repeat(32), height: '7', time: new Date(NOW_MS + 1_000).toISOString(),
      } },
    });
    const result = await createIdentityWorkflow(fixture.deps).reconcileAccountOpening({ network: NETWORK, identityId: IDENTITY_ID });
    expect(fixture.resolveNetwork).toHaveBeenCalledExactlyOnceWith(NETWORK);
    expect(fixture.loadCredentials).toHaveBeenCalledWith(NETWORK);
    expect(fixture.createAccountObserver).toHaveBeenCalledExactlyOnceWith(NETWORK);
    expect(fixture.observeFinalizedAccount).toHaveBeenCalledWith({ type: 'address', address: 'account-expected' });
    expect(result).toMatchObject({ status: 'confirmed', credentialNumber: 1 });
    expect(fixture.credentials.get('aa'.repeat(48))).toEqual({
      identityId: IDENTITY_ID, credentialNumber: 1, status: 'confirmed',
    });
    expect(fixture.sources.createAgreement).not.toHaveBeenCalled();
    expect(fixture.deps.loadContext).not.toHaveBeenCalled();
    expect(fixture.provider.retrieve).not.toHaveBeenCalled();
    expect(fixture.provider.recover).not.toHaveBeenCalled();
  });

  it('returns no_pending without consulting the finalized observer', async () => {
    const fixture = registryFixture();
    await expect(createIdentityWorkflow(fixture.deps).reconcileAccountOpening({
      network: NETWORK, identityId: IDENTITY_ID,
    })).resolves.toEqual({ network: NETWORK, identityId: IDENTITY_ID, status: 'no_pending' });
    expect(fixture.observeFinalizedAccount).not.toHaveBeenCalled();
  });

  it.each(['localnet', NETWORK.slice(4), NETWORK])(
    'resolves network selector %s once before accessing network-scoped state',
    async (selector) => {
      const fixture = pendingFixture();
      await expect(createIdentityWorkflow(fixture.deps).reconcileAccountOpening({
        network: selector, identityId: IDENTITY_ID,
      })).resolves.toMatchObject({ network: NETWORK, identityId: IDENTITY_ID, status: 'pending' });
      expect(fixture.resolveNetwork).toHaveBeenCalledExactlyOnceWith(selector);
      expect(fixture.withMutation).toHaveBeenCalledWith(NETWORK, expect.any(Function));
      expect(fixture.loadCredentials).toHaveBeenCalledWith(NETWORK);
      expect(fixture.createAccountObserver).toHaveBeenCalledExactlyOnceWith(NETWORK);
      expect(fixture.observeFinalizedAccount).toHaveBeenCalledWith({ type: 'address', address: 'account-expected' });
    },
  );

  it('sanitizes resolver failure before accessing network-scoped state', async () => {
    const fixture = pendingFixture();
    fixture.deps.resolveNetwork = () => { throw new Error('private config path'); };
    await expect(createIdentityWorkflow(fixture.deps).reconcileAccountOpening({
      network: 'localnet', identityId: IDENTITY_ID,
    })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(fixture.withMutation).not.toHaveBeenCalled();
    expect(fixture.observeFinalizedAccount).not.toHaveBeenCalled();
  });

  it('preserves pending state when the finalized account lacks the expected credential', async () => {
    const fixture = pendingFixture();
    fixture.observeFinalizedAccount.mockResolvedValue({
      exists: true,
      canonicalAddress: 'account-expected', genesisHash: '12'.repeat(32),
      sourceBlock: { hash: 'ab'.repeat(32), height: '7', time: new Date(NOW_MS).toISOString() },
      observation: {
        accountThreshold: '1', credentials: { 0: { credentialId: 'bb'.repeat(48) } },
        sourceBlock: { hash: 'ab'.repeat(32), height: '7', time: new Date(NOW_MS).toISOString() },
      },
    });
    await expect(createIdentityWorkflow(fixture.deps).reconcileAccountOpening({
      network: NETWORK, identityId: IDENTITY_ID,
    })).rejects.toMatchObject({ code: 'NETWORK_FAILED' });
    expect(fixture.credentials.get('aa'.repeat(48))?.status).toBe('pending');
  });

  it.each(['canonical address', 'embedded source block'] as const)(
    'preserves pending state when the finalized account has mismatched %s',
    async (mismatch) => {
      const fixture = pendingFixture();
      fixture.observeFinalizedAccount.mockResolvedValue({
        exists: true,
        canonicalAddress: mismatch === 'canonical address' ? 'account-other' : 'account-expected',
        genesisHash: '12'.repeat(32),
        sourceBlock: { hash: 'ab'.repeat(32), height: '7', time: new Date(NOW_MS).toISOString() },
        observation: {
          accountThreshold: '1', credentials: { 0: { credentialId: 'aa'.repeat(48) } },
          sourceBlock: {
            hash: mismatch === 'embedded source block' ? 'cd'.repeat(32) : 'ab'.repeat(32),
            height: '7', time: new Date(NOW_MS).toISOString(),
          },
        },
      });

      await expect(createIdentityWorkflow(fixture.deps).reconcileAccountOpening({
        network: NETWORK, identityId: IDENTITY_ID,
      })).rejects.toMatchObject({ code: 'NETWORK_FAILED' });
      expect(fixture.credentials.get('aa'.repeat(48))?.status).toBe('pending');
      expect(fixture.saveCredentials).not.toHaveBeenCalled();
    },
  );

  it('preserves pending state when the finalized block time is invalid', async () => {
    const fixture = pendingFixture();
    fixture.observeFinalizedAccount.mockResolvedValue({
      exists: false,
      genesisHash: '12'.repeat(32),
      sourceBlock: { hash: 'ab'.repeat(32), height: '7', time: 'not-a-date' },
    });
    await expect(createIdentityWorkflow(fixture.deps).reconcileAccountOpening({
      network: NETWORK, identityId: IDENTITY_ID,
    })).rejects.toMatchObject({ code: 'NETWORK_FAILED' });
    expect(fixture.credentials.get('aa'.repeat(48))?.status).toBe('pending');
  });

  it.each([
    ['before expiry', NOW_MS / 1000 + 59],
    ['equal to expiry', NOW_MS / 1000 + 60],
  ])('keeps an absent account pending %s', async (_label, timestampSeconds) => {
    const fixture = pendingFixture();
    fixture.observeFinalizedAccount.mockResolvedValue({
      exists: false,
      genesisHash: '12'.repeat(32),
      sourceBlock: { hash: 'ab'.repeat(32), height: '7', time: new Date(timestampSeconds * 1_000).toISOString() },
    });
    await expect(createIdentityWorkflow(fixture.deps).reconcileAccountOpening({
      network: NETWORK, identityId: IDENTITY_ID,
    })).resolves.toMatchObject({ status: 'pending' });
    expect(fixture.credentials.get('aa'.repeat(48))?.status).toBe('pending');
  });

  it('removes an absent opening only when the finalized block is strictly after expiry', async () => {
    const fixture = pendingFixture();
    fixture.observeFinalizedAccount.mockResolvedValue({
      exists: false,
      genesisHash: '12'.repeat(32),
      sourceBlock: { hash: 'ab'.repeat(32), height: '7', time: new Date(NOW_MS + 61_000).toISOString() },
    });
    await expect(createIdentityWorkflow(fixture.deps).reconcileAccountOpening({
      network: NETWORK, identityId: IDENTITY_ID,
    })).resolves.toMatchObject({ status: 'expired', credentialNumber: 1 });
    expect(fixture.credentials.has('aa'.repeat(48))).toBe(false);
  });

  it('preserves pending state on node lookup and persistence failures', async () => {
    for (const boundary of ['lookup', 'save'] as const) {
      const fixture = pendingFixture();
      if (boundary === 'lookup') fixture.observeFinalizedAccount.mockRejectedValue(new Error('private RPC detail'));
      else {
        fixture.observeFinalizedAccount.mockResolvedValue({
          exists: false,
          genesisHash: '12'.repeat(32),
          sourceBlock: { hash: 'ab'.repeat(32), height: '7', time: new Date(NOW_MS + 61_000).toISOString() },
        });
        fixture.saveCredentials.mockRejectedValueOnce(new Error('private path'));
      }
      await expect(createIdentityWorkflow(fixture.deps).reconcileAccountOpening({
        network: NETWORK, identityId: IDENTITY_ID,
      })).rejects.toBeInstanceOf(IdentityWorkflowError);
      expect(fixture.credentials.get('aa'.repeat(48))?.status).toBe('pending');
    }
  });

  it('requires an identity in the selected network index before creating an observer', async () => {
    const missingIdentity = pendingFixture();
    missingIdentity.store.readIndex.mockResolvedValue({
      version: 1, network: { caip2: NETWORK, genesisHash: '12'.repeat(32), sdkNetwork: 'Testnet' }, identities: {},
    });
    await expect(createIdentityWorkflow(missingIdentity.deps).reconcileAccountOpening({
      network: NETWORK, identityId: IDENTITY_ID,
    })).rejects.toMatchObject({ code: 'STORAGE_FAILED' });
    expect(missingIdentity.createAccountObserver).not.toHaveBeenCalled();
    expect(missingIdentity.observeFinalizedAccount).not.toHaveBeenCalled();
  });

  it('preserves pending state when the observer reports a different full genesis', async () => {
    const fixture = pendingFixture();
    fixture.observeFinalizedAccount.mockResolvedValue({
      exists: false, genesisHash: '34'.repeat(32),
      sourceBlock: { hash: 'ab'.repeat(32), height: '7', time: new Date(NOW_MS).toISOString() },
    });
    await expect(createIdentityWorkflow(fixture.deps).reconcileAccountOpening({
      network: NETWORK, identityId: IDENTITY_ID,
    })).rejects.toMatchObject({ code: 'NETWORK_FAILED' });
    expect(fixture.credentials.get('aa'.repeat(48))?.status).toBe('pending');
  });
});
