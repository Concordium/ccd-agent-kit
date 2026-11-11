import { resolveNetwork as resolveConfiguredNetwork,saveNetworks } from '@ccd-agent-kit/config-utils';
import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
import { deriveIdentityRoot } from '../../src/core/identityRoot.js';
import { deriveIdentityStorageMaterial } from '../../src/core/identityStorageCrypto.js';
import { createIdentityWorkflow } from '../../src/core/identityWorkflow.js';
import { createEncryptedIdentityStore } from '../../src/core/workflowInfrastructure.js';
import type { AccountObserver,AccountObserverFactory,CredentialRegistry } from '../../src/core/workflowTypes.js';
import {
GENESIS_HASH,IDENTITY_ID,NETWORK,NOW_MS,awaitingRecord,context,credentialPayload,identityObject,
recoveryInput,
  readyRecord,requestObject,
selection,setup,
} from '../workflowFixtures.js';
import { useTestXdg } from '../xdgTestHelpers.js';

useTestXdg('workflow-real-store-', ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME']);
const REFERENCE = GENESIS_HASH.slice(0, 32);
const METADATA = { caip2: NETWORK, genesisHash: GENESIS_HASH, sdkNetwork: 'Testnet' as const };
const CREDENTIAL_ID = 'aa'.repeat(48);
const OTHER_GENESIS = '34'.repeat(32);
const OTHER_NETWORK = `ccd:${OTHER_GENESIS.slice(0, 32)}`;

let previousCcdNetwork: string | undefined;

beforeEach(async () => {
  previousCcdNetwork = process.env.CCD_NETWORK;
  delete process.env.CCD_NETWORK;
  saveNetworks({
    default: 'localnet',
    networks: {
      localnet: {
        caip2: NETWORK, genesisHash: GENESIS_HASH,
        grpc: { host: 'localhost', port: 20_000, ssl: false },
      },
      othernet: {
        caip2: OTHER_NETWORK, genesisHash: OTHER_GENESIS,
        grpc: { host: 'localhost', port: 20_001, ssl: false },
      },
    },
  });
});

afterEach(async () => {
  if (previousCcdNetwork === undefined) delete process.env.CCD_NETWORK;
  else process.env.CCD_NETWORK = previousCcdNetwork;
});

function pendingRegistry(expirySeconds = NOW_MS / 1000 + 60): CredentialRegistry {
  return { version: 1, credentials: {
    [CREDENTIAL_ID]: {
      identityId: IDENTITY_ID, credentialNumber: 1, status: 'pending',
      expectedAccountAddress: 'account-expected', expirySeconds,
    },
  } };
}

async function reconciliationFixture(registry: CredentialRegistry) {
  const store = createEncryptedIdentityStore();
  await store.bootstrapNetwork(METADATA);
  await store.create(readyRecord());
  await store.saveCredentials(NETWORK, registry);
  const fixture = setup();
  const observer = vi.fn<AccountObserver>();
  const createAccountObserver = vi.fn(async () => observer);
  const deps = {
    ...fixture.deps, store, createAccountObserver,
    resolveNetwork: (selector: string) => resolveConfiguredNetwork(selector).config.caip2.toLowerCase(),
  };
  const workflow = createIdentityWorkflow(deps as never);
  return { store, workflow, observer, createAccountObserver };
}

describe('real encrypted-store account reconciliation routing', () => {
  it('resolves a configured network name and returns its canonical namespace when no opening is pending', async () => {
    const fixture = await reconciliationFixture({ version: 1, credentials: {} });
    await expect(fixture.workflow.reconcileAccountOpening({ network: 'localnet', identityId: IDENTITY_ID }))
      .resolves.toEqual({ network: NETWORK, identityId: IDENTITY_ID, status: 'no_pending' });
    expect(fixture.createAccountObserver).not.toHaveBeenCalled();
  });

  it('resolves a bare 32-hex reference before preserving a pending opening', async () => {
    const fixture = await reconciliationFixture(pendingRegistry());
    fixture.observer.mockResolvedValue({
      exists: false, genesisHash: GENESIS_HASH,
      sourceBlock: { hash: 'ab'.repeat(32), height: '7', time: new Date(NOW_MS).toISOString() },
    });
    await expect(fixture.workflow.reconcileAccountOpening({ network: REFERENCE, identityId: IDENTITY_ID }))
      .resolves.toEqual({ network: NETWORK, identityId: IDENTITY_ID, status: 'pending', credentialNumber: 1 });
    expect(fixture.createAccountObserver).toHaveBeenCalledExactlyOnceWith(NETWORK);
    expect(fixture.observer).toHaveBeenCalledExactlyOnceWith({ type: 'address', address: 'account-expected' });
  });

  it('accepts the canonical namespace and confirms only its matching credential', async () => {
    const fixture = await reconciliationFixture(pendingRegistry());
    fixture.observer.mockResolvedValue({
      exists: true, genesisHash: GENESIS_HASH,
      canonicalAddress: 'account-expected',
      sourceBlock: { hash: 'ab'.repeat(32), height: '7', time: new Date(NOW_MS).toISOString() },
      observation: {
        accountThreshold: '1', credentials: { 0: { credentialId: CREDENTIAL_ID, threshold: '1', keys: {} } },
        sourceBlock: { hash: 'ab'.repeat(32), height: '7', time: new Date(NOW_MS).toISOString() },
      },
    });
    await expect(fixture.workflow.reconcileAccountOpening({ network: NETWORK, identityId: IDENTITY_ID }))
      .resolves.toEqual({ network: NETWORK, identityId: IDENTITY_ID, status: 'confirmed', credentialNumber: 1 });
    await expect(fixture.store.loadCredentials(NETWORK)).resolves.toEqual({
      version: 1, credentials: { [CREDENTIAL_ID]: {
        identityId: IDENTITY_ID, credentialNumber: 1, status: 'confirmed',
      } },
    });
  });

  it('resolves a configured network name before expiring its absent opening', async () => {
    const fixture = await reconciliationFixture(pendingRegistry(NOW_MS / 1000 - 1));
    fixture.observer.mockResolvedValue({
      exists: false, genesisHash: GENESIS_HASH,
      sourceBlock: { hash: 'ab'.repeat(32), height: '7', time: new Date(NOW_MS).toISOString() },
    });
    await expect(fixture.workflow.reconcileAccountOpening({ network: 'localnet', identityId: IDENTITY_ID }))
      .resolves.toEqual({ network: NETWORK, identityId: IDENTITY_ID, status: 'expired', credentialNumber: 1 });
    await expect(fixture.store.loadCredentials(NETWORK)).resolves.toEqual({ version: 1, credentials: {} });
  });

  it('does not fall back to an identity with the same id on another configured network', async () => {
    const fixture = await reconciliationFixture(pendingRegistry());
    await expect(fixture.workflow.reconcileAccountOpening({ network: 'othernet', identityId: IDENTITY_ID }))
      .rejects.toMatchObject({ code: 'STORAGE_FAILED' });
    expect(fixture.createAccountObserver).not.toHaveBeenCalled();
    await expect(fixture.store.loadCredentials(NETWORK)).resolves.toEqual(pendingRegistry());
  });
});

describe('real encrypted-store recovery transition', () => {
  function recoveringIdentity() {
    return identityObject({ ...requestObject().value, idCredPub: requestObject().value.idCredPub });
  }

  async function recoveryFixture() {
    const store = createEncryptedIdentityStore();
    await store.bootstrapNetwork(METADATA);
    const existing = { ...awaitingRecord(), status: 'pending' as const,
      retrievalUrl: 'https://issuer.example.test/v1/result/original' };
    await store.create(existing);
    const credentials: CredentialRegistry = { version: 1, credentials: {
      [CREDENTIAL_ID]: { identityId: IDENTITY_ID, credentialNumber: 0, status: 'confirmed' },
    } };
    await store.saveCredentials(NETWORK, credentials);
    const fixture = setup();
    vi.mocked(fixture.crypto.credential).mockImplementation((input) => {
      const payload = credentialPayload();
      if (input.credNumber === 1) payload.unsignedCdi.credId = 'bb'.repeat(48);
      return payload;
    });
    vi.mocked(fixture.provider.recover).mockResolvedValue(recoveringIdentity());
    const deps = {
      ...fixture.deps, store,
      resolveNetwork: (selector: string) => resolveConfiguredNetwork(selector).config.caip2.toLowerCase(),
    };
    return { store, existing, credentials, fixture, workflow: createIdentityWorkflow(deps as never) };
  }

  it('bootstraps a fresh network before discovery persists a recovered identity', async () => {
    const store = createEncryptedIdentityStore();
    const fixture = setup();
    vi.mocked(fixture.provider.recover).mockResolvedValue(recoveringIdentity());
    const workflow = createIdentityWorkflow({
      ...fixture.deps, store,
      resolveNetwork: (selector?: string) => resolveConfiguredNetwork(selector).config.caip2.toLowerCase(),
    });

    const discovered = await workflow.discoverIdentities({
      network: 'localnet', source: recoveryInput().source, identityProviderIndex: 7, endIndex: 0,
    });
    expect(discovered).toMatchObject({ streams: [{ used: [0], partial: false }] });
    const [summary] = await workflow.list({ network: 'localnet' });
    expect(summary).toBeDefined();
    await expect(store.load(NETWORK, summary!.identityId)).resolves.toMatchObject({
      sourceId: recoveryInput().source, status: 'ready',
    });
    await expect(store.loadCredentials(NETWORK)).resolves.toEqual({ version: 1, credentials: {} });
  });

  it('atomically promotes surviving non-ready metadata while restoring ciphertext and preserving credentials', async () => {
    const fixture = await recoveryFixture();
    const recovered = recoveringIdentity();
    await expect(fixture.workflow.recover(recoveryInput())).resolves.toMatchObject({
      identityId: IDENTITY_ID, network: NETWORK, status: 'issued',
    });
    const completed = await fixture.store.load(NETWORK, IDENTITY_ID);
    expect(completed).toMatchObject({
      status: 'ready', contextHash: fixture.existing.contextHash, selection: fixture.existing.selection,
    });
    for (const field of ['request','requestAttemptId','postIssuance','authorizationUrl','retrievalUrl','confirmedFailure']) {
      expect(completed).not.toHaveProperty(field);
    }
    const seed = await deriveIdentityRoot({
      network: selection().sdkNetwork, identityProviderIndex: selection().identityProviderIndex,
      identityIndex: selection().identityIndex, expectedPublicKey: Buffer.from(selection().rootPublicKey, 'hex'),
      agreement: { agree: fixture.fixture.device.agree },
    });
    const storage = deriveIdentityStorageMaterial(seed);
    await expect(fixture.store.loadIdentity(NETWORK, IDENTITY_ID, storage.encryptionKey)).resolves.toEqual(recovered);
    seed.fill(0);
    storage.encryptionKey.fill(0);
    await expect(fixture.store.loadCredentials(NETWORK)).resolves.toEqual(fixture.credentials);
    await expect(fixture.workflow.status({ identityId: IDENTITY_ID })).resolves.toMatchObject({ status: 'issued', network: NETWORK });
    await expect(fixture.workflow.prepareAccount({
      identityId: IDENTITY_ID, credentialNumber: 1,
      publicKeys: { '0': 'e6e387ecae9f68f3547da5546bf02d1ee071a7efb95a2e53781c9b482ef3d8e1' }, credentialThreshold: 1,
      expirySeconds: NOW_MS / 1000 + 600,
    })).resolves.toMatchObject({ network: NETWORK, credentialNumber: 1 });
  });

  it('rejects a recovered identity that does not bind the surviving issuance request without changing state', async () => {
    const fixture = await recoveryFixture();
    const mismatched = recoveringIdentity();
    mismatched.value.preIdentityObject.idCredSecCommitment = 'ff'.repeat(48);
    vi.mocked(fixture.fixture.provider.recover).mockResolvedValue(mismatched);
    await expect(fixture.workflow.recover(recoveryInput())).rejects.toMatchObject({ code: 'IDENTITY_MISMATCH' });
    await expect(fixture.store.load(NETWORK, IDENTITY_ID)).resolves.toEqual(fixture.existing);
    await expect(fixture.store.loadCredentials(NETWORK)).resolves.toEqual(fixture.credentials);
  });
});

describe('network-scoped identities with a shared SDK-derived id', () => {
  function networkContext(network: string) {
    return network === OTHER_NETWORK
      ? context({ network: OTHER_NETWORK, genesisHash: OTHER_GENESIS, sdkNetwork: 'Testnet' })
      : context();
  }

  function realWorkflow() {
    const fixture = setup();
    vi.mocked(fixture.provider.recover).mockResolvedValue(identityObject({
      ...requestObject().value, idCredPub: fixture.recovery.value.idCredPub,
    }));
    const createAccountObserver = vi.fn<AccountObserverFactory>(async (network) => vi.fn<AccountObserver>(async () => ({
      exists: false as const,
      sourceBlock: { hash: 'ab'.repeat(32), height: '7', time: new Date(NOW_MS).toISOString() },
      genesisHash: network === OTHER_NETWORK ? OTHER_GENESIS : GENESIS_HASH,
    })));
    const store = createEncryptedIdentityStore();
    const workflow = createIdentityWorkflow({
      ...fixture.deps,
      store,
      createAccountObserver,
      resolveNetwork: (selector?: string) => resolveConfiguredNetwork(selector).config.caip2.toLowerCase(),
      loadContext: async (input) => networkContext(input.network),
    });
    return { fixture, store, workflow };
  }

  it('creates and addresses independent same-id records in two compatible devnet directories', async () => {
    const { workflow, store } = realWorkflow();
    const localInput = { ...recoveryInput(), network: 'localnet' };
    const otherInput = { ...recoveryInput(), network: 'othernet' };

    await expect(workflow.recover(localInput)).resolves.toMatchObject({
      identityId: IDENTITY_ID, network: NETWORK, status: 'issued',
    });
    await expect(workflow.status({ network: 'othernet', identityId: IDENTITY_ID }))
      .rejects.toMatchObject({ code: 'IDENTITY_NOT_FOUND' });

    await expect(workflow.recover(otherInput)).resolves.toMatchObject({
      identityId: IDENTITY_ID, network: OTHER_NETWORK, status: 'issued',
    });
    await expect(workflow.status({ network: 'localnet', identityId: IDENTITY_ID }))
      .resolves.toMatchObject({ network: NETWORK, status: 'issued' });
    await expect(workflow.status({ network: 'othernet', identityId: IDENTITY_ID }))
      .resolves.toMatchObject({ network: OTHER_NETWORK, status: 'issued' });
    await expect(workflow.list({ network: 'localnet' })).resolves.toEqual([
      expect.objectContaining({ identityId: IDENTITY_ID, network: NETWORK }),
    ]);
    await expect(workflow.list({ network: 'othernet' })).resolves.toEqual([
      expect.objectContaining({ identityId: IDENTITY_ID, network: OTHER_NETWORK }),
    ]);
    await expect(workflow.prepareAccount({
      network: 'localnet', identityId: IDENTITY_ID, credentialNumber: 0,
      publicKeys: { '0': 'e6e387ecae9f68f3547da5546bf02d1ee071a7efb95a2e53781c9b482ef3d8e1' }, credentialThreshold: 1,
      expirySeconds: NOW_MS / 1000 + 600,
    })).resolves.toMatchObject({ network: NETWORK, credentialNumber: 0 });
    await expect(workflow.prepareAccount({
      network: 'othernet', identityId: IDENTITY_ID, credentialNumber: 0,
      publicKeys: { '0': 'e6e387ecae9f68f3547da5546bf02d1ee071a7efb95a2e53781c9b482ef3d8e1' }, credentialThreshold: 1,
      expirySeconds: NOW_MS / 1000 + 600,
    })).resolves.toMatchObject({ network: OTHER_NETWORK, credentialNumber: 0 });
    const localCredentials = await store.loadCredentials(NETWORK);
    const otherCredentials = await store.loadCredentials(OTHER_NETWORK);
    expect(Object.values(localCredentials.credentials)).toEqual([
      expect.objectContaining({ identityId: IDENTITY_ID, credentialNumber: 0, status: 'pending' }),
    ]);
    expect(Object.values(otherCredentials.credentials)).toEqual([
      expect.objectContaining({ identityId: IDENTITY_ID, credentialNumber: 0, status: 'pending' }),
    ]);
  });

  it('uses the persisted default without scanning a foreign network copy', async () => {
    const { workflow } = realWorkflow();
    await workflow.recover({ ...recoveryInput(), network: 'othernet' });
    await expect(workflow.status({ identityId: IDENTITY_ID })).rejects.toMatchObject({ code: 'IDENTITY_NOT_FOUND' });
    await expect(workflow.list({})).resolves.toEqual([]);
  });

  it('orders explicit override above CCD_NETWORK above the persisted default', async () => {
    const { workflow } = realWorkflow();
    await workflow.recover({ ...recoveryInput(), network: 'localnet' });
    await workflow.recover({ ...recoveryInput(), network: 'othernet' });

    process.env.CCD_NETWORK = 'othernet';
    await expect(workflow.status({ identityId: IDENTITY_ID })).resolves.toMatchObject({ network: OTHER_NETWORK });
    await expect(workflow.status({ network: 'localnet', identityId: IDENTITY_ID }))
      .resolves.toMatchObject({ network: NETWORK });

    delete process.env.CCD_NETWORK;
    await expect(workflow.status({ identityId: IDENTITY_ID })).resolves.toMatchObject({ network: NETWORK });
  });
});
