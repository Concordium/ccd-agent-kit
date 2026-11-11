import { createHash } from 'node:crypto';
import { access,readFile,rm,writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe,expect,it } from 'vitest';
import { IdentityWorkflowError } from '../../src/core/identityWorkflow.js';
import { createEncryptedIdentityStore } from '../../src/core/workflowInfrastructure.js';
import { SOURCE_ID,awaitingRecord,identityObject,selection } from '../workflowFixtures.js';
import { useTestXdg } from '../xdgTestHelpers.js';

useTestXdg('identity-labels-', ['XDG_DATA_HOME']);
const GENESIS = '12'.repeat(32);
const REFERENCE = GENESIS.slice(0, 32);
const NETWORK = { caip2: `ccd:${REFERENCE}`, genesisHash: GENESIS, sdkNetwork: 'Testnet' as const };
const OTHER_GENESIS = '34'.repeat(32);
const OTHER_NETWORK = {
  caip2: `ccd:${OTHER_GENESIS.slice(0, 32)}`, genesisHash: OTHER_GENESIS, sdkNetwork: 'Testnet' as const,
};
const ID = '0c2732b73f0fd1825be076132373f29a5c28e1c368d64bc1506ade16f955c965';
const OTHER_ID = '9'.repeat(64);
const KEY = Buffer.from('8895f2e19d42e303ccb66eae5dc748aee0f9b5d3cd8d74b83119a3e0d8f8b821', 'hex');
const ROOT_KEY = selection().rootPublicKey;

function indexRecord(label?: string, id = ID) {
  return {
    file: `${id}.json`, recipeVersion: 1 as const,
    ...(label === undefined ? {} : { label }),
    selection: {
      device: '12345678', rootPublicKey: ROOT_KEY,
      rootPublicKeyFingerprint: createHash('sha256').update(Buffer.from(ROOT_KEY, 'hex')).digest('hex'),
      identityProviderIndex: 7, identityIndex: 2,
      walletProxyUrl: 'https://wallet.example.test/',
    },
    workflow: { status: 'ready' as const, contextHash: '33'.repeat(32), idCredPub: '44'.repeat(48) },
  };
}

function record(id: string, identityIndex: number, label?: string) {
  const value = awaitingRecord();
  return {
    ...value,
    id,
    ...(label === undefined ? {} : { label }),
    selection: { ...value.selection, network: NETWORK.caip2, identityIndex },
  };
}

function root(): string {
  return path.join(process.env.XDG_DATA_HOME!, 'ccd-agent-kit', 'id-manager');
}

function indexPath(network = NETWORK): string {
  return path.join(root(), network.genesisHash.slice(0, 32), 'index.json');
}

async function workflow(store: ReturnType<typeof createEncryptedIdentityStore>, id: string) {
  const entry = (await store.readIndex(NETWORK.caip2)).identities[id];
  expect(entry).toBeDefined();
  if (!entry) throw new Error('missing test identity');
  return entry.workflow;
}

async function captureFailure(operation: () => Promise<unknown>): Promise<unknown> {
  try { await operation(); } catch (error) { return error; }
  throw new Error('Expected operation to fail');
}

describe('encrypted identity labels', () => {
  it('round-trips raw labels in the index while accepting legacy records without one', async () => {
    const store = createEncryptedIdentityStore();
    await store.bootstrapNetwork(NETWORK);
    const labeled = record(ID, 2, '@Agent_1');
    const legacy = record(OTHER_ID, 3);

    await store.create(labeled);
    await store.create(legacy);

    await expect(store.load(NETWORK.caip2, ID)).resolves.toEqual(labeled);
    await expect(store.load(NETWORK.caip2, OTHER_ID)).resolves.toEqual(legacy);
    expect((await store.readIndex(NETWORK.caip2)).identities[ID]?.label).toBe('@Agent_1');
    expect((await store.readIndex(NETWORK.caip2)).identities[OTHER_ID]).not.toHaveProperty('label');
  });

  it('lets operators replace any label and lets agents change only absent or marked labels', async () => {
    const store = createEncryptedIdentityStore();
    await store.bootstrapNetwork(NETWORK);
    await store.create(record(ID, 2));

    await expect(store.setIdentityLabel({
      network: NETWORK.caip2, identityId: ID, label: '@ted', authority: 'agent',
    })).resolves.toMatchObject({ id: ID, label: '@ted' });
    await expect(store.setIdentityLabel({
      network: NETWORK.caip2, identityId: ID, label: '@next', authority: 'agent',
    })).resolves.toMatchObject({ id: ID, label: '@next' });
    await expect(store.setIdentityLabel({
      network: NETWORK.caip2, identityId: ID, label: 'Protected', authority: 'operator',
    })).resolves.toMatchObject({ id: ID, label: 'Protected' });

    const before = await readFile(indexPath(), 'utf8');
    const failure = await captureFailure(() => store.setIdentityLabel({
      network: NETWORK.caip2, identityId: ID, label: '@Replacement', authority: 'agent',
    }));
    expect(failure).toBeInstanceOf(IdentityWorkflowError);
    expect(failure).toMatchObject({ code: 'LABEL_PROTECTED' });
    expect(await readFile(indexPath(), 'utf8')).toBe(before);
  });

  it('requires a canonical ID at the storage boundary rather than resolving a label twice', async () => {
    const store = createEncryptedIdentityStore();
    await store.bootstrapNetwork(NETWORK);
    await store.create(record(ID, 2, '@ted'));
    const before = await readFile(indexPath(), 'utf8');

    const failure = await captureFailure(() => store.setIdentityLabel({
      network: NETWORK.caip2, identityId: '@ted', label: 'Renamed', authority: 'operator',
    }));

    expect(failure).toBeInstanceOf(IdentityWorkflowError);
    expect(failure).toMatchObject({ code: 'INVALID_INPUT' });
    expect(await readFile(indexPath(), 'utf8')).toBe(before);
  });

  it('does not initialize empty network state when labeling an unknown identity', async () => {
    const store = createEncryptedIdentityStore();
    const failure = await captureFailure(() => store.setIdentityLabel({
      network: NETWORK.caip2, identityId: ID, label: 'Unknown', authority: 'operator',
    }));

    expect(failure).toBeInstanceOf(IdentityWorkflowError);
    expect(failure).toMatchObject({ code: 'IDENTITY_NOT_FOUND' });
    await expect(store.listIdentityReservations({
      genesisHash: GENESIS, sourceId: SOURCE_ID, sdkNetwork: 'Testnet', identityProviderIndex: 7,
    })).resolves.toEqual([]);
    await expect(access(path.dirname(indexPath()))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('supports same-entity promotion and enforces one case-insensitive bare namespace', async () => {
    const store = createEncryptedIdentityStore();
    await store.bootstrapNetwork(NETWORK);
    await store.create(record(ID, 2, '@ted'));
    await store.create(record(OTHER_ID, 3));

    await expect(store.setIdentityLabel({
      network: NETWORK.caip2, identityId: ID, label: 'ted', authority: 'operator',
    })).resolves.toMatchObject({ label: 'ted' });
    const failure = await captureFailure(() => store.setIdentityLabel({
      network: NETWORK.caip2, identityId: OTHER_ID, label: '@TED', authority: 'operator',
    }));
    expect(failure).toBeInstanceOf(IdentityWorkflowError);
    expect(failure).toMatchObject({ code: 'LABEL_IN_USE' });
    await expect(store.load(NETWORK.caip2, OTHER_ID)).resolves.not.toHaveProperty('label');
  });

  it('guards initial label uniqueness without changing the index', async () => {
    const store = createEncryptedIdentityStore();
    await store.bootstrapNetwork(NETWORK);
    await store.create(record(ID, 2, 'taken'));
    const before = await readFile(indexPath(), 'utf8');

    const failure = await captureFailure(() => store.create(record(OTHER_ID, 3, '@TAKEN')));
    expect(failure).toBeInstanceOf(IdentityWorkflowError);
    expect(failure).toMatchObject({ code: 'LABEL_IN_USE' });
    expect(await readFile(indexPath(), 'utf8')).toBe(before);
  });

  it('reports an unknown identity without changing the index', async () => {
    const store = createEncryptedIdentityStore();
    await store.bootstrapNetwork(NETWORK);
    const before = await readFile(indexPath(), 'utf8');

    const failure = await captureFailure(() => store.setIdentityLabel({
      network: NETWORK.caip2, identityId: ID, label: '@valid', authority: 'agent',
    }));
    expect(failure).toBeInstanceOf(IdentityWorkflowError);
    expect(failure).toMatchObject({ code: 'IDENTITY_NOT_FOUND' });
    expect(await readFile(indexPath(), 'utf8')).toBe(before);
  });

  it('allows the same bare label in two canonical network indexes', async () => {
    const store = createEncryptedIdentityStore();
    await store.bootstrapNetwork(NETWORK);
    await store.bootstrapNetwork(OTHER_NETWORK);
    await store.create(record(ID, 2, '@shared'));
    const other = record(OTHER_ID, 3, 'shared');
    other.selection = { ...other.selection, network: OTHER_NETWORK.caip2 };

    await expect(store.create(other)).resolves.toBeUndefined();
    await expect(store.load(NETWORK.caip2, ID)).resolves.toMatchObject({ label: '@shared' });
    await expect(store.load(OTHER_NETWORK.caip2, OTHER_ID)).resolves.toMatchObject({ label: 'shared' });
  });

  it('changes only label metadata while holding the global reservation lock', async () => {
    const store = createEncryptedIdentityStore();
    await store.bootstrapNetwork(NETWORK);
    await store.createIdentity(NETWORK, ID, indexRecord('@old'), identityObject(), KEY, null);
    const cipherPath = path.join(root(), REFERENCE, `${ID}.json`);
    const ciphertext = await readFile(cipherPath, 'utf8');
    const before = await store.readIndex(NETWORK.caip2);
    const reservationPath = path.join(root(), 'identity-reservations.json');
    const reservations = await readFile(reservationPath, 'utf8');

    await store.setIdentityLabel({
      network: NETWORK.caip2, identityId: ID, label: '@new', authority: 'agent',
    });
    const after = await store.readIndex(NETWORK.caip2);
    expect(after.identities[ID]).toEqual({ ...before.identities[ID], label: '@new' });
    expect(await readFile(cipherPath, 'utf8')).toBe(ciphertext);
    expect(await readFile(reservationPath, 'utf8')).toBe(reservations);

    const lock = path.join(root(), '.identity-reservations.mutation.lock');
    await writeFile(lock, 'held', { flag: 'wx', mode: 0o600 });
    const lockedIndex = await readFile(indexPath(), 'utf8');
    const failure = await captureFailure(() => store.setIdentityLabel({
      network: NETWORK.caip2, identityId: ID, label: '@blocked', authority: 'agent',
    }));
    expect(failure).toBeInstanceOf(IdentityWorkflowError);
    expect(failure).toMatchObject({ code: 'STORAGE_FAILED' });
    expect(await readFile(indexPath(), 'utf8')).toBe(lockedIndex);
    expect(await readFile(lock, 'utf8')).toBe('held');
  });

  it('persists explicit removal as an absent authenticated index field and reloads the identity unlabeled', async () => {
    const store = createEncryptedIdentityStore();
    await store.bootstrapNetwork(NETWORK);
    await store.createIdentity(NETWORK, ID, indexRecord('@Initial'), identityObject(), KEY, null);
    const cipherPath = path.join(root(), REFERENCE, `${ID}.json`);
    const ciphertext = await readFile(cipherPath, 'utf8');

    await expect(store.setIdentityLabel({
      network: NETWORK.caip2, identityId: ID, authority: 'operator', operation: 'remove',
    })).resolves.not.toHaveProperty('label');
    const persisted = JSON.parse(await readFile(indexPath(), 'utf8')) as {
      identities: Record<string, { label?: string }>;
    };
    expect(persisted.identities[ID]).not.toHaveProperty('label');
    expect(await readFile(cipherPath, 'utf8')).toBe(ciphertext);

    const reloaded = createEncryptedIdentityStore();
    await expect(reloaded.load(NETWORK.caip2, ID)).resolves.not.toHaveProperty('label');
    await expect(reloaded.loadIdentity(NETWORK.caip2, ID, KEY)).resolves.toEqual(identityObject());
  });

  it('preserves a concurrent rename across stale workflow save, completion, and restore inputs', async () => {
    const store = createEncryptedIdentityStore();
    await store.bootstrapNetwork(NETWORK);
    const original = record(ID, 2, '@old');
    await store.create(original);
    const snapshot = (await store.readIndex(NETWORK.caip2)).identities[ID];
    expect(snapshot).toBeDefined();
    if (!snapshot) throw new Error('missing test identity');
    await store.setIdentityLabel({
      network: NETWORK.caip2, identityId: ID, label: 'OperatorName', authority: 'operator',
    });

    await store.save({ ...original, status: 'pending' }, snapshot.workflow);
    expect((await store.load(NETWORK.caip2, ID)).label).toBe('OperatorName');
    const pendingWorkflow = await workflow(store, ID);
    const completed = { ...snapshot, workflow: {
      status: 'ready' as const, contextHash: pendingWorkflow.contextHash, idCredPub: pendingWorkflow.idCredPub,
    } };
    await store.createIdentity(NETWORK, ID, completed, identityObject(), KEY, pendingWorkflow);
    expect((await store.readIndex(NETWORK.caip2)).identities[ID]?.label).toBe('OperatorName');

    await rm(path.join(root(), REFERENCE, `${ID}.json`));
    await store.restoreIdentity(NETWORK, ID, completed, identityObject(), KEY, completed.workflow);
    expect((await store.readIndex(NETWORK.caip2)).identities[ID]?.label).toBe('OperatorName');
  });

  it.each([
    ['invalid label', (document: { identities: Record<string, { label?: string }> }) => {
      document.identities[ID]!.label = 'not valid';
    }],
    ['duplicate bare labels', (document: { identities: Record<string, { label?: string }> }) => {
      document.identities[ID]!.label = '@Same';
      document.identities[OTHER_ID]!.label = 'same';
    }],
  ])('fails closed on persisted %s and preserves the corrupt file', async (_case, corrupt) => {
    const store = createEncryptedIdentityStore();
    await store.bootstrapNetwork(NETWORK);
    await store.create(record(ID, 2, '@first'));
    await store.create(record(OTHER_ID, 3, '@second'));
    const document = JSON.parse(await readFile(indexPath(), 'utf8'));
    corrupt(document);
    const contents = `${JSON.stringify(document)}\n`;
    await writeFile(indexPath(), contents, { mode: 0o600 });

    await expect(store.readIndex(NETWORK.caip2)).rejects.toMatchObject({ code: 'STORAGE_FAILED' });
    await expect(store.setIdentityLabel({
      network: NETWORK.caip2, identityId: ID, label: '@replacement', authority: 'agent',
    })).rejects.toMatchObject({ code: 'STORAGE_FAILED' });
    expect(await readFile(indexPath(), 'utf8')).toBe(contents);
  });

  it('rejects label metadata misplaced inside workflow without changing the file', async () => {
    const store = createEncryptedIdentityStore();
    await store.bootstrapNetwork(NETWORK);
    await store.create(record(ID, 2, '@protected'));
    const document = JSON.parse(await readFile(indexPath(), 'utf8'));
    document.identities[ID].workflow.label = '@override';
    const contents = `${JSON.stringify(document)}\n`;
    await writeFile(indexPath(), contents, { mode: 0o600 });

    await expect(store.readIndex(NETWORK.caip2)).rejects.toMatchObject({ code: 'STORAGE_FAILED' });
    await expect(store.setIdentityLabel({
      network: NETWORK.caip2, identityId: ID, label: '@replacement', authority: 'agent',
    })).rejects.toMatchObject({ code: 'STORAGE_FAILED' });
    expect(await readFile(indexPath(), 'utf8')).toBe(contents);
  });

  it('rejects a valid index stored under a different canonical network without changing either file', async () => {
    const store = createEncryptedIdentityStore();
    await store.bootstrapNetwork(NETWORK);
    await store.bootstrapNetwork(OTHER_NETWORK);
    await store.create(record(ID, 2, '@first'));
    const other = record(OTHER_ID, 3, '@other');
    other.selection = { ...other.selection, network: OTHER_NETWORK.caip2 };
    await store.create(other);
    const otherContents = await readFile(indexPath(OTHER_NETWORK), 'utf8');
    await writeFile(indexPath(), otherContents, { mode: 0o600 });

    await expect(store.setIdentityLabel({
      network: NETWORK.caip2, identityId: ID, label: '@replacement', authority: 'agent',
    })).rejects.toMatchObject({ code: 'STORAGE_FAILED' });
    expect(await readFile(indexPath(), 'utf8')).toBe(otherContents);
    expect(await readFile(indexPath(OTHER_NETWORK), 'utf8')).toBe(otherContents);
  });

  it('rejects an invalid recovery label before creating ciphertext or index metadata', async () => {
    const store = createEncryptedIdentityStore();
    await store.bootstrapNetwork(NETWORK);

    const failure = await captureFailure(() => store.createIdentity(
      NETWORK, ID, indexRecord('@'), identityObject(), KEY, null,
    ));
    expect(failure).toBeInstanceOf(IdentityWorkflowError);
    expect(failure).toMatchObject({ code: 'INVALID_INPUT' });
    await expect(access(path.join(root(), REFERENCE, `${ID}.json`))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(store.readIndex(NETWORK.caip2)).resolves.toMatchObject({ identities: {} });
  });

  it('rejects a colliding label on direct encrypted identity creation', async () => {
    const store = createEncryptedIdentityStore();
    await store.bootstrapNetwork(NETWORK);
    await store.create(record(ID, 2, 'taken'));
    const before = await readFile(indexPath(), 'utf8');

    const failure = await captureFailure(() => store.createIdentity(
      NETWORK, OTHER_ID, indexRecord('@TAKEN', OTHER_ID), identityObject(), KEY, null,
    ));
    expect(failure).toBeInstanceOf(IdentityWorkflowError);
    expect(failure).toMatchObject({ code: 'LABEL_IN_USE' });
    expect(await readFile(indexPath(), 'utf8')).toBe(before);
    await expect(access(path.join(root(), REFERENCE, `${OTHER_ID}.json`))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
