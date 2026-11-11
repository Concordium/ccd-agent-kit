import { deriveIdentitySourceId } from '@ccd-agent-kit/config-utils';
import { MAINNET_GENESIS_HASH } from '@ccd-agent-kit/sdk-utils';
import { access,chmod,lstat,mkdir,readFile,readdir,rename,rm,stat,symlink,writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach,describe,expect,it,vi } from 'vitest';
import { createEncryptedIdentityStore } from '../../src/core/workflowInfrastructure.js';
import { awaitingRecord,readyRecord,selection } from '../workflowFixtures.js';
import { useTestXdg } from '../xdgTestHelpers.js';

const GENESIS = '12'.repeat(32);
const NETWORK = { caip2: `ccd:${GENESIS.slice(0, 32)}`, genesisHash: GENESIS, sdkNetwork: 'Testnet' as const };
const OTHER_GENESIS = '34'.repeat(32);
const OTHER_NETWORK = {
  caip2: `ccd:${OTHER_GENESIS.slice(0, 32)}`, genesisHash: OTHER_GENESIS, sdkNetwork: 'Testnet' as const,
};
const SOURCE_ID = deriveIdentitySourceId(selection().rootPublicKey, 1);
const OTHER_SOURCE_ID = SOURCE_ID === 'ir:aaaaaaaaaaaaaaa' ? 'ir:bbbbbbbbbbbbbbb' : 'ir:aaaaaaaaaaaaaaa';
const scope = { genesisHash: GENESIS, sourceId: SOURCE_ID, sdkNetwork: 'Testnet' as const, identityProviderIndex: 7 };

const xdg = useTestXdg('reservations-', ['XDG_DATA_HOME']);
const root = () => path.join(process.env.XDG_DATA_HOME!, 'ccd-agent-kit', 'id-manager');
const reservationsFile = () => path.join(root(), 'identity-reservations.json');
const lockFile = () => path.join(root(), '.identity-reservations.mutation.lock');

async function bootstrappedStore() {
  const store = createEncryptedIdentityStore();
  await store.bootstrapNetwork(NETWORK);
  return store;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('global identity-index reservations', () => {
  it('lists an empty scope without creating a sidecar', async () => {
    await expect(createEncryptedIdentityStore().listIdentityReservations(scope)).resolves.toEqual([]);
    await expect(access(reservationsFile())).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([
    ['missing scope', undefined],
    ['missing full genesis', { sourceId: SOURCE_ID, sdkNetwork: 'Testnet', identityProviderIndex: 7 }],
    ['uppercase full genesis', { ...scope, genesisHash: 'ab'.repeat(32).toUpperCase() }],
    ['short full genesis', { ...scope, genesisHash: '12' }],
    ['invalid source', { ...scope, sourceId: 'INVALID' }],
    ['unknown SDK namespace', { ...scope, sdkNetwork: 'Devnet' }],
    ['SDK namespace inconsistent with genesis', { ...scope, sdkNetwork: 'Mainnet' }],
    ['negative provider', { ...scope, identityProviderIndex: -1 }],
    ['oversized provider', { ...scope, identityProviderIndex: 0x80000000 }],
  ])('rejects %s without touching reservation state', async (_label, candidate) => {
    const store = createEncryptedIdentityStore();
    await expect(Reflect.apply(store.listIdentityReservations, store, [candidate]))
      .rejects.toMatchObject({ code: 'STORAGE_FAILED' });
    await expect(access(reservationsFile())).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('persists sorted unique reservations with protected modes and no sensitive metadata', async () => {
    const store = createEncryptedIdentityStore();
    await store.reserveIdentityIndex({ ...scope, identityIndex: 3, mode: 'used' });
    await store.reserveIdentityIndex({ ...scope, identityIndex: 1, mode: 'used' });
    await store.reserveIdentityIndex({ ...scope, identityIndex: 3, mode: 'used' });

    await expect(store.listIdentityReservations(scope)).resolves.toEqual([1, 3]);
    const document = JSON.parse(await readFile(reservationsFile(), 'utf8'));
    expect(document).toEqual({ version: 2, reservations: [
      { ...scope, identityIndex: 1, state: 'used', reservedAt: expect.any(Number) },
      { ...scope, identityIndex: 3, state: 'used', reservedAt: expect.any(Number) },
    ] });
    expect(JSON.stringify(document)).not.toMatch(/networkName|endpoint|device|rootPublic|identityId|path|status/i);
    expect((await stat(root())).mode & 0o777).toBe(0o700);
    expect((await stat(reservationsFile())).mode & 0o777).toBe(0o600);
    await expect(access(lockFile())).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('enforces exact high-water compare-and-reserve semantics without retrying', async () => {
    const store = createEncryptedIdentityStore();
    await store.reserveIdentityIndex({ ...scope, identityIndex: 2, mode: 'used' });
    await store.reserveIdentityIndex({ ...scope, identityIndex: 3, mode: 'next', expectedHighWater: 2 });
    const before = await readFile(reservationsFile(), 'utf8');

    await expect(store.reserveIdentityIndex({
      ...scope, identityIndex: 3, mode: 'next', expectedHighWater: 2,
    })).rejects.toMatchObject({ code: 'INDEX_UNAVAILABLE' });
    await expect(store.reserveIdentityIndex({
      ...scope, identityIndex: 5, mode: 'next', expectedHighWater: 3,
    })).rejects.toMatchObject({ code: 'INDEX_UNAVAILABLE' });
    expect(await readFile(reservationsFile(), 'utf8')).toBe(before);
  });

  it('allocates index zero only when an empty scope still has high-water minus one', async () => {
    const store = createEncryptedIdentityStore();
    await expect(store.reserveIdentityIndex({
      ...scope, identityIndex: 0, mode: 'next', expectedHighWater: -1,
    })).resolves.toBeUndefined();
    await expect(store.listIdentityReservations(scope)).resolves.toEqual([0]);
  });

  it.each([
    ['negative index', { ...scope, identityIndex: -1, mode: 'used' }],
    ['oversized index', { ...scope, identityIndex: 0x80000000, mode: 'used' }],
  ] as const)('rejects %s before creating reservation state', async (_label, input) => {
    await expect(createEncryptedIdentityStore().reserveIdentityIndex(input))
      .rejects.toMatchObject({ code: 'STORAGE_FAILED' });
    await expect(access(reservationsFile())).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects an occupied explicit index while used mode remains idempotent', async () => {
    const store = createEncryptedIdentityStore();
    await store.reserveIdentityIndex({ ...scope, identityIndex: 8, mode: 'explicit' });
    await expect(store.reserveIdentityIndex({ ...scope, identityIndex: 8, mode: 'explicit' }))
      .rejects.toMatchObject({ code: 'INDEX_UNAVAILABLE' });
    await expect(store.reserveIdentityIndex({ ...scope, identityIndex: 8, mode: 'used' })).resolves.toBeUndefined();
    await expect(store.listIdentityReservations(scope)).resolves.toEqual([8]);
  });

  it('does not count an associated record from another full-genesis network', async () => {
    const store = createEncryptedIdentityStore();
    await store.bootstrapNetwork(OTHER_NETWORK);
    const record = awaitingRecord();
    record.selection = { ...record.selection, network: OTHER_NETWORK.caip2, sdkNetwork: 'Testnet', identityIndex: 11 };
    await store.create({ ...record, sourceId: SOURCE_ID });

    await expect(store.listIdentityReservations(scope)).resolves.toEqual([]);
    await expect(store.reserveIdentityIndex({ ...scope, identityIndex: 11, mode: 'explicit' }))
      .resolves.toBeUndefined();
    await expect(store.listIdentityReservations({ ...scope, genesisHash: OTHER_GENESIS })).resolves.toEqual([11]);
    await expect(store.listIdentityReservations({ ...scope, genesisHash: OTHER_GENESIS, identityProviderIndex: 8 }))
      .resolves.toEqual([]);
  });

  it('derives occupancy from complete immutable root pins in historical unassociated records', async () => {
    const store = await bootstrappedStore();
    const historical = awaitingRecord();
    historical.selection = { ...historical.selection, network: NETWORK.caip2, identityIndex: 9 };
    delete (historical as { sourceId?: string }).sourceId;
    await store.create(historical);

    await expect(store.listIdentityReservations(scope)).resolves.toContain(9);
    await expect(store.reserveIdentityIndex({ ...scope, identityIndex: 9, mode: 'explicit' }))
      .rejects.toMatchObject({ code: 'INDEX_UNAVAILABLE' });
    await store.reserveIdentityIndex({ ...scope, identityIndex: 9, mode: 'used' });
    expect(JSON.parse(await readFile(reservationsFile(), 'utf8')).reservations)
      .toEqual([{ ...scope, identityIndex: 9, state: 'used', reservedAt: expect.any(Number) }]);
    expect(await store.load(NETWORK.caip2, historical.id)).not.toHaveProperty('sourceId');
  });

  it('counts every protected workflow status as occupied even when no ciphertext exists', async () => {
    const store = await bootstrappedStore();
    const statuses = ['awaiting_verification', 'pending', 'ready', 'error'] as const;
    for (const [offset, status] of statuses.entries()) {
      const record = status === 'ready' ? readyRecord() : { ...awaitingRecord(), status };
      record.id = String(offset + 1).padStart(64, '0');
      record.selection = { ...record.selection, network: NETWORK.caip2, identityIndex: offset + 5 };
      delete (record as { sourceId?: string }).sourceId;
      await store.create(record);
    }
    await expect(store.listIdentityReservations(scope)).resolves.toEqual([5, 6, 7, 8]);
  });

  it('does not create false occupancy across source or provider scopes', async () => {
    const store = createEncryptedIdentityStore();
    await store.reserveIdentityIndex({ ...scope, identityIndex: 4, mode: 'used' });
    await expect(store.listIdentityReservations({ ...scope, sourceId: OTHER_SOURCE_ID })).resolves.toEqual([]);
    await expect(store.listIdentityReservations({ ...scope, identityProviderIndex: 8 })).resolves.toEqual([]);
    await expect(store.listIdentityReservations({ ...scope, genesisHash: OTHER_GENESIS })).resolves.toEqual([]);
  });

  it('ignores valid protected network indexes from the other SDK namespace', async () => {
    const store = createEncryptedIdentityStore();
    const mainnet = {
      caip2: `ccd:${MAINNET_GENESIS_HASH.slice(0, 32)}`,
      genesisHash: MAINNET_GENESIS_HASH,
      sdkNetwork: 'Mainnet' as const,
    };
    await store.bootstrapNetwork(mainnet);
    await expect(store.listIdentityReservations(scope)).resolves.toEqual([]);
  });

  it('ignores an unrelated network-like entry that is not a directory', async () => {
    await mkdir(root(), { recursive: true, mode: 0o700 });
    const entry = path.join(root(), '56'.repeat(16));
    await writeFile(entry, 'not a network directory', { mode: 0o600 });
    await expect(createEncryptedIdentityStore().listIdentityReservations(scope)).resolves.toEqual([]);
    expect(await readFile(entry, 'utf8')).toBe('not a network directory');
  });

  it('fails closed when the current reference directory contains another network index', async () => {
    const store = createEncryptedIdentityStore();
    await store.bootstrapNetwork(OTHER_NETWORK);
    const original = path.join(root(), OTHER_GENESIS.slice(0, 32));
    const mismatched = path.join(root(), GENESIS.slice(0, 32));
    await rename(original, mismatched);
    await expect(store.listIdentityReservations(scope)).rejects.toMatchObject({ code: 'STORAGE_FAILED' });
    await expect(access(reservationsFile())).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fails closed on a current-reference index pinned to a conflicting full genesis', async () => {
    const conflictingGenesis = `${GENESIS.slice(0, 32)}${'34'.repeat(16)}`;
    const store = createEncryptedIdentityStore();
    await store.bootstrapNetwork({
      caip2: NETWORK.caip2, genesisHash: conflictingGenesis, sdkNetwork: 'Testnet',
    });
    await expect(store.listIdentityReservations(scope)).rejects.toMatchObject({ code: 'STORAGE_FAILED' });
    await expect(store.reserveIdentityIndex({ ...scope, identityIndex: 1, mode: 'used' }))
      .rejects.toMatchObject({ code: 'STORAGE_FAILED' });
  });

  it('keeps full-genesis and other reservation dimensions isolated during mutation', async () => {
    const store = createEncryptedIdentityStore();
    await store.reserveIdentityIndex({ ...scope, identityIndex: 1, mode: 'used' });
    await store.reserveIdentityIndex({ ...scope, sourceId: OTHER_SOURCE_ID, identityIndex: 2, mode: 'used' });
    await store.reserveIdentityIndex({ ...scope, genesisHash: OTHER_GENESIS, identityIndex: 1, mode: 'used' });
    await expect(store.listIdentityReservations(scope)).resolves.toEqual([1]);
    await expect(store.listIdentityReservations({ ...scope, sourceId: OTHER_SOURCE_ID })).resolves.toEqual([2]);
    await expect(store.listIdentityReservations({ ...scope, genesisHash: OTHER_GENESIS })).resolves.toEqual([1]);
    const rows = JSON.parse(await readFile(reservationsFile(), 'utf8')).reservations as Array<{ genesisHash: string }>;
    expect(rows.map(({ genesisHash }) => genesisHash)).toEqual([GENESIS, GENESIS, OTHER_GENESIS]);
  });

  it('allows the same source, SDK namespace, provider, and index on two testnet geneses', async () => {
    const store = createEncryptedIdentityStore();
    await store.reserveIdentityIndex({ ...scope, identityIndex: 0, mode: 'used' });
    const otherScope = { ...scope, genesisHash: OTHER_GENESIS };
    await expect(store.listIdentityReservations(otherScope)).resolves.toEqual([]);
    await expect(store.reserveIdentityIndex({ ...otherScope, identityIndex: 0, mode: 'explicit' }))
      .resolves.toBeUndefined();
    await expect(store.listIdentityReservations(scope)).resolves.toEqual([0]);
    await expect(store.listIdentityReservations(otherScope)).resolves.toEqual([0]);
  });

  it.each([
    ['malformed JSON', '{'],
    ['unknown root field', JSON.stringify({ version: 1, reservations: [], extra: true })],
    ['unknown entry field', JSON.stringify({ version: 1, reservations: [{ ...scope, identityIndex: 1, extra: true }] })],
    ['duplicate entries', JSON.stringify({ version: 1, reservations: [
      { ...scope, identityIndex: 1 }, { ...scope, identityIndex: 1 },
    ] })],
    ['unsorted entries', JSON.stringify({ version: 1, reservations: [
      { ...scope, identityIndex: 2 }, { ...scope, identityIndex: 1 },
    ] })],
    ['out-of-bounds index', JSON.stringify({ version: 1, reservations: [{ ...scope, identityIndex: 0x80000000 }] })],
    ['invalid source ID', JSON.stringify({ version: 1, reservations: [{ ...scope, sourceId: 'INVALID', identityIndex: 1 }] })],
    ['unknown SDK namespace', JSON.stringify({ version: 1, reservations: [{ ...scope, sdkNetwork: 'Devnet', identityIndex: 1 }] })],
    ['malformed current row', JSON.stringify({ version: 2, reservations: [{
      ...scope, identityIndex: 1, state: 'unknown', reservedAt: 1_800_000_000_000,
    }] })],
    ['missing genesis from an unreleased row', JSON.stringify({ version: 1, reservations: [{
      sourceId: SOURCE_ID, sdkNetwork: 'Testnet', identityProviderIndex: 7, identityIndex: 1,
    }] })],
    ['malformed full genesis', JSON.stringify({ version: 1, reservations: [{
      ...scope, genesisHash: '12', identityIndex: 1,
    }] })],
  ])('fails closed on %s without replacing the sidecar', async (_label, contents) => {
    await mkdir(root(), { recursive: true, mode: 0o700 });
    await writeFile(reservationsFile(), contents, { mode: 0o600 });
    const store = createEncryptedIdentityStore();
    await expect(store.listIdentityReservations(scope)).rejects.toMatchObject({ code: 'STORAGE_FAILED' });
    await expect(store.reserveIdentityIndex({ ...scope, identityIndex: 2, mode: 'used' }))
      .rejects.toMatchObject({ code: 'STORAGE_FAILED' });
    expect(await readFile(reservationsFile(), 'utf8')).toBe(contents);
  });

  it.each(['root', 'data directory'])('rejects a symlinked reservation %s before reading outside state', async (kind) => {
    const outside = path.join(xdg.scratch(), 'outside');
    await mkdir(outside, { mode: 0o755 });
    const link = kind === 'root' ? root() : path.dirname(root());
    const targetDirectory = kind === 'root' ? outside : path.join(outside, 'id-manager');
    await mkdir(targetDirectory, { recursive: true, mode: 0o755 });
    await mkdir(path.dirname(link), { recursive: true });
    const contents = JSON.stringify({ version: 1, reservations: [{ ...scope, identityIndex: 9 }] });
    const target = path.join(targetDirectory, 'identity-reservations.json');
    await writeFile(target, contents, { mode: 0o600 });
    await symlink(outside, link);

    await expect(createEncryptedIdentityStore().listIdentityReservations(scope))
      .rejects.toMatchObject({ code: 'STORAGE_FAILED' });
    expect(await readFile(target, 'utf8')).toBe(contents);
    expect((await stat(outside)).mode & 0o777).toBe(0o755);
  });

  it('fails closed on a symlinked sidecar without touching its target', async () => {
    await mkdir(root(), { recursive: true, mode: 0o700 });
    const outside = path.join(xdg.scratch(), 'outside.json');
    const contents = JSON.stringify({ version: 1, reservations: [] });
    await writeFile(outside, contents);
    await symlink(outside, reservationsFile());
    const store = createEncryptedIdentityStore();
    await expect(store.listIdentityReservations(scope)).rejects.toMatchObject({ code: 'STORAGE_FAILED' });
    await expect(store.reserveIdentityIndex({ ...scope, identityIndex: 1, mode: 'used' }))
      .rejects.toMatchObject({ code: 'STORAGE_FAILED' });
    expect(await readFile(outside, 'utf8')).toBe(contents);
    expect((await lstat(reservationsFile())).isSymbolicLink()).toBe(true);
  });

  it('never steals the global reservation lock or changes state', async () => {
    const store = createEncryptedIdentityStore();
    await store.reserveIdentityIndex({ ...scope, identityIndex: 1, mode: 'used' });
    await writeFile(lockFile(), 'another owner', { flag: 'wx', mode: 0o600 });
    const before = await readFile(reservationsFile(), 'utf8');
    await expect(store.reserveIdentityIndex({ ...scope, identityIndex: 2, mode: 'used' }))
      .rejects.toMatchObject({ code: 'STORAGE_FAILED' });
    expect(await readFile(lockFile(), 'utf8')).toBe('another owner');
    expect(await readFile(reservationsFile(), 'utf8')).toBe(before);
  });

  it('ignores a malformed unrelated same-SDK network index', async () => {
    const store = createEncryptedIdentityStore();
    await store.bootstrapNetwork(OTHER_NETWORK);
    const indexPath = path.join(root(), OTHER_GENESIS.slice(0, 32), 'index.json');
    await writeFile(indexPath, '{', { mode: 0o600 });
    await expect(store.reserveIdentityIndex({ ...scope, identityIndex: 1, mode: 'used' })).resolves.toBeUndefined();
    await expect(store.listIdentityReservations(scope)).resolves.toEqual([1]);
  });

  it('fails closed when the current network index is malformed', async () => {
    const store = await bootstrappedStore();
    const indexPath = path.join(root(), GENESIS.slice(0, 32), 'index.json');
    await writeFile(indexPath, '{', { mode: 0o600 });
    await expect(store.reserveIdentityIndex({ ...scope, identityIndex: 1, mode: 'used' }))
      .rejects.toMatchObject({ code: 'STORAGE_FAILED' });
    await expect(access(reservationsFile())).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fails closed when the current network index has duplicate bare identity labels', async () => {
    const store = await bootstrappedStore();
    const first = awaitingRecord();
    first.selection = { ...first.selection, network: NETWORK.caip2, identityIndex: 1 };
    const second = awaitingRecord();
    second.id = '9'.repeat(64);
    second.selection = { ...second.selection, network: NETWORK.caip2, identityIndex: 2 };
    await store.create(first);
    await store.create(second);
    const indexPath = path.join(root(), GENESIS.slice(0, 32), 'index.json');
    const index = JSON.parse(await readFile(indexPath, 'utf8'));
    index.identities[first.id].label = '@duplicate';
    index.identities[second.id].label = 'duplicate';
    const corrupt = `${JSON.stringify(index)}\n`;
    await writeFile(indexPath, corrupt, { mode: 0o600 });

    await expect(store.reserveIdentityIndex({ ...scope, identityIndex: 3, mode: 'used' }))
      .rejects.toMatchObject({ code: 'STORAGE_FAILED' });
    expect(await readFile(indexPath, 'utf8')).toBe(corrupt);
    await expect(access(reservationsFile())).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['symlink', 'directory'] as const)('fails closed on a current network index that is a %s', async (kind) => {
    const store = await bootstrappedStore();
    const indexPath = path.join(root(), GENESIS.slice(0, 32), 'index.json');
    await rm(indexPath);
    if (kind === 'symlink') {
      const outside = path.join(xdg.scratch(), 'outside-index.json');
      await writeFile(outside, JSON.stringify({ version: 1, network: NETWORK, identities: {} }), { mode: 0o600 });
      await symlink(outside, indexPath);
    } else {
      await mkdir(indexPath);
    }
    await expect(store.listIdentityReservations(scope)).rejects.toMatchObject({ code: 'STORAGE_FAILED' });
    await expect(access(reservationsFile())).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fails closed on a symlinked current network directory', async () => {
    const store = await bootstrappedStore();
    const networkDirectory = path.join(root(), GENESIS.slice(0, 32));
    const outside = path.join(xdg.scratch(), 'outside-network');
    await rename(networkDirectory, outside);
    await symlink(outside, networkDirectory);
    await expect(store.listIdentityReservations(scope)).rejects.toMatchObject({ code: 'STORAGE_FAILED' });
    expect((await lstat(networkDirectory)).isSymbolicLink()).toBe(true);
  });

  it('rejects insecure global reservation state without repairing it', async () => {
    await mkdir(root(), { recursive: true, mode: 0o700 });
    await writeFile(reservationsFile(), JSON.stringify({ version: 1, reservations: [] }), { mode: 0o600 });
    await chmod(reservationsFile(), 0o640);
    await expect(createEncryptedIdentityStore().listIdentityReservations(scope))
      .rejects.toMatchObject({ code: 'STORAGE_FAILED' });
    expect((await stat(reservationsFile())).mode & 0o777).toBe(0o640);
  });

  it('starts the 24-hour clock on the first reconciliation of a scoped v1 document', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-16T00:00:00.000Z'));
    await mkdir(root(), { recursive: true, mode: 0o700 });
    const legacy = { version: 1, reservations: [
      { ...scope, identityIndex: 2 },
      { ...scope, sourceId: OTHER_SOURCE_ID, identityIndex: 4 },
    ].sort((left, right) => left.sourceId.localeCompare(right.sourceId)) };
    await writeFile(reservationsFile(), JSON.stringify(legacy), { mode: 0o600 });
    const store = createEncryptedIdentityStore();

    await expect(store.listExpiredIdentityReservations(scope, Date.now(), 1)).resolves.toEqual([]);
    const migrated = JSON.parse(await readFile(reservationsFile(), 'utf8'));
    expect(migrated).toEqual({ version: 2, reservations: legacy.reservations.map((row) => ({
      ...row, state: 'reserved', reservedAt: Date.now(),
    })) });
    await expect(store.listExpiredIdentityReservations(scope, Date.now() + 86_400_000, 86_400_000))
      .resolves.toEqual([{ identityIndex: 2, reservedAt: Date.now() }]);
  });

  it('lists a valid legacy reservation as occupied without rewriting it', async () => {
    await mkdir(root(), { recursive: true, mode: 0o700 });
    const legacy = { version: 1, reservations: [{ ...scope, identityIndex: 2 }] };
    await writeFile(reservationsFile(), JSON.stringify(legacy), { mode: 0o600 });

    await expect(createEncryptedIdentityStore().listIdentityReservations(scope)).resolves.toEqual([2]);
    expect(JSON.parse(await readFile(reservationsFile(), 'utf8'))).toEqual(legacy);
  });

  it('starts a full waiting period for a historical non-ready record without seeding ready records', async () => {
    vi.useFakeTimers();
    const firstReservedAt = new Date('2026-10-15T00:00:00.000Z').getTime();
    vi.setSystemTime(firstReservedAt);
    const store = createEncryptedIdentityStore();
    await store.reserveIdentityIndex({ ...scope, identityIndex: 11, mode: 'explicit' });
    vi.setSystemTime(firstReservedAt + 86_400_000);
    await store.bootstrapNetwork(NETWORK);
    const historical = awaitingRecord();
    historical.selection = { ...historical.selection, network: NETWORK.caip2, identityIndex: 12 };
    await store.create({ ...historical, sourceId: SOURCE_ID });
    const ready = readyRecord();
    ready.id = '9'.repeat(64);
    ready.selection = { ...ready.selection, network: NETWORK.caip2, identityIndex: 13 };
    await store.create({ ...ready, sourceId: SOURCE_ID });

    await expect(store.listExpiredIdentityReservations(scope, Date.now(), 86_400_000))
      .resolves.toEqual([{ identityIndex: 11, reservedAt: firstReservedAt }]);
    expect(JSON.parse(await readFile(reservationsFile(), 'utf8'))).toEqual({
      version: 2,
      reservations: [
        { ...scope, identityIndex: 11, state: 'reserved', reservedAt: firstReservedAt },
        { ...scope, identityIndex: 12, state: 'reserved', reservedAt: Date.now() },
      ],
    });
    await expect(store.listExpiredIdentityReservations(scope, Date.now() + 86_400_000, 86_400_000))
      .resolves.toContainEqual({ identityIndex: 12, reservedAt: Date.now() });
  });

  it('lists only expired reserved rows and resolves them with timestamp CAS', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    const store = createEncryptedIdentityStore();
    await store.reserveIdentityIndex({ ...scope, identityIndex: 1, mode: 'explicit' });
    await store.reserveIdentityIndex({ ...scope, identityIndex: 2, mode: 'failed' });
    const reservedAt = Date.now();

    await expect(store.listExpiredIdentityReservations(scope, reservedAt + 999, 1_000)).resolves.toEqual([]);
    await expect(store.listExpiredIdentityReservations(scope, reservedAt + 1_000, 1_000))
      .resolves.toEqual([{ identityIndex: 1, reservedAt }]);
    const beforeCasFailure = await readFile(reservationsFile(), 'utf8');
    await expect(store.resolveIdentityReservation({
      ...scope, identityIndex: 1, reservedAt: reservedAt + 1, state: 'released', expectedWorkflow: null,
    })).rejects.toMatchObject({ code: 'INDEX_UNAVAILABLE' });
    expect(await readFile(reservationsFile(), 'utf8')).toBe(beforeCasFailure);
    await expect(store.listIdentityReservations(scope)).resolves.toEqual([1, 2]);
    await store.resolveIdentityReservation({ ...scope, identityIndex: 1, reservedAt, state: 'released', expectedWorkflow: null });
    await expect(store.listIdentityReservations(scope)).resolves.toEqual([2]);
    vi.setSystemTime(reservedAt + 2_000);
    await store.reserveIdentityIndex({ ...scope, identityIndex: 1, mode: 'explicit' });
    await expect(store.listExpiredIdentityReservations(scope, Date.now() + 1, 1))
      .resolves.toContainEqual({ identityIndex: 1, reservedAt: Date.now() });
  });

  it('supports both public failed transitions while preserving terminal occupancy', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    const store = createEncryptedIdentityStore();
    await store.reserveIdentityIndex({ ...scope, identityIndex: 1, mode: 'explicit' });
    await store.reserveIdentityIndex({ ...scope, identityIndex: 1, mode: 'failed' });
    await store.reserveIdentityIndex({ ...scope, identityIndex: 2, mode: 'explicit' });
    const expired = await store.listExpiredIdentityReservations(scope, Date.now() + 1, 1);
    const reservation = expired[0];
    expect(reservation).toBeDefined();
    if (!reservation) throw new Error('missing expired test reservation');
    const { reservedAt } = reservation;
    expect(reservedAt).toBe(Date.now());

    await store.resolveIdentityReservation({ ...scope, identityIndex: 2, reservedAt, state: 'failed' });

    await expect(store.listIdentityReservations(scope)).resolves.toEqual([1, 2]);
    expect(JSON.parse(await readFile(reservationsFile(), 'utf8')).reservations).toEqual([
      { ...scope, identityIndex: 1, state: 'failed', reservedAt: Date.now() },
      { ...scope, identityIndex: 2, state: 'failed', reservedAt: Date.now() },
    ]);
  });

  it.each([
    ['negative current time', -1, 1],
    ['zero timeout', 1_800_000_000_000, 0],
  ])('rejects %s without changing reservations', async (_label, now, timeoutMs) => {
    const store = createEncryptedIdentityStore();
    await store.reserveIdentityIndex({ ...scope, identityIndex: 1, mode: 'explicit' });
    const before = await readFile(reservationsFile(), 'utf8');

    await expect(store.listExpiredIdentityReservations(scope, now, timeoutMs))
      .rejects.toMatchObject({ code: 'STORAGE_FAILED' });
    expect(await readFile(reservationsFile(), 'utf8')).toBe(before);
  });

  it('never releases a ready identity and lets release override only a non-ready historical record', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    const store = createEncryptedIdentityStore();
    await store.bootstrapNetwork(NETWORK);
    const pending = awaitingRecord();
    pending.selection = { ...pending.selection, network: NETWORK.caip2, identityIndex: 5 };
    await store.create({ ...pending, sourceId: SOURCE_ID });
    await store.reserveIdentityIndex({ ...scope, identityIndex: 5, mode: 'used' });
    const ready = readyRecord();
    ready.id = '9'.repeat(64);
    ready.selection = { ...ready.selection, network: NETWORK.caip2, identityIndex: 6 };
    await store.create({ ...ready, sourceId: SOURCE_ID });
    const document = JSON.parse(await readFile(reservationsFile(), 'utf8'));
    const pendingRow = document.reservations.find((row: { identityIndex: number }) => row.identityIndex === 5);
    pendingRow.state = 'reserved';
    const readyRow = { ...scope, identityIndex: 6, state: 'reserved', reservedAt: Date.now() };
    document.reservations = [pendingRow, readyRow];
    await writeFile(reservationsFile(), `${JSON.stringify(document)}\n`, { mode: 0o600 });

    const pendingWorkflow = (await store.readIndex(NETWORK.caip2)).identities[pending.id]!.workflow;
    await store.resolveIdentityReservation({
      ...scope, identityIndex: 5, reservedAt: pendingRow.reservedAt, state: 'released', expectedWorkflow: pendingWorkflow,
    });
    await expect(store.listIdentityReservations(scope)).resolves.toEqual([6]);
    expect((await store.readIndex(NETWORK.caip2)).identities[pending.id]!.workflow)
      .toEqual({ ...pendingWorkflow, status: 'expired' });
    await expect(store.save({ ...pending, status: 'pending', retrievalUrl: 'https://idp.example/old' }, pendingWorkflow))
      .rejects.toMatchObject({ code: 'INDEX_UNAVAILABLE' });
    const readyWorkflow = (await store.readIndex(NETWORK.caip2)).identities[ready.id]!.workflow;
    await store.resolveIdentityReservation({
      ...scope, identityIndex: 6, reservedAt: readyRow.reservedAt, state: 'released', expectedWorkflow: readyWorkflow,
    });
    await expect(store.listIdentityReservations(scope)).resolves.toEqual([6]);
    expect(JSON.parse(await readFile(reservationsFile(), 'utf8')).reservations)
      .toContainEqual({ ...readyRow, state: 'used' });
  });

  it('rejects release when a historical workflow changes after the reconciliation snapshot', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    const store = createEncryptedIdentityStore();
    await store.bootstrapNetwork(NETWORK);
    const record = awaitingRecord();
    record.selection = { ...record.selection, network: NETWORK.caip2, identityIndex: 7 };
    await store.create({ ...record, sourceId: SOURCE_ID });
    await store.listExpiredIdentityReservations(scope, Date.now(), 1);
    const document = JSON.parse(await readFile(reservationsFile(), 'utf8'));
    const row = document.reservations[0];
    const expectedEntry = (await store.readIndex(NETWORK.caip2)).identities[record.id];
    expect(expectedEntry).toBeDefined();
    if (!expectedEntry) throw new Error('missing test identity');
    const expectedWorkflow = expectedEntry.workflow;
    await store.save(
      { ...record, sourceId: SOURCE_ID, status: 'pending', retrievalUrl: 'https://issuer.example.test/result' },
      expectedWorkflow,
    );

    await expect(store.resolveIdentityReservation({
      ...scope, identityIndex: 7, reservedAt: row.reservedAt, state: 'released', expectedWorkflow,
    })).rejects.toMatchObject({ code: 'INDEX_UNAVAILABLE' });
    await expect(store.listIdentityReservations(scope)).resolves.toContain(7);
    expect(JSON.parse(await readFile(reservationsFile(), 'utf8')).reservations[0].state).toBe('reserved');
  });

  it('re-reserves a released non-ready indexed identity in the same scope', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    const store = createEncryptedIdentityStore();
    await store.bootstrapNetwork(NETWORK);
    const record = awaitingRecord();
    record.selection = { ...record.selection, network: NETWORK.caip2, identityIndex: 10 };
    await store.create({ ...record, sourceId: SOURCE_ID });
    await store.listExpiredIdentityReservations(scope, Date.now(), 1);
    const document = JSON.parse(await readFile(reservationsFile(), 'utf8'));
    const row = document.reservations[0];
    const entry = (await store.readIndex(NETWORK.caip2)).identities[record.id];
    expect(entry).toBeDefined();
    if (!entry) throw new Error('missing test identity');
    await store.resolveIdentityReservation({
      ...scope, identityIndex: 10, reservedAt: row.reservedAt, state: 'released', expectedWorkflow: entry.workflow,
    });

    vi.setSystemTime(Date.now() + 1);
    await expect(store.reserveIdentityIndex({ ...scope, identityIndex: 10, mode: 'explicit' })).resolves.toBeUndefined();
    expect(JSON.parse(await readFile(reservationsFile(), 'utf8')).reservations)
      .toContainEqual({ ...scope, identityIndex: 10, state: 'reserved', reservedAt: Date.now() });
  });
});

describe('identity monitor candidates', () => {
  const ATTEMPT = '018f47a2-43d2-7ad9-8b5e-89d810f95a22';
  const NOW = 1_900_000_000_000;

  it('reads exact reservation provenance without initializing missing, legacy, or invalid rows', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const store = createEncryptedIdentityStore();
    await expect(store.readIdentityRequestReservation({ ...scope, identityIndex: 2 })).resolves.toBeUndefined();
    await store.reserveIdentityIndex({ ...scope, identityIndex: 2, mode: 'explicit' });
    await expect(store.readIdentityRequestReservation({ ...scope, identityIndex: 2 })).resolves.toEqual({
      state: 'reserved', reservedAt: NOW,
    });
    await expect(store.readIdentityRequestReservation({ ...scope, identityIndex: 3 })).resolves.toBeUndefined();
    await expect(Reflect.apply(store.readIdentityRequestReservation, store, [{ ...scope, identityIndex: -1 }]))
      .rejects.toMatchObject({ code: 'STORAGE_FAILED' });

    const legacy = { version: 1, reservations: [{ ...scope, identityIndex: 2 }] };
    await writeFile(reservationsFile(), JSON.stringify(legacy), { mode: 0o600 });
    await expect(store.readIdentityRequestReservation({ ...scope, identityIndex: 2 })).resolves.toBeUndefined();
    expect(JSON.parse(await readFile(reservationsFile(), 'utf8'))).toEqual(legacy);
  });

  it('returns no candidates when global reservation storage does not exist', async () => {
    await expect(createEncryptedIdentityStore().listIdentityMonitorCandidates(NOW)).resolves.toEqual([]);
    await expect(access(root())).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('returns no candidates for a legacy reservation document without rewriting it', async () => {
    await mkdir(root(), { recursive: true, mode: 0o700 });
    const legacy = { version: 1, reservations: [{ ...scope, identityIndex: 2 }] };
    await writeFile(reservationsFile(), JSON.stringify(legacy), { mode: 0o600 });
    await expect(createEncryptedIdentityStore().listIdentityMonitorCandidates(NOW)).resolves.toEqual([]);
    expect(JSON.parse(await readFile(reservationsFile(), 'utf8'))).toEqual(legacy);
  });

  it('joins strict non-ready attempts to their fully scoped reserved rows without mutating either file', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const store = createEncryptedIdentityStore();
    await store.bootstrapNetwork(NETWORK);
    await store.reserveIdentityIndex({ ...scope, identityIndex: 2, mode: 'explicit' });
    await store.create({ ...awaitingRecord(), requestAttemptId: ATTEMPT });
    const indexFile = path.join(root(), GENESIS.slice(0, 32), 'index.json');
    const beforeIndex = await readFile(indexFile, 'utf8');
    const beforeReservations = await readFile(reservationsFile(), 'utf8');

    await expect(store.listIdentityMonitorCandidates(NOW)).resolves.toEqual([{
      record: expect.objectContaining({
        id: awaitingRecord().id, status: 'awaiting_verification', requestAttemptId: ATTEMPT,
      }),
      reservedAt: NOW,
    }]);
    expect(await readFile(indexFile, 'utf8')).toBe(beforeIndex);
    expect(await readFile(reservationsFile(), 'utf8')).toBe(beforeReservations);
    await expect(access(lockFile())).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['awaiting_verification', 'error'] as const)(
    'keeps a %s attempt monitorable when completion partially persisted its reservation as used', async (status) => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const store = createEncryptedIdentityStore();
    await store.bootstrapNetwork(NETWORK);
    await store.reserveIdentityIndex({ ...scope, identityIndex: 2, mode: 'used' });
    await store.create({ ...awaitingRecord(), status, requestAttemptId: ATTEMPT });
    await expect(store.listIdentityMonitorCandidates(NOW)).resolves.toEqual([{
      record: expect.objectContaining({
        id: awaitingRecord().id, status, requestAttemptId: ATTEMPT,
      }),
      reservedAt: NOW,
    }]);
    await expect(store.readIdentityRequestReservation({ ...scope, identityIndex: 2 })).resolves.toEqual({
      state: 'used', reservedAt: NOW,
    });
    },
  );

  it('skips empty and historical-provider-only network directories while returning healthy candidates unchanged', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const store = createEncryptedIdentityStore();
    await store.bootstrapNetwork(NETWORK);
    await store.reserveIdentityIndex({ ...scope, identityIndex: 2, mode: 'explicit' });
    await store.create({ ...awaitingRecord(), requestAttemptId: ATTEMPT });
    const emptyReference = '56'.repeat(16);
    const providerReference = '78'.repeat(16);
    const emptyDirectory = path.join(root(), emptyReference);
    const providerDirectory = path.join(root(), providerReference);
    await mkdir(emptyDirectory, { recursive: true, mode: 0o700 });
    await mkdir(providerDirectory, { recursive: true, mode: 0o700 });
    const inventory = {
      version: 1, genesisHash: '78'.repeat(32), refreshedAt: '2026-10-17T00:00:00.000Z',
      providers: [], anonymityRevokers: [],
    };
    await writeFile(path.join(providerDirectory, 'idp-inventory.json'), `${JSON.stringify(inventory)}\n`, { mode: 0o600 });
    const beforeInventory = await readFile(path.join(providerDirectory, 'idp-inventory.json'), 'utf8');
    const beforeEntries = {
      empty: await readdir(emptyDirectory), provider: await readdir(providerDirectory),
    };

    await expect(store.listIdentityMonitorCandidates(NOW)).resolves.toEqual([{
      record: expect.objectContaining({ id: awaitingRecord().id, requestAttemptId: ATTEMPT }),
      reservedAt: NOW,
    }]);
    expect(await readdir(emptyDirectory)).toEqual(beforeEntries.empty);
    expect(await readdir(providerDirectory)).toEqual(beforeEntries.provider);
    expect(await readFile(path.join(providerDirectory, 'idp-inventory.json'), 'utf8')).toBe(beforeInventory);
  });

  it.each([
    ['lone index', 'index.json'],
    ['lone credential registry', 'credentials.json'],
    ['orphan ciphertext', `${'9'.repeat(64)}.json`],
  ])('fails closed when candidate scanning finds a %s in another network', async (_name, filename) => {
    const store = createEncryptedIdentityStore();
    await store.bootstrapNetwork(NETWORK);
    await store.reserveIdentityIndex({ ...scope, identityIndex: 2, mode: 'explicit' });
    await store.create({ ...awaitingRecord(), requestAttemptId: ATTEMPT });
    const corruptDirectory = path.join(root(), 'ab'.repeat(16));
    await mkdir(corruptDirectory, { recursive: true, mode: 0o700 });
    await writeFile(path.join(corruptDirectory, filename), '{}\n', { mode: 0o600 });

    await expect(store.listIdentityMonitorCandidates(NOW)).rejects.toMatchObject({ code: 'STORAGE_FAILED' });
  });

  it('fails closed on non-directory network entries, inaccessible indexes, and path/genesis mismatch', async () => {
    const makeStore = async () => {
      const store = createEncryptedIdentityStore();
      await store.reserveIdentityIndex({ ...scope, identityIndex: 2, mode: 'explicit' });
      return store;
    };

    let store = await makeStore();
    await writeFile(path.join(root(), 'ab'.repeat(16)), 'not-a-directory', { mode: 0o600 });
    await expect(store.listIdentityMonitorCandidates(NOW)).rejects.toMatchObject({ code: 'STORAGE_FAILED' });
    await rm(root(), { recursive: true, force: true });

    store = await makeStore();
    const loopDirectory = path.join(root(), 'cd'.repeat(16));
    await mkdir(loopDirectory, { mode: 0o700 });
    await symlink('index.json', path.join(loopDirectory, 'index.json'));
    await expect(store.listIdentityMonitorCandidates(NOW)).rejects.toMatchObject({ code: 'STORAGE_FAILED' });
    await rm(root(), { recursive: true, force: true });

    store = await makeStore();
    await store.bootstrapNetwork(NETWORK);
    await rename(path.join(root(), GENESIS.slice(0, 32)), path.join(root(), 'ef'.repeat(16)));
    await expect(store.listIdentityMonitorCandidates(NOW)).rejects.toMatchObject({ code: 'STORAGE_FAILED' });
  });

  it('excludes terminal, missing-attempt, unreserved, released, failed, and mismatched-scope records', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const store = createEncryptedIdentityStore();
    await store.bootstrapNetwork(NETWORK);
    const make = (idByte: string, identityIndex: number, patch: Record<string, unknown> = {}) => ({
      ...awaitingRecord(), id: idByte.repeat(64),
      selection: { ...awaitingRecord().selection, identityIndex }, requestAttemptId: ATTEMPT, ...patch,
    });
    await store.reserveIdentityIndex({ ...scope, identityIndex: 1, mode: 'explicit' });
    const missingAttempt = make('1', 1);
    delete (missingAttempt as { requestAttemptId?: string }).requestAttemptId;
    await store.create(missingAttempt);
    await store.create(make('2', 2));
    await store.reserveIdentityIndex({ ...scope, identityIndex: 3, mode: 'failed' });
    await store.create(make('3', 3));
    await store.reserveIdentityIndex({ ...scope, identityIndex: 4, mode: 'explicit' });
    await store.resolveIdentityReservation({
      ...scope, identityIndex: 4, reservedAt: NOW, state: 'released',
      expectedWorkflow: null,
    });
    await store.create(make('4', 4));
    await store.reserveIdentityIndex({ ...scope, identityIndex: 5, mode: 'used' });
    await store.create(readyRecord({
      id: '5'.repeat(64), selection: { ...readyRecord().selection, network: NETWORK.caip2, identityIndex: 5 },
    }));
    await expect(store.listIdentityMonitorCandidates(NOW)).resolves.toEqual([]);
  });

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1])('rejects invalid monitor time %s without creating state', async (now) => {
    const store = createEncryptedIdentityStore();
    await expect(store.listIdentityMonitorCandidates(now)).rejects.toMatchObject({ code: 'STORAGE_FAILED' });
    await expect(access(reservationsFile())).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fails closed on malformed reservation provenance instead of monitoring an unbound record', async () => {
    const store = createEncryptedIdentityStore();
    await store.bootstrapNetwork(NETWORK);
    await store.create({ ...awaitingRecord(), requestAttemptId: ATTEMPT });
    await mkdir(root(), { recursive: true });
    await writeFile(reservationsFile(), JSON.stringify({
      version: 2, reservations: [{ ...scope, identityIndex: 2, state: 'reserved', reservedAt: -1 }],
    }), { mode: 0o600 });
    await expect(store.listIdentityMonitorCandidates(NOW)).rejects.toMatchObject({ code: 'STORAGE_FAILED' });
  });
});
