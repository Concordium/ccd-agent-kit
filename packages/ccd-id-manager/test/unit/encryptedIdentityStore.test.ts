import { deriveIdentitySourceId } from '@ccd-agent-kit/config-utils';
import { MAINNET_GENESIS_HASH } from '@ccd-agent-kit/sdk-utils';
import { createHash } from 'node:crypto';
import { mkdir,readFile,readdir,rm,stat,symlink,writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe,expect,it } from 'vitest';
import { createEncryptedIdentityStore } from '../../src/core/workflowInfrastructure.js';
import { awaitingRecord,identityObject,selection } from '../workflowFixtures.js';
import { useTestXdg } from '../xdgTestHelpers.js';

const GENESIS = '12'.repeat(32);
const REFERENCE = GENESIS.slice(0, 32);
const NETWORK = { caip2: `ccd:${REFERENCE}`, genesisHash: GENESIS, sdkNetwork: 'Testnet' as const };
const ID = '0c2732b73f0fd1825be076132373f29a5c28e1c368d64bc1506ade16f955c965';
const KEY = Buffer.from('8895f2e19d42e303ccb66eae5dc748aee0f9b5d3cd8d74b83119a3e0d8f8b821', 'hex');
const ROOT_KEY = selection().rootPublicKey;
const SOURCE_ID = deriveIdentitySourceId(selection().rootPublicKey, 1);

function indexRecord() {
  return {
    file: `${ID}.json`, recipeVersion: 1 as const,
    selection: {
      device: '12345678', rootPublicKey: ROOT_KEY,
      rootPublicKeyFingerprint: createHash('sha256').update(Buffer.from(ROOT_KEY, 'hex')).digest('hex'), identityProviderIndex: 7, identityIndex: 2,
      walletProxyUrl: 'https://wallet.example.test/',
    },
    workflow: { status: 'ready' as const, contextHash: '33'.repeat(32), idCredPub: '44'.repeat(48) },
  };
}

async function workflow(store: ReturnType<typeof createEncryptedIdentityStore>, id: string) {
  const entry = (await store.readIndex(NETWORK.caip2)).identities[id];
  expect(entry).toBeDefined();
  if (!entry) throw new Error('missing test identity');
  return entry.workflow;
}

async function bootstrappedStore() {
  const store = createEncryptedIdentityStore();
  await store.bootstrapNetwork(NETWORK);
  return store;
}

const xdg = useTestXdg('encrypted-store-', ['XDG_DATA_HOME']);

describe('network-scoped encrypted identity store', () => {
  it('fails closed when a canonical network scope is missing', async () => {
    const store = createEncryptedIdentityStore();
    await expect(Reflect.apply(store.list, store, [undefined]))
      .rejects.toMatchObject({ code: 'STORAGE_FAILED' });
  });

  it('sanitizes a missing mutation scope before running the operation', async () => {
    const store = createEncryptedIdentityStore();
    let called = false;
    await expect(Reflect.apply(store.withMutation, store, [undefined, async () => { called = true; }]))
      .rejects.toMatchObject({ code: 'STORAGE_FAILED' });
    expect(called).toBe(false);
  });

  it('lists nothing before the encrypted store exists', async () => {
    await expect(createEncryptedIdentityStore().list(NETWORK.caip2)).resolves.toEqual([]);
  });

  it('creates, updates, loads, and lists registry-only workflow metadata', async () => {
    const store = await bootstrappedStore();
    const record = awaitingRecord();
    record.selection = { ...selection(), network: NETWORK.caip2 };
    await store.create(record);
    await expect(store.load(NETWORK.caip2, record.id)).resolves.toEqual(record);
    await expect(store.list(NETWORK.caip2)).resolves.toEqual([record]);

    const pending = { ...record, status: 'pending' as const, retrievalUrl: 'https://issuer.example.test/result' };
    await store.save(pending, await workflow(store, record.id));
    await expect(store.load(NETWORK.caip2, record.id)).resolves.toEqual(pending);
    await expect(store.create(record)).rejects.toMatchObject({ code: 'STORAGE_FAILED' });
    await expect(store.load(NETWORK.caip2, 'ff'.repeat(32))).rejects.toMatchObject({ code: 'IDENTITY_NOT_FOUND' });
  });

  it('preserves legacy records and validates request attempt identifiers', async () => {
    const store = await bootstrappedStore();
    const legacy = awaitingRecord();
    legacy.selection = { ...selection(), network: NETWORK.caip2 };
    delete (legacy as { requestAttemptId?: string }).requestAttemptId;
    await store.create(legacy);
    await expect(store.load(NETWORK.caip2, legacy.id)).resolves.not.toHaveProperty('requestAttemptId');

    const current = awaitingRecord();
    current.id = '9'.repeat(64);
    current.selection = { ...selection(), network: NETWORK.caip2, identityIndex: 3 };
    Object.assign(current, { requestAttemptId: '11111111-1111-4111-8111-111111111111' });
    await store.create(current);
    await expect(store.load(NETWORK.caip2, current.id)).resolves.toMatchObject({
      requestAttemptId: '11111111-1111-4111-8111-111111111111',
    });
    await expect(store.create({ ...current, id: '8'.repeat(64), requestAttemptId: 'not-a-uuid' } as never))
      .rejects.toMatchObject({ code: 'STORAGE_FAILED' });
  });

  it('rejects a stale workflow save even when deterministic request fields are unchanged', async () => {
    const store = await bootstrappedStore();
    const original = awaitingRecord();
    original.selection = { ...selection(), network: NETWORK.caip2 };
    Object.assign(original, { requestAttemptId: '11111111-1111-4111-8111-111111111111' });
    await store.create(original);
    const scope = {
      genesisHash: GENESIS, sourceId: SOURCE_ID, sdkNetwork: 'Testnet' as const,
      identityProviderIndex: original.selection.identityProviderIndex,
    };
    await store.listExpiredIdentityReservations(scope, Date.now(), 1);
    const oldEntry = (await store.readIndex(NETWORK.caip2)).identities[original.id];
    expect(oldEntry).toBeDefined();
    if (!oldEntry) throw new Error('missing test identity');
    const oldWorkflow = oldEntry.workflow;
    const newer = { ...original, requestAttemptId: '22222222-2222-4222-8222-222222222222' };
    await store.save(newer, oldWorkflow);
    const reservationPath = path.join(process.env.XDG_DATA_HOME!, 'ccd-agent-kit', 'id-manager', 'identity-reservations.json');
    const reservationBefore = await readFile(reservationPath, 'utf8');

    await expect(store.save({
      ...original, status: 'error', confirmedFailure: {
        kind: 'authenticated_key_failure', requestAttemptId: original.requestAttemptId!,
      },
    }, oldWorkflow, 'failed'))
      .rejects.toMatchObject({ code: 'INDEX_UNAVAILABLE' });
    await expect(store.load(NETWORK.caip2, original.id)).resolves.toEqual(newer);
    expect(await readFile(reservationPath, 'utf8')).toBe(reservationBefore);

    await store.save({
      ...newer, status: 'error', confirmedFailure: {
        kind: 'authenticated_key_failure', requestAttemptId: newer.requestAttemptId,
      },
    }, await workflow(store, original.id), 'failed');
    expect(JSON.parse(await readFile(reservationPath, 'utf8')).reservations)
      .toContainEqual(expect.objectContaining({ identityIndex: original.selection.identityIndex, state: 'failed' }));
  });

  it('rejects a failed reservation transition without matching authenticated failure provenance', async () => {
    const store = await bootstrappedStore();
    const original = awaitingRecord();
    original.selection = { ...selection(), network: NETWORK.caip2 };
    original.requestAttemptId = '11111111-1111-4111-8111-111111111111';
    await store.create(original);
    const previous = await workflow(store, original.id);
    await expect(store.save({ ...original, status: 'error' }, previous, 'failed'))
      .rejects.toMatchObject({ code: 'STORAGE_FAILED' });
    await expect(store.load(NETWORK.caip2, original.id)).resolves.toEqual(original);
  });

  it('promotes a released historical reservation when the error workflow save commits', async () => {
    const store = await bootstrappedStore();
    const original = awaitingRecord();
    original.selection = { ...selection(), network: NETWORK.caip2 };
    original.requestAttemptId = '11111111-1111-4111-8111-111111111111';
    delete original.sourceId;
    await store.create(original);
    const expectedWorkflow = await workflow(store, original.id);
    const scope = {
      genesisHash: GENESIS, sourceId: SOURCE_ID, sdkNetwork: 'Testnet' as const,
      identityProviderIndex: original.selection.identityProviderIndex,
    };
    await store.listExpiredIdentityReservations(scope, Date.now(), 1);
    const reservationPath = path.join(process.env.XDG_DATA_HOME!, 'ccd-agent-kit', 'id-manager', 'identity-reservations.json');
    const [reservation] = JSON.parse(await readFile(reservationPath, 'utf8')).reservations;
    await store.resolveIdentityReservation({
      ...scope, identityIndex: original.selection.identityIndex, reservedAt: reservation.reservedAt,
      state: 'released', expectedWorkflow,
    });

    await store.save({
      ...original, status: 'error', confirmedFailure: {
        kind: 'authenticated_key_failure', requestAttemptId: original.requestAttemptId,
      },
    }, await workflow(store, original.id), 'failed');

    await expect(store.load(NETWORK.caip2, original.id)).resolves.toMatchObject({ status: 'error' });
    expect(JSON.parse(await readFile(reservationPath, 'utf8')).reservations)
      .toContainEqual(expect.objectContaining({ identityIndex: original.selection.identityIndex, state: 'failed' }));
  });

  it('promotes a released reservation only when identity completion wins its workflow CAS', async () => {
    const store = await bootstrappedStore();
    const original = awaitingRecord();
    original.selection = { ...selection(), network: NETWORK.caip2 };
    await store.create(original);
    const index = await store.readIndex(NETWORK.caip2);
    const entry = index.identities[original.id];
    expect(entry).toBeDefined();
    if (!entry) throw new Error('missing test identity');
    const scope = {
      genesisHash: GENESIS, sourceId: SOURCE_ID, sdkNetwork: 'Testnet' as const,
      identityProviderIndex: original.selection.identityProviderIndex,
    };
    await store.listExpiredIdentityReservations(scope, Date.now(), 1);
    const reservationPath = path.join(process.env.XDG_DATA_HOME!, 'ccd-agent-kit', 'id-manager', 'identity-reservations.json');
    const [reservation] = JSON.parse(await readFile(reservationPath, 'utf8')).reservations;
    await store.resolveIdentityReservation({
      ...scope, identityIndex: original.selection.identityIndex, reservedAt: reservation.reservedAt,
      state: 'released', expectedWorkflow: entry.workflow,
    });

    await store.createIdentity(NETWORK, original.id, {
      ...entry, workflow: {
        status: 'ready', contextHash: entry.workflow.contextHash, idCredPub: entry.workflow.idCredPub,
      },
    }, identityObject(), KEY, await workflow(store, original.id));

    await expect(store.loadIdentity(NETWORK.caip2, original.id, KEY)).resolves.toEqual(identityObject());
    expect(JSON.parse(await readFile(reservationPath, 'utf8')).reservations)
      .toContainEqual(expect.objectContaining({ identityIndex: original.selection.identityIndex, state: 'used' }));
  });

  it('promotes the active reservation when identity completion wins its workflow CAS', async () => {
    const store = await bootstrappedStore();
    const original = awaitingRecord();
    original.selection = { ...selection(), network: NETWORK.caip2 };
    await store.create(original);
    const index = await store.readIndex(NETWORK.caip2);
    const entry = index.identities[original.id];
    expect(entry).toBeDefined();
    if (!entry) throw new Error('missing test identity');
    const scope = {
      genesisHash: GENESIS, sourceId: SOURCE_ID, sdkNetwork: 'Testnet' as const,
      identityProviderIndex: original.selection.identityProviderIndex,
    };
    await store.listExpiredIdentityReservations(scope, Date.now(), 1);

    await store.createIdentity(NETWORK, original.id, {
      ...entry, workflow: {
        status: 'ready', contextHash: entry.workflow.contextHash, idCredPub: entry.workflow.idCredPub,
      },
    }, identityObject(), KEY, entry.workflow);

    const reservationPath = path.join(process.env.XDG_DATA_HOME!, 'ccd-agent-kit', 'id-manager', 'identity-reservations.json');
    expect(JSON.parse(await readFile(reservationPath, 'utf8')).reservations)
      .toContainEqual(expect.objectContaining({ identityIndex: original.selection.identityIndex, state: 'used' }));
  });

  it('rejects saving absent identity metadata without creating reservation state', async () => {
    const store = createEncryptedIdentityStore();
    await store.bootstrapNetwork(NETWORK);
    const missing = awaitingRecord();
    missing.selection = { ...selection(), network: NETWORK.caip2 };

    const expectedWorkflow = {
      status: missing.status, contextHash: missing.contextHash, idCredPub: missing.idCredPub,
      ...(missing.request === undefined ? {} : { request: missing.request }),
      ...(missing.retrievalUrl === undefined ? {} : { retrievalUrl: missing.retrievalUrl }),
      ...(missing.requestAttemptId === undefined ? {} : { requestAttemptId: missing.requestAttemptId }),
    };
    await expect(store.save(missing, expectedWorkflow)).rejects.toMatchObject({ code: 'STORAGE_FAILED' });
    await expect(store.list(NETWORK.caip2)).resolves.toEqual([]);
  });

  it('rejects missing and stale completion snapshots before creating ciphertext', async () => {
    const store = createEncryptedIdentityStore();
    await store.bootstrapNetwork(NETWORK);
    const original = awaitingRecord();
    original.selection = { ...selection(), network: NETWORK.caip2 };
    Object.assign(original, { requestAttemptId: '11111111-1111-4111-8111-111111111111' });
    await store.create(original);
    const scope = {
      genesisHash: GENESIS, sourceId: SOURCE_ID, sdkNetwork: 'Testnet' as const,
      identityProviderIndex: original.selection.identityProviderIndex,
    };
    await store.listExpiredIdentityReservations(scope, Date.now(), 1);
    const originalIndex = await store.readIndex(NETWORK.caip2);
    const originalEntry = originalIndex.identities[original.id];
    expect(originalEntry).toBeDefined();
    if (!originalEntry) throw new Error('missing test identity');
    const completed = { ...originalEntry, workflow: {
      status: 'ready' as const, contextHash: originalEntry.workflow.contextHash,
      idCredPub: originalEntry.workflow.idCredPub,
    } };
    const reservationPath = path.join(process.env.XDG_DATA_HOME!, 'ccd-agent-kit', 'id-manager', 'identity-reservations.json');
    const reservationBeforeMissingCas = await readFile(reservationPath, 'utf8');

    await expect(store.createIdentity(NETWORK, original.id, completed, identityObject(), KEY, null))
      .rejects.toMatchObject({ code: 'INDEX_UNAVAILABLE' });
    expect(await readFile(reservationPath, 'utf8')).toBe(reservationBeforeMissingCas);
    const newer = { ...original, requestAttemptId: '22222222-2222-4222-8222-222222222222' };
    await store.save(newer, originalEntry.workflow);
    const reservationBefore = await readFile(reservationPath, 'utf8');
    await expect(store.createIdentity(NETWORK, original.id, completed, identityObject(), KEY, originalEntry.workflow))
      .rejects.toMatchObject({ code: 'INDEX_UNAVAILABLE' });

    await expect(store.load(NETWORK.caip2, original.id)).resolves.toEqual(newer);
    const ciphertext = path.join(process.env.XDG_DATA_HOME!, 'ccd-agent-kit', 'id-manager', REFERENCE, `${original.id}.json`);
    await expect(readFile(ciphertext)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(reservationPath, 'utf8')).toBe(reservationBefore);
  });

  it('blocks identity metadata mutation while the global reservation lock is held', async () => {
    const store = createEncryptedIdentityStore();
    await store.bootstrapNetwork(NETWORK);
    const record = awaitingRecord();
    record.selection = { ...selection(), network: NETWORK.caip2 };
    await store.create(record);
    const expectedWorkflow = await workflow(store, record.id);
    const indexBefore = await store.readIndex(NETWORK.caip2);
    const lock = path.join(process.env.XDG_DATA_HOME!, 'ccd-agent-kit', 'id-manager', '.identity-reservations.mutation.lock');
    await writeFile(lock, 'held', { flag: 'wx', mode: 0o600 });

    await expect(store.save({ ...record, status: 'pending' }, expectedWorkflow))
      .rejects.toMatchObject({ code: 'STORAGE_FAILED' });
    await expect(store.readIndex(NETWORK.caip2)).resolves.toEqual(indexBefore);
    expect(await readFile(lock, 'utf8')).toBe('held');
  });

  it('rejects unsafe ciphertext identifiers without changing the network index', async () => {
    const store = createEncryptedIdentityStore();
    await store.bootstrapNetwork(NETWORK);
    const before = await store.readIndex(NETWORK.caip2);
    await expect(store.createIdentity(NETWORK, '../outside', indexRecord(), identityObject(), KEY, null))
      .rejects.toMatchObject({ code: 'STORAGE_FAILED' });
    expect(await store.readIndex(NETWORK.caip2)).toEqual(before);
  });

  it('adds only a deterministic source association to a historical record and makes it immutable', async () => {
    const store = createEncryptedIdentityStore();
    await store.bootstrapNetwork(NETWORK);
    const historical = awaitingRecord();
    historical.selection = { ...selection(), network: NETWORK.caip2 };
    delete (historical as { sourceId?: string }).sourceId;
    await store.create(historical);

    const associated = { ...historical, sourceId: SOURCE_ID };
    await store.save(associated, await workflow(store, historical.id));
    await expect(store.load(NETWORK.caip2, historical.id)).resolves.toEqual(associated);
    expect((await store.readIndex(NETWORK.caip2)).identities[historical.id]).toMatchObject({ sourceId: SOURCE_ID });

    await expect(store.save({ ...associated, sourceId: 'ir:aaaaaaaaaaaaaaa' }, await workflow(store, historical.id)))
      .rejects.toMatchObject({ code: 'STORAGE_FAILED' });
    await expect(store.save(historical, await workflow(store, historical.id))).rejects.toMatchObject({ code: 'STORAGE_FAILED' });
    await expect(store.load(NETWORK.caip2, historical.id)).resolves.toEqual(associated);
  });

  it('rejects a source association that does not derive from the complete stored root pin', async () => {
    const store = createEncryptedIdentityStore();
    await store.bootstrapNetwork(NETWORK);
    const record = { ...awaitingRecord(), sourceId: 'ir:aaaaaaaaaaaaaaa' };
    record.selection = { ...selection(), network: NETWORK.caip2 };
    await expect(store.create(record)).rejects.toMatchObject({ code: 'STORAGE_FAILED' });
    await expect(store.list(NETWORK.caip2)).resolves.toEqual([]);
  });

  it('associates a historical encrypted identity without rewriting ciphertext or cryptographic bindings', async () => {
    const store = createEncryptedIdentityStore();
    await store.bootstrapNetwork(NETWORK);
    await store.createIdentity(NETWORK, ID, indexRecord(), identityObject(), KEY, null);
    const directory = path.join(process.env.XDG_DATA_HOME!, 'ccd-agent-kit', 'id-manager', REFERENCE);
    const encryptedPath = path.join(directory, `${ID}.json`);
    const ciphertext = await readFile(encryptedPath, 'utf8');
    const historical = await store.load(NETWORK.caip2, ID);

    await store.save({ ...historical, sourceId: SOURCE_ID }, await workflow(store, ID));

    expect(await readFile(encryptedPath, 'utf8')).toBe(ciphertext);
    await expect(store.load(NETWORK.caip2, ID)).resolves.toMatchObject({
      sourceId: SOURCE_ID,
      contextHash: indexRecord().workflow.contextHash,
      selection: {
        rootPublicKey: ROOT_KEY,
        identityProviderIndex: indexRecord().selection.identityProviderIndex,
        identityIndex: indexRecord().selection.identityIndex,
      },
    });
    await expect(store.loadIdentity(NETWORK.caip2, ID, KEY)).resolves.toEqual(identityObject());
  });

  it('allows the same identity id in multiple networks without global lookup or fallback', async () => {
    const store = createEncryptedIdentityStore();
    const record = { ...awaitingRecord(), status: 'pending' as const };
    delete (record as { request?: unknown }).request;
    record.selection = { ...selection(), network: NETWORK.caip2 };
    await store.bootstrapNetwork(NETWORK);
    await store.create(record);
    const root = path.join(process.env.XDG_DATA_HOME!, 'ccd-agent-kit', 'id-manager');
    await writeFile(path.join(root, 'README'), 'unrelated');

    const other = { caip2: `ccd:${'34'.repeat(16)}`, genesisHash: '34'.repeat(32), sdkNetwork: 'Testnet' as const };
    await store.bootstrapNetwork(other);
    await store.create({ ...record, selection: { ...record.selection, network: other.caip2 } });

    await expect(store.list(NETWORK.caip2)).resolves.toEqual([record]);
    await expect(store.list(other.caip2)).resolves.toEqual([
      { ...record, selection: { ...record.selection, network: other.caip2 } },
    ]);
    await expect(store.load(NETWORK.caip2, record.id)).resolves.toEqual(record);
    await expect(store.load(other.caip2, record.id)).resolves.toMatchObject({
      selection: { network: other.caip2 },
    });
    await expect(store.load(`ccd:${'56'.repeat(16)}`, record.id)).rejects.toMatchObject({ code: 'IDENTITY_NOT_FOUND' });
    await expect(store.load(NETWORK.caip2, 'not-an-identity')).rejects.toMatchObject({ code: 'STORAGE_FAILED' });
  });

  it('bootstraps exact immutable node genesis and SDK namespace metadata and writes no plaintext identity', async () => {
    const store = createEncryptedIdentityStore();
    await store.bootstrapNetwork(NETWORK);
    await store.createIdentity(NETWORK, ID, indexRecord(), identityObject(), KEY, null);

    const directory = path.join(process.env.XDG_DATA_HOME!, 'ccd-agent-kit', 'id-manager', REFERENCE);
    const index = JSON.parse(await readFile(path.join(directory, 'index.json'), 'utf8'));
    expect(index).toEqual({ version: 1, network: NETWORK, identities: { [ID]: indexRecord() } });
    expect(JSON.parse(await readFile(path.join(directory, 'credentials.json'), 'utf8'))).toEqual({
      version: 1, credentials: {},
    });
    const encrypted = JSON.parse(await readFile(path.join(directory, `${ID}.json`), 'utf8'));
    expect(encrypted).toMatchObject({ version: 1, type: 'ccd-id-manager.identity', cipher: 'aes-256-gcm' });
    expect(JSON.stringify(encrypted)).not.toMatch(/Ada|chosenAttributes|preIdentityObject/);
    expect(JSON.parse(await readFile(path.join(process.env.XDG_DATA_HOME!, 'ccd-agent-kit', 'id-manager', 'identity-reservations.json'), 'utf8')).reservations)
      .toContainEqual(expect.objectContaining({ identityIndex: indexRecord().selection.identityIndex, state: 'used' }));
    await expect(store.loadIdentity(NETWORK.caip2, ID, KEY)).resolves.toEqual(identityObject());
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    for (const file of ['index.json', 'credentials.json', `${ID}.json`]) {
      expect((await stat(path.join(directory, file))).mode & 0o777).toBe(0o600);
    }
  });

  it.each([
    { genesisHash: '34'.repeat(32) },
    { genesisHash: `${REFERENCE}${'34'.repeat(16)}` },
    { sdkNetwork: 'Mainnet' as const },
    { caip2: `ccd:${'34'.repeat(16)}` },
  ])('rejects network bootstrap mutation and preserves the original index (%j)', async (change) => {
    const store = createEncryptedIdentityStore();
    await store.bootstrapNetwork(NETWORK);
    await expect(store.bootstrapNetwork({ ...NETWORK, ...change })).rejects.toMatchObject({ code: 'STORAGE_FAILED' });
    await expect(store.readIndex(NETWORK.caip2)).resolves.toMatchObject({ network: NETWORK, identities: {} });
  });

  it('persists the SDK Mainnet namespace only for the official full Mainnet genesis', async () => {
    const mainnet = {
      caip2: `ccd:${MAINNET_GENESIS_HASH.slice(0, 32)}`,
      genesisHash: MAINNET_GENESIS_HASH,
      sdkNetwork: 'Mainnet' as const,
    };
    const store = createEncryptedIdentityStore();
    await store.bootstrapNetwork(mainnet);
    await expect(store.readIndex(mainnet.caip2)).resolves.toMatchObject({ network: mainnet });
  });

  it('independently rejects ciphertext tampering, a wrong device-derived key, and corrupt registries', async () => {
    const store = createEncryptedIdentityStore();
    await store.bootstrapNetwork(NETWORK);
    await store.createIdentity(NETWORK, ID, indexRecord(), identityObject(), KEY, null);
    const directory = path.join(process.env.XDG_DATA_HOME!, 'ccd-agent-kit', 'id-manager', REFERENCE);
    const identityPath = path.join(directory, `${ID}.json`);
    const pristine = await readFile(identityPath, 'utf8');
    const envelope = JSON.parse(pristine);
    envelope.tag = `${envelope.tag[0] === '0' ? '1' : '0'}${envelope.tag.slice(1)}`;
    await writeFile(identityPath, `${JSON.stringify(envelope)}\n`, { mode: 0o600 });
    await expect(store.loadIdentity(NETWORK.caip2, ID, KEY)).rejects.toMatchObject({ code: 'STORAGE_FAILED' });

    await writeFile(identityPath, pristine, { mode: 0o600 });
    await expect(store.loadIdentity(NETWORK.caip2, ID, Buffer.alloc(32, 9))).rejects.toMatchObject({ code: 'STORAGE_FAILED' });

    await writeFile(path.join(directory, 'index.json'), '{"version":1,"network":', { mode: 0o600 });
    await expect(store.readIndex(NETWORK.caip2)).rejects.toMatchObject({ code: 'STORAGE_FAILED' });
    await expect(store.list(NETWORK.caip2)).rejects.toMatchObject({ code: 'STORAGE_FAILED' });
  });

  it('serializes mutations with an exclusive durable lock and removes it in finally', async () => {
    const store = createEncryptedIdentityStore();
    await store.bootstrapNetwork(NETWORK);
    let release!: () => void;
    let entered!: () => void;
    const acquired = new Promise<void>((resolve) => { entered = resolve; });
    const held = store.withMutation(NETWORK.caip2, async () => {
      entered();
      return new Promise<void>((resolve) => { release = resolve; });
    });
    await acquired;
    await expect(store.withMutation(NETWORK.caip2, async () => undefined)).rejects.toMatchObject({ code: 'STORAGE_FAILED' });
    const directory = path.join(process.env.XDG_DATA_HOME!, 'ccd-agent-kit', 'id-manager', REFERENCE);
    expect(await readdir(directory)).toContain('.mutation.lock');
    release();
    await held;
    expect(await readdir(directory)).not.toContain('.mutation.lock');
    await expect(store.withMutation(NETWORK.caip2, async () => undefined)).resolves.toBeUndefined();
  });

  it('bootstraps idempotently without resetting existing identity or credential registries', async () => {
    const store = createEncryptedIdentityStore();
    await store.bootstrapNetwork(NETWORK);
    await store.createIdentity(NETWORK, ID, indexRecord(), identityObject(), KEY, null);
    const credentials = {
      version: 1 as const,
      credentials: { ['aa'.repeat(48)]: { identityId: ID, credentialNumber: 0, status: 'confirmed' as const } },
    };
    await store.saveCredentials(NETWORK.caip2, credentials);
    await store.bootstrapNetwork(NETWORK);
    expect(await store.readIndex(NETWORK.caip2)).toMatchObject({ identities: { [ID]: indexRecord() } });
    expect(await store.loadCredentials(NETWORK.caip2)).toEqual(credentials);
  });

  it.each([
    ['unconfirmed', { status: 'unconfirmed' }],
    ['minimal created', { status: 'created', url: 'https://verification.example/continue' }],
    ['created with status URL', {
      status: 'created', url: 'https://verification.example/continue',
      statusUrl: 'https://issuer.example.test/agent-id/ctx/identity-object',
    }],
    ['created', {
      status: 'created', ctxId: 'ctx/opaque', url: 'https://issuer.example.test/verify', network: 'Testnet',
      expiresAt: '2026-10-17T12:00:00.000Z',
    }],
  ] as const)('round-trips durable POST issuance state: %s', async (_name, postIssuance) => {
    const store = createEncryptedIdentityStore();
    await store.bootstrapNetwork(NETWORK);
    const record = awaitingRecord();
    record.id = ID;
    record.selection = { ...record.selection, network: NETWORK.caip2 };
    record.postIssuance = structuredClone(postIssuance);

    await store.create(record);

    await expect(store.load(NETWORK.caip2, ID)).resolves.toMatchObject({ postIssuance });
    await expect(store.readIndex(NETWORK.caip2)).resolves.toMatchObject({
      identities: { [ID]: { workflow: { postIssuance } } },
    });
  });

  it.each([
    ['unknown status', { status: 'retrying' }],
    ['empty context ID', { status: 'created', ctxId: '', url: 'https://issuer.example.test/verify', network: 'Testnet', expiresAt: '2026-10-17T12:00:00Z' }],
    ['dot context ID', { status: 'created', ctxId: '.', url: 'https://issuer.example.test/verify', network: 'Testnet', expiresAt: '2026-10-17T12:00:00Z' }],
    ['unsafe context URL', { status: 'created', ctxId: 'ctx', url: 'file:///private/identity', network: 'Testnet', expiresAt: '2026-10-17T12:00:00Z' }],
    ['unsafe status URL', { status: 'created', url: 'https://issuer.example.test/verify', statusUrl: 'file:///private/identity' }],
    ['unknown field', { status: 'unconfirmed', retry: true }],
  ])('fails closed on malformed persisted POST issuance state: %s', async (_name, postIssuance) => {
    const store = createEncryptedIdentityStore();
    await store.bootstrapNetwork(NETWORK);
    const directory = path.join(process.env.XDG_DATA_HOME!, 'ccd-agent-kit', 'id-manager', REFERENCE);
    const filename = path.join(directory, 'index.json');
    const index = JSON.parse(await readFile(filename, 'utf8')) as {
      identities: Record<string, Omit<ReturnType<typeof indexRecord>, 'workflow'> & { workflow: Record<string, unknown> }>;
    };
    index.identities[ID] = {
      ...indexRecord(),
      workflow: { ...indexRecord().workflow, status: 'awaiting_verification', request: awaitingRecord().request, postIssuance },
    };
    await writeFile(filename, JSON.stringify(index), { mode: 0o600 });

    await expect(store.readIndex(NETWORK.caip2)).rejects.toMatchObject({ code: 'STORAGE_FAILED' });
  });

  it('round-trips attempt-bound failure provenance and a safe GET authorization URL', async () => {
    const store = createEncryptedIdentityStore();
    await store.bootstrapNetwork(NETWORK);
    const attempt = '018f47a2-43d2-7ad9-8b5e-89d810f95a22';
    const record = awaitingRecord();
    record.id = ID;
    record.selection = { ...record.selection, network: NETWORK.caip2 };
    Object.assign(record, {
      status: 'error', requestAttemptId: attempt,
      authorizationUrl: 'http://localhost:7011/verify',
      confirmedFailure: { kind: 'authenticated_key_failure', requestAttemptId: attempt },
    });
    await store.create(record);
    await expect(store.load(NETWORK.caip2, ID)).resolves.toMatchObject({
      status: 'error', requestAttemptId: attempt,
      authorizationUrl: 'http://localhost:7011/verify',
      confirmedFailure: { kind: 'authenticated_key_failure', requestAttemptId: attempt },
    });
  });

  it.each([
    ['request', { request: awaitingRecord().request }],
    ['requestAttemptId', { requestAttemptId: '018f47a2-43d2-7ad9-8b5e-89d810f95a22' }],
    ['postIssuance', { postIssuance: { status: 'unconfirmed' } }],
    ['authorizationUrl', { authorizationUrl: 'https://issuer.example.test/verify' }],
    ['retrievalUrl', { retrievalUrl: 'https://issuer.example.test/result' }],
    ['confirmedFailure', {
      requestAttemptId: '018f47a2-43d2-7ad9-8b5e-89d810f95a22',
      confirmedFailure: {
        kind: 'authenticated_key_failure', requestAttemptId: '018f47a2-43d2-7ad9-8b5e-89d810f95a22',
      },
    }],
  ] as const)('rejects ready registry metadata containing lifecycle field %s', async (_field, transient) => {
    const store = await bootstrappedStore();
    const filename = path.join(process.env.XDG_DATA_HOME!, 'ccd-agent-kit', 'id-manager', REFERENCE, 'index.json');
    const index = JSON.parse(await readFile(filename, 'utf8'));
    index.identities[ID] = {
      ...indexRecord(), workflow: { ...indexRecord().workflow, ...transient },
    };
    await writeFile(filename, JSON.stringify(index), { mode: 0o600 });
    await expect(store.readIndex(NETWORK.caip2)).rejects.toMatchObject({ code: 'STORAGE_FAILED' });
  });

  it.each([
    ['failure on non-error status', { status: 'pending', requestAttemptId: '018f47a2-43d2-7ad9-8b5e-89d810f95a22',
      confirmedFailure: { kind: 'authenticated_key_failure', requestAttemptId: '018f47a2-43d2-7ad9-8b5e-89d810f95a22' } }],
    ['failure without attempt', { status: 'error', confirmedFailure: {
      kind: 'authenticated_key_failure', requestAttemptId: '018f47a2-43d2-7ad9-8b5e-89d810f95a22',
    } }],
    ['failure for another attempt', { status: 'error', requestAttemptId: '018f47a2-43d2-7ad9-8b5e-89d810f95a22',
      confirmedFailure: { kind: 'authenticated_key_failure', requestAttemptId: '018f47a2-43d2-7ad9-8b5e-89d810f95a23' } }],
    ['unknown failure kind', { status: 'error', requestAttemptId: '018f47a2-43d2-7ad9-8b5e-89d810f95a22',
      confirmedFailure: { kind: 'transport', requestAttemptId: '018f47a2-43d2-7ad9-8b5e-89d810f95a22' } }],
    ['unsafe authorization URL', { status: 'awaiting_verification', authorizationUrl: 'file:///private/identity' }],
    ['empty retrieval URL', { status: 'pending', retrievalUrl: '' }],
  ])('rejects invalid workflow provenance: %s', async (_name, patch) => {
    const store = createEncryptedIdentityStore();
    await store.bootstrapNetwork(NETWORK);
    const filename = path.join(process.env.XDG_DATA_HOME!, 'ccd-agent-kit', 'id-manager', REFERENCE, 'index.json');
    const index = JSON.parse(await readFile(filename, 'utf8'));
    index.identities[ID] = {
      ...indexRecord(), workflow: { ...indexRecord().workflow, ...patch },
    };
    await writeFile(filename, JSON.stringify(index), { mode: 0o600 });
    await expect(store.readIndex(NETWORK.caip2)).rejects.toMatchObject({ code: 'STORAGE_FAILED' });
  });

  it.each([
    ['lone index', 'index.json'],
    ['lone credential registry', 'credentials.json'],
    ['orphan ciphertext', `${ID}.json`],
  ])('fails closed when fresh bootstrap finds a %s and creates no missing registry', async (_name, filename) => {
    const directory = path.join(process.env.XDG_DATA_HOME!, 'ccd-agent-kit', 'id-manager', REFERENCE);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(path.join(directory, filename), '{}', { mode: 0o600 });

    await expect(createEncryptedIdentityStore().bootstrapNetwork(NETWORK))
      .rejects.toMatchObject({ code: 'STORAGE_FAILED' });
    expect(await readdir(directory)).toEqual([filename]);
  });

  it.each(['missing', 'corrupt'] as const)('fails closed for a %s credential registry without changing the index', async (kind) => {
    const store = createEncryptedIdentityStore();
    await store.bootstrapNetwork(NETWORK);
    await store.createIdentity(NETWORK, ID, indexRecord(), identityObject(), KEY, null);
    const directory = path.join(process.env.XDG_DATA_HOME!, 'ccd-agent-kit', 'id-manager', REFERENCE);
    const credentialsPath = path.join(directory, 'credentials.json');
    if (kind === 'missing') await rm(credentialsPath);
    else await writeFile(credentialsPath, '{"version":1,"credentials":', { mode: 0o600 });
    const indexBefore = await store.readIndex(NETWORK.caip2);

    await expect(store.loadCredentials(NETWORK.caip2)).rejects.toMatchObject({ code: 'STORAGE_FAILED' });
    await expect(store.bootstrapNetwork(NETWORK)).rejects.toMatchObject({ code: 'STORAGE_FAILED' });
    await expect(store.readIndex(NETWORK.caip2)).resolves.toEqual(indexBefore);
  });

  it('does not return success when index persistence fails and never overwrites an orphan ciphertext', async () => {
    const store = createEncryptedIdentityStore();
    await store.bootstrapNetwork(NETWORK);
    const directory = path.join(process.env.XDG_DATA_HOME!, 'ccd-agent-kit', 'id-manager', REFERENCE);
    const orphan = path.join(directory, `${ID}.json`);
    await writeFile(orphan, 'orphan-ciphertext', { flag: 'wx', mode: 0o600 });
    await expect(store.createIdentity(NETWORK, ID, indexRecord(), identityObject(), KEY, null)).rejects.toMatchObject({
      code: 'STORAGE_FAILED',
    });
    expect(await readFile(orphan, 'utf8')).toBe('orphan-ciphertext');
    expect(await store.readIndex(NETWORK.caip2)).toMatchObject({ identities: {} });
  });

  it.each(['matching', 'different'] as const)('validates an existing %s ciphertext before recreating its index entry', async (kind) => {
    const store = createEncryptedIdentityStore();
    await store.bootstrapNetwork(NETWORK);
    const identity = identityObject();
    await store.createIdentity(NETWORK, ID, indexRecord(), identity, KEY, null);
    const indexPath = path.join(process.env.XDG_DATA_HOME!, 'ccd-agent-kit', 'id-manager', REFERENCE, 'index.json');
    const index = JSON.parse(await readFile(indexPath, 'utf8'));
    index.identities = {};
    await writeFile(indexPath, `${JSON.stringify(index)}\n`, { mode: 0o600 });
    const candidate = structuredClone(identity);
    if (kind === 'different') candidate.value.signature = 'ff'.repeat(96);

    const operation = store.createIdentity(NETWORK, ID, indexRecord(), candidate, KEY, null);
    if (kind === 'matching') await expect(operation).resolves.toBeUndefined();
    else await expect(operation).rejects.toMatchObject({ code: 'STORAGE_FAILED' });
    const stored = (await store.readIndex(NETWORK.caip2)).identities[ID];
    expect(stored === undefined).toBe(kind === 'different');
  });

  it('recreates a missing encrypted file for the same deterministic identity without replacing credential history', async () => {
    const store = createEncryptedIdentityStore();
    await store.bootstrapNetwork(NETWORK);
    await store.createIdentity(NETWORK, ID, indexRecord(), identityObject(), KEY, null);
    const credentials = {
      version: 1 as const,
      credentials: {
        ['aa'.repeat(48)]: { identityId: ID, credentialNumber: 0, status: 'confirmed' as const },
        ['bb'.repeat(48)]: {
          identityId: ID, credentialNumber: 1, status: 'pending' as const,
          expectedAccountAddress: '4fQjQwz1', expirySeconds: 1_800_000_600,
        },
      },
    };
    await store.saveCredentials(NETWORK.caip2, credentials);
    const directory = path.join(process.env.XDG_DATA_HOME!, 'ccd-agent-kit', 'id-manager', REFERENCE);
    await rm(path.join(directory, `${ID}.json`));

    await store.restoreIdentity(NETWORK, ID, indexRecord(), identityObject(), KEY, indexRecord().workflow);
    await expect(store.loadIdentity(NETWORK.caip2, ID, KEY)).resolves.toEqual(identityObject());
    await expect(store.loadCredentials(NETWORK.caip2)).resolves.toEqual(credentials);
    expect((await store.readIndex(NETWORK.caip2)).identities).toHaveProperty(ID);
  });

  it('rejects malformed nested registry entries, ready-state downgrade, and mismatched identity replacement', async () => {
    const store = createEncryptedIdentityStore();
    await store.bootstrapNetwork(NETWORK);
    const record = awaitingRecord();
    record.selection = { ...selection(), network: NETWORK.caip2 };
    await store.create(record);
    await store.createIdentity(NETWORK, record.id, {
      ...(await store.readIndex(NETWORK.caip2)).identities[record.id]!,
      workflow: { status: 'ready', contextHash: record.contextHash, idCredPub: record.idCredPub },
    }, identityObject(record.request.value), KEY, await workflow(store, record.id));
    const readyWorkflow = await workflow(store, record.id);
    await expect(store.save({ ...record, status: 'pending' }, readyWorkflow)).rejects.toMatchObject({ code: 'STORAGE_FAILED' });
    await expect(store.createIdentity(NETWORK, record.id, indexRecord(), identityObject(), KEY, readyWorkflow))
      .rejects.toMatchObject({ code: 'STORAGE_FAILED' });

    const directory = path.join(process.env.XDG_DATA_HOME!, 'ccd-agent-kit', 'id-manager', REFERENCE);
    const indexPath = path.join(directory, 'index.json');
    const index = JSON.parse(await readFile(indexPath, 'utf8'));
    delete index.identities[record.id].workflow;
    await writeFile(indexPath, `${JSON.stringify(index)}\n`, { mode: 0o600 });
    await expect(store.readIndex(NETWORK.caip2)).rejects.toMatchObject({ code: 'STORAGE_FAILED' });
  });

  it.each([
    ['null index', null],
    ['wrong index version', { version: 2, network: NETWORK, identities: {} }],
    ['primitive identities', { version: 1, network: NETWORK, identities: 1 }],
    ['null identities', { version: 1, network: NETWORK, identities: null }],
    ['array identities', { version: 1, network: NETWORK, identities: [] }],
    ['missing network', { version: 1, identities: {} }],
    ['nonnumeric CAIP network', { version: 1, network: { ...NETWORK, caip2: 1 }, identities: {} }],
    ['nonnumeric genesis', { version: 1, network: { ...NETWORK, genesisHash: 1 }, identities: {} }],
    ['malformed genesis', { version: 1, network: { ...NETWORK, genesisHash: 'zz' }, identities: {} }],
    ['mismatched CAIP network', { version: 1, network: { ...NETWORK, caip2: `ccd:${'34'.repeat(16)}` }, identities: {} }],
    ['unknown SDK network', { version: 1, network: { ...NETWORK, sdkNetwork: 'Other' }, identities: {} }],
  ])('rejects %s registry structure', async (_case, malformed) => {
    const store = createEncryptedIdentityStore();
    await store.bootstrapNetwork(NETWORK);
    const indexPath = path.join(process.env.XDG_DATA_HOME!, 'ccd-agent-kit', 'id-manager', REFERENCE, 'index.json');
    await writeFile(indexPath, `${JSON.stringify(malformed)}\n`, { mode: 0o600 });
    await expect(store.readIndex(NETWORK.caip2)).rejects.toMatchObject({ code: 'STORAGE_FAILED' });
  });

  it.each([
    ['invalid identity key', 'invalid', indexRecord()],
    ['wrong ciphertext filename', ID, { ...indexRecord(), file: 'other.json' }],
    ['unknown recipe', ID, { ...indexRecord(), recipeVersion: 2 }],
    ['malformed fingerprint', ID, { ...indexRecord(), selection: { ...indexRecord().selection, rootPublicKeyFingerprint: 'zz' } }],
    ['mismatched fingerprint', ID, { ...indexRecord(), selection: { ...indexRecord().selection, rootPublicKeyFingerprint: '00'.repeat(32) } }],
    ['invalid source association', ID, { ...indexRecord(), sourceId: 'INVALID' }],
    ['source association for another root', ID, { ...indexRecord(), sourceId: 'ir:aaaaaaaaaaaaaaa' }],
  ])('rejects an index entry with %s', async (_case, id, malformed) => {
    const store = createEncryptedIdentityStore();
    await store.bootstrapNetwork(NETWORK);
    const indexPath = path.join(process.env.XDG_DATA_HOME!, 'ccd-agent-kit', 'id-manager', REFERENCE, 'index.json');
    await writeFile(indexPath, `${JSON.stringify({ version: 1, network: NETWORK, identities: { [id]: malformed } })}\n`, { mode: 0o600 });
    await expect(store.readIndex(NETWORK.caip2)).rejects.toMatchObject({ code: 'STORAGE_FAILED' });
  });

  it.each([
    ['null registry', null],
    ['wrong version', { version: 2, credentials: {} }],
    ['primitive map', { version: 1, credentials: 1 }],
    ['null map', { version: 1, credentials: null }],
    ['array map', { version: 1, credentials: [] }],
    ['malformed credential id', { version: 1, credentials: { invalid: { identityId: ID, credentialNumber: 0, status: 'confirmed' } } }],
    ['malformed identity id', { version: 1, credentials: { ['aa'.repeat(48)]: { identityId: 'invalid', credentialNumber: 0, status: 'confirmed' } } }],
    ['fractional number', { version: 1, credentials: { ['aa'.repeat(48)]: { identityId: ID, credentialNumber: 0.5, status: 'confirmed' } } }],
    ['negative number', { version: 1, credentials: { ['aa'.repeat(48)]: { identityId: ID, credentialNumber: -1, status: 'confirmed' } } }],
    ['oversized number', { version: 1, credentials: { ['aa'.repeat(48)]: { identityId: ID, credentialNumber: 256, status: 'confirmed' } } }],
    ['pending address absent', { version: 1, credentials: { ['aa'.repeat(48)]: { identityId: ID, credentialNumber: 0, status: 'pending', expirySeconds: 1 } } }],
    ['pending expiry unsafe', { version: 1, credentials: { ['aa'.repeat(48)]: { identityId: ID, credentialNumber: 0, status: 'pending', expectedAccountAddress: 'account', expirySeconds: 1.5 } } }],
    ['pending expiry negative', { version: 1, credentials: { ['aa'.repeat(48)]: { identityId: ID, credentialNumber: 0, status: 'pending', expectedAccountAddress: 'account', expirySeconds: -1 } } }],
    ['confirmed address retained', { version: 1, credentials: { ['aa'.repeat(48)]: { identityId: ID, credentialNumber: 0, status: 'confirmed', expectedAccountAddress: 'account' } } }],
    ['confirmed expiry retained', { version: 1, credentials: { ['aa'.repeat(48)]: { identityId: ID, credentialNumber: 0, status: 'confirmed', expirySeconds: 1 } } }],
  ])('rejects credential registry with %s', async (_case, malformed) => {
    const store = createEncryptedIdentityStore();
    await store.bootstrapNetwork(NETWORK);
    await expect(store.saveCredentials(NETWORK.caip2, malformed as never)).rejects.toMatchObject({ code: 'STORAGE_FAILED' });
  });

  it('does not create ciphertext when restoration has no existing identity metadata', async () => {
    const store = createEncryptedIdentityStore();
    await store.bootstrapNetwork(NETWORK);
    const before = await store.readIndex(NETWORK.caip2);

    await expect(store.restoreIdentity(NETWORK, ID, indexRecord(), identityObject(), KEY, indexRecord().workflow))
      .rejects.toMatchObject({ code: 'STORAGE_FAILED' });

    expect(await store.readIndex(NETWORK.caip2)).toEqual(before);
    await expect(stat(path.join(process.env.XDG_DATA_HOME!, 'ccd-agent-kit', 'id-manager', REFERENCE, `${ID}.json`)))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects invalid identity paths, missing ciphertext, and mismatched restore metadata', async () => {
    const store = createEncryptedIdentityStore();
    await store.bootstrapNetwork(NETWORK);
    await expect(store.createIdentity(NETWORK, 'invalid', indexRecord(), identityObject(), KEY, null))
      .rejects.toMatchObject({ code: 'STORAGE_FAILED' });
    await expect(store.loadIdentity(NETWORK.caip2, ID, KEY)).rejects.toMatchObject({ code: 'STORAGE_FAILED' });
    const record = indexRecord();
    await store.createIdentity(NETWORK, ID, record, identityObject(), KEY, null);
    await rm(path.join(process.env.XDG_DATA_HOME!, 'ccd-agent-kit', 'id-manager', REFERENCE, `${ID}.json`));
    await expect(store.loadIdentity(NETWORK.caip2, ID, KEY)).rejects.toMatchObject({ code: 'IDENTITY_FILE_MISSING' });
    await expect(store.restoreIdentity({ ...NETWORK, genesisHash: '34'.repeat(32) }, ID, record, identityObject(), KEY, record.workflow))
      .rejects.toMatchObject({ code: 'STORAGE_FAILED' });
    await expect(store.restoreIdentity(NETWORK, ID, { ...record, workflow: { ...record.workflow, contextHash: '55'.repeat(32) } }, identityObject(), KEY, record.workflow))
      .rejects.toMatchObject({ code: 'STORAGE_FAILED' });
  });

  it.each([
    ['source association', (record: ReturnType<typeof indexRecord>) => ({ ...record, sourceId: SOURCE_ID })],
    ['public credential', (record: ReturnType<typeof indexRecord>) => ({
      ...record, workflow: { ...record.workflow, idCredPub: '55'.repeat(48) },
    })],
    ['selection', (record: ReturnType<typeof indexRecord>) => ({
      ...record, selection: { ...record.selection, identityIndex: record.selection.identityIndex + 1 },
    })],
  ])('rejects restore metadata with a mismatched durable %s pin', async (_field, change) => {
    const store = await bootstrappedStore();
    const record = indexRecord();
    await store.createIdentity(NETWORK, ID, record, identityObject(), KEY, null);
    const identityPath = path.join(process.env.XDG_DATA_HOME!, 'ccd-agent-kit', 'id-manager', REFERENCE, `${ID}.json`);
    await rm(identityPath);

    await expect(store.restoreIdentity(NETWORK, ID, change(record), identityObject(), KEY, record.workflow))
      .rejects.toMatchObject({ code: 'STORAGE_FAILED' });

    await expect(readFile(identityPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(store.readIndex(NETWORK.caip2)).resolves.toMatchObject({ identities: { [ID]: record } });
  });

  it('rejects stale restore snapshots and leaves the missing ciphertext absent', async () => {
    const store = await bootstrappedStore();
    const record = indexRecord();
    await store.createIdentity(NETWORK, ID, record, identityObject(), KEY, null);
    const identityPath = path.join(process.env.XDG_DATA_HOME!, 'ccd-agent-kit', 'id-manager', REFERENCE, `${ID}.json`);
    await rm(identityPath);

    await expect(store.restoreIdentity(
      NETWORK, ID, record, identityObject(), KEY, { ...record.workflow, contextHash: '55'.repeat(32) },
    )).rejects.toMatchObject({ code: 'INDEX_UNAVAILABLE' });

    await expect(readFile(identityPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(store.readIndex(NETWORK.caip2)).resolves.toMatchObject({ identities: { [ID]: record } });
  });

  it('never replaces ciphertext for an already-ready identity', async () => {
    const store = await bootstrappedStore();
    const record = indexRecord();
    await store.createIdentity(NETWORK, ID, record, identityObject(), KEY, null);
    const identityPath = path.join(process.env.XDG_DATA_HOME!, 'ccd-agent-kit', 'id-manager', REFERENCE, `${ID}.json`);
    const before = await readFile(identityPath);
    const replacement = identityObject();
    replacement.value.signature = 'ff'.repeat(96);

    await expect(store.restoreIdentity(NETWORK, ID, record, replacement, KEY, record.workflow))
      .rejects.toMatchObject({ code: 'STORAGE_FAILED' });

    expect(await readFile(identityPath)).toEqual(before);
    await expect(store.loadIdentity(NETWORK.caip2, ID, KEY)).resolves.toEqual(identityObject());
  });

  it.each(['context', 'selection'] as const)('rejects replacement with mismatched %s binding', async (field) => {
    const store = createEncryptedIdentityStore();
    await store.bootstrapNetwork(NETWORK);
    await store.createIdentity(NETWORK, ID, indexRecord(), identityObject(), KEY, null);
    const replacement = indexRecord();
    if (field === 'context') replacement.workflow.contextHash = '55'.repeat(32);
    else replacement.selection.identityIndex += 1;
    await expect(store.createIdentity(NETWORK, ID, replacement, identityObject(), KEY, await workflow(store, ID)))
      .rejects.toMatchObject({ code: 'STORAGE_FAILED' });
  });

  it('rejects invalid credential state and symlinked identity ciphertext', async () => {
    const store = createEncryptedIdentityStore();
    await store.bootstrapNetwork(NETWORK);
    await store.createIdentity(NETWORK, ID, indexRecord(), identityObject(), KEY, null);
    const directory = path.join(process.env.XDG_DATA_HOME!, 'ccd-agent-kit', 'id-manager', REFERENCE);
    const malformed = {
      version: 1, credentials: { ['aa'.repeat(48)]: { identityId: ID, credentialNumber: 0, status: 'other' } },
    };
    await expect(store.saveCredentials(NETWORK.caip2, malformed as never)).rejects.toMatchObject({ code: 'STORAGE_FAILED' });
    await writeFile(path.join(directory, 'credentials.json'), JSON.stringify(malformed), { mode: 0o600 });
    await expect(store.loadCredentials(NETWORK.caip2)).rejects.toMatchObject({ code: 'STORAGE_FAILED' });

    const identityPath = path.join(directory, `${ID}.json`);
    const outside = path.join(xdg.scratch(), 'outside.json');
    await writeFile(outside, '{}');
    await rm(identityPath);
    await symlink(outside, identityPath);
    await expect(store.loadIdentity(NETWORK.caip2, ID, KEY)).rejects.toMatchObject({ code: 'STORAGE_FAILED' });
  });
});
