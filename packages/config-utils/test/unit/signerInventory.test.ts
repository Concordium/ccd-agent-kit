import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { keySchemes, type Ed25519PublicKeyHex } from '@ccd-agent-kit/sdk-utils';

import {
  createSignerInventoryUpdater,
  ed25519SignerKeyRef,
  findSignerInventoryKeyByLabel,
  forgetSignerInventoryKeyLocation,
  getSignerInventoryPath,
  loadSignerInventory,
  mergeBuiltInSignerBackend,
  parseSoftwareBackend,
  parseYubiKeyPivBackend,
  publicKeyFromEd25519SignerKeyRef,
  reorderSignerInventoryKeyBackends,
  reorderSignerInventoryKeyLocations,
  forgetYubiKeyPivSignerLocator,
  setSignerInventoryKeyLabel,
  setSignerInventoryKeySoftLabel,
  upsertSignerInventoryKey,
  type PivDeviceLocator,
  type SoftwareSignerBackend,
} from '../../src/index.js';
import { useConfigSandbox } from '../helpers/configSandbox.js';

const KEY_A = '11'.repeat(32) as Ed25519PublicKeyHex;
const KEY_B = '22'.repeat(32) as Ed25519PublicKeyHex;
const KEY_C = '33'.repeat(32) as Ed25519PublicKeyHex;

function software(publicKey: Ed25519PublicKeyHex, label?: string) {
  return {
    publicKey,
    scheme: 'Ed25519' as const,
    signingModule: 'software-signer',
    backend: { keyRef: `keys/${publicKey}.json`, storageModule: 'future-storage' },
    ...(label === undefined ? {} : { label }),
  };
}

function persisted(): string {
  return readFileSync(getSignerInventoryPath(), 'utf8');
}

function persistRaw(value: unknown): string {
  mkdirSync(dirname(getSignerInventoryPath()), { recursive: true, mode: 0o700 });
  const text = `${JSON.stringify(value)}\n`;
  writeFileSync(getSignerInventoryPath(), text, { mode: 0o600 });
  return text;
}

function persistSoftwareLocation(location: unknown): string {
  return persistRaw({
    version: 1, updatedAt: 'now', keys: {
      [ed25519SignerKeyRef(KEY_A)]: {
        scheme: 'Ed25519', createdAt: 'created', updatedAt: 'updated',
        backends: [{
          signingModule: 'software-signer', backend: location,
          createdAt: 'backend-created', updatedAt: 'backend-updated',
        }],
      },
    },
  });
}

describe('shared signing-material catalog', () => {
  useConfigSandbox();

  it('uses canonical key references and an empty non-persisted default', () => {
    expect(ed25519SignerKeyRef(KEY_A)).toBe(`ed25519:${KEY_A}`);
    expect(publicKeyFromEd25519SignerKeyRef(`ed25519:${KEY_A}`)).toBe(KEY_A);
    expect(publicKeyFromEd25519SignerKeyRef(`ed25519:${'ab'.repeat(32).toUpperCase()}`)).toBeUndefined();
    expect(publicKeyFromEd25519SignerKeyRef('p256:bad')).toBeUndefined();
    expect(loadSignerInventory()).toEqual({ version: 1, updatedAt: expect.any(String), keys: {} });
  });

  it('finds hard and soft signer labels canonically without treating key references or unlabeled keys as labels', () => {
    upsertSignerInventoryKey(software(KEY_A, 'PrimaryKey'));
    upsertSignerInventoryKey(software(KEY_B));
    upsertSignerInventoryKey(software(KEY_C));
    setSignerInventoryKeyLabel({ publicKey: KEY_C, label: 'AgentKey', mode: 'soft' });

    const hard = findSignerInventoryKeyByLabel(' primarykey ');
    const soft = findSignerInventoryKeyByLabel('AGENTKEY');
    expect(hard?.[0]).toBe(ed25519SignerKeyRef(KEY_A));
    expect(hard?.[1]).toEqual(loadSignerInventory().keys[ed25519SignerKeyRef(KEY_A)]);
    expect(soft?.[0]).toBe(ed25519SignerKeyRef(KEY_C));
    expect(soft?.[1].label).toBe('@AgentKey');
    expect(findSignerInventoryKeyByLabel('Missing')).toBeUndefined();
    expect(findSignerInventoryKeyByLabel('ed25519')).toBeUndefined();
    expect(() => findSignerInventoryKeyByLabel(ed25519SignerKeyRef(KEY_B))).toThrow();
    expect(() => findSignerInventoryKeyByLabel('@AgentKey')).toThrow();
  });

  it('preserves backend and device-location insertion order while updating an existing location in place', () => {
    upsertSignerInventoryKey(software(KEY_A, 'primary'));
    for (const [serial, touchPolicy] of [['11111111', undefined], ['22222222', 'always'], ['11111111', 'cached']] as const) {
      upsertSignerInventoryKey({
        publicKey: KEY_A,
        scheme: 'Ed25519',
        signingModule: 'yubikey-piv',
        backend: { devices: [{ kind: 'yubikey', serial, slot: '9c', ...(touchPolicy ? { touchPolicy } : {}) }] },
      });
    }

    expect(loadSignerInventory().keys[ed25519SignerKeyRef(KEY_A)]).toMatchObject({
      label: 'primary',
      backends: [
        { signingModule: 'software-signer' },
        { signingModule: 'yubikey-piv', backend: { devices: [
          { kind: 'yubikey', serial: '11111111', slot: '9c', touchPolicy: 'cached' },
          { kind: 'yubikey', serial: '22222222', slot: '9c', touchPolicy: 'always' },
        ] } },
      ],
    });
  });

  it('keeps generic and YubiKey locations distinct and drops malformed parsed locations', () => {
    expect(parseYubiKeyPivBackend({ devices: [
      { kind: 'generic_piv', slot: '9c', chuid: 'one', certificateFingerprint: 'aa', lastSeenAt: 'now' },
      { kind: 'generic_piv', slot: '82' },
      { kind: 'yubikey', serial: '123', slot: '82', pinPolicy: 'once', lastSeenAt: 'now' },
      { kind: 'yubikey', serial: 'bad', slot: '9d' },
      { kind: 'yubikey', serial: 'bad', slot: '9c', touchPolicy: 'sometimes' },
      { kind: 'yubikey', serial: 123, slot: '9c' },
      { kind: 'generic_piv', slot: '9d' },
      { kind: 'future', slot: '9c' },
      null,
    ] })).toEqual({ devices: [
      { kind: 'generic_piv', slot: '9c', chuid: 'one', certificateFingerprint: 'aa', lastSeenAt: 'now' },
      { kind: 'generic_piv', slot: '82' },
      { kind: 'yubikey', serial: '123', slot: '82', pinPolicy: 'once', lastSeenAt: 'now' },
    ] });
    expect(parseYubiKeyPivBackend(null)).toBeUndefined();
    expect(parseSoftwareBackend({ storageModule: 'encrypted-file', keyRef: 'keys/a' })).toEqual({
      storageModule: 'encrypted-file', keyRef: 'keys/a',
    });
    expect(parseSoftwareBackend({ keyRef: 1 })).toBeUndefined();
    expect(mergeBuiltInSignerBackend(
      { signingModule: 'yubikey-piv', backend: 'malformed', createdAt: 'now', updatedAt: 'now' },
      { publicKey: KEY_A, scheme: 'Ed25519', signingModule: 'yubikey-piv', backend: { devices: [] } },
    )).toBeUndefined();
    expect(mergeBuiltInSignerBackend(
      { signingModule: 'software-signer', backend: {}, createdAt: 'now', updatedAt: 'now' },
      software(KEY_A),
    )).toBeUndefined();
  });

  it('merges generic locations by slot while keeping different locator kinds separate', () => {
    upsertSignerInventoryKey({
      publicKey: KEY_A, scheme: 'Ed25519', signingModule: 'yubikey-piv',
      backend: { devices: [{ kind: 'generic_piv', slot: '9c', chuid: 'old' }] },
    });
    upsertSignerInventoryKey({
      publicKey: KEY_A, scheme: 'Ed25519', signingModule: 'yubikey-piv',
      backend: { devices: [
        { kind: 'generic_piv', slot: '9c', chuid: 'new' },
        { kind: 'yubikey', serial: '123', slot: '9c' },
      ] },
    });
    expect(loadSignerInventory().keys[ed25519SignerKeyRef(KEY_A)]?.backends[0]?.backend).toEqual({ devices: [
      { kind: 'generic_piv', slot: '9c', chuid: 'new' },
      { kind: 'yubikey', serial: '123', slot: '9c' },
    ] });
  });

  it('persists the prepared signer label while preserving unrelated inventory', () => {
    upsertSignerInventoryKey(software(KEY_A));
    upsertSignerInventoryKey(software(KEY_B, 'Unrelated'));
    setSignerInventoryKeyLabel({ publicKey: KEY_A, label: 'AgentCase', mode: 'soft' });

    expect(loadSignerInventory().keys[ed25519SignerKeyRef(KEY_A)]?.label).toBe('@AgentCase');
    expect(loadSignerInventory().keys[ed25519SignerKeyRef(KEY_B)]?.label).toBe('Unrelated');
    expect(findSignerInventoryKeyByLabel('agentcase')?.[0]).toBe(ed25519SignerKeyRef(KEY_A));
  });

  it('removes a soft signer label without removing its material', () => {
    upsertSignerInventoryKey(software(KEY_A));
    setSignerInventoryKeyLabel({ publicKey: KEY_A, label: 'AgentCase', mode: 'soft' });

    setSignerInventoryKeySoftLabel({ publicKey: KEY_A });

    expect(loadSignerInventory().keys[ed25519SignerKeyRef(KEY_A)]?.label).toBeUndefined();
    expect(loadSignerInventory().keys).toHaveProperty(ed25519SignerKeyRef(KEY_A));
  });

  it('rejects labels for absent signing material without changing inventory', () => {
    upsertSignerInventoryKey(software(KEY_A, 'Existing'));
    const before = persisted();

    expect(() => setSignerInventoryKeyLabel({ publicKey: KEY_C, label: 'missing' })).toThrow();
    expect(persisted()).toBe(before);
  });

  it('protects a hard signer label without changing unrelated inventory state', () => {
    upsertSignerInventoryKey(software(KEY_A, 'Protected'));
    upsertSignerInventoryKey(software(KEY_B));
    const before = persisted();

    let failure: unknown;
    try {
      setSignerInventoryKeySoftLabel({ publicKey: KEY_A, label: 'Replacement' });
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({ name: 'CatalogLabelError', code: 'LABEL_PROTECTED' });
    expect(persisted()).toBe(before);
    expect(loadSignerInventory().keys[ed25519SignerKeyRef(KEY_A)]?.label).toBe('Protected');
    expect(loadSignerInventory().keys[ed25519SignerKeyRef(KEY_B)]?.label).toBeUndefined();
  });

  it('recovers an operation-local updater after a failed write and retains earlier batch successes', () => {
    const batch = createSignerInventoryUpdater();
    batch.upsert(software(KEY_A, 'same'));
    expect(() => batch.upsert(software(KEY_B, 'same'))).toThrow();
    expect(loadSignerInventory().keys).toHaveProperty(ed25519SignerKeyRef(KEY_A));
    expect(loadSignerInventory().keys).not.toHaveProperty(ed25519SignerKeyRef(KEY_B));

    const updater = createSignerInventoryUpdater();
    expect(updater.getEntry(KEY_A)?.label).toBe('same');
    expect(() => updater.upsert(software(KEY_B, 'same'))).toThrow();
    updater.upsert(software(KEY_C, 'third'));
    expect(loadSignerInventory().keys).toHaveProperty(ed25519SignerKeyRef(KEY_C));
  });

  it('removes only matching YubiKey locations and preserves unrelated ordered backends', () => {
    upsertSignerInventoryKey(software(KEY_A));
    upsertSignerInventoryKey({
      publicKey: KEY_A, scheme: 'Ed25519', signingModule: 'yubikey-piv',
      backend: { devices: [
        { kind: 'yubikey', serial: '111', slot: '9c' },
        { kind: 'yubikey', serial: '222', slot: '82' },
      ] },
    });
    expect(forgetYubiKeyPivSignerLocator({ publicKey: KEY_A, serial: '111', slot: '9c' })).toEqual({ removedPublicKeys: [KEY_A] });
    expect(forgetYubiKeyPivSignerLocator({ serial: 'missing', slot: '9c' })).toEqual({ removedPublicKeys: [] });
    expect(loadSignerInventory().keys[ed25519SignerKeyRef(KEY_A)]?.backends).toMatchObject([
      { signingModule: 'software-signer' },
      { signingModule: 'yubikey-piv', backend: { devices: [{ serial: '222', slot: '82' }] } },
    ]);
    expect(forgetYubiKeyPivSignerLocator({ serial: '222', slot: '82' })).toEqual({ removedPublicKeys: [KEY_A] });
    expect(loadSignerInventory().keys[ed25519SignerKeyRef(KEY_A)]?.backends).toHaveLength(1);

    upsertSignerInventoryKey({
      publicKey: KEY_B, scheme: 'Ed25519', signingModule: 'yubikey-piv',
      backend: { devices: [
        { kind: 'yubikey', serial: '333', slot: '9c' },
        { kind: 'yubikey', serial: '333', slot: '82' },
      ] },
    });
    expect(forgetYubiKeyPivSignerLocator({ serial: '333', slot: '9c' })).toEqual({ removedPublicKeys: [KEY_B] });
    expect(forgetYubiKeyPivSignerLocator({ serial: '333', slot: '82' })).toEqual({ removedPublicKeys: [KEY_B] });
    expect(loadSignerInventory().keys[ed25519SignerKeyRef(KEY_B)]).toBeUndefined();
  });

  it('reorders an exact backend permutation while preserving backend payloads and metadata', () => {
    persistRaw({
      version: 1, updatedAt: 'catalog-time', keys: {
        [ed25519SignerKeyRef(KEY_A)]: {
          scheme: 'Ed25519', label: 'primary', createdAt: 'key-created', updatedAt: 'key-updated',
          keyExtension: true,
          backends: [
            { signingModule: 'software-signer', backend: { storageModule: 'encrypted-file', keyRef: 'keys/a' }, createdAt: 'software-created', updatedAt: 'software-updated', envelopeExtension: 1 },
            { signingModule: 'yubikey-piv', backend: { devices: [{ kind: 'yubikey', serial: '123', slot: '9c' }] }, createdAt: 'piv-created', updatedAt: 'piv-updated', envelopeExtension: 2 },
          ],
        },
      },
    });
    const before = loadSignerInventory().keys[ed25519SignerKeyRef(KEY_A)]!;

    reorderSignerInventoryKeyBackends({ publicKey: KEY_A, backends: ['yubikey-piv', 'software-signer'] });

    const reordered = loadSignerInventory().keys[ed25519SignerKeyRef(KEY_A)]!;
    expect(reordered.backends).toEqual([before.backends[1], before.backends[0]]);
    expect({ ...reordered, backends: before.backends, updatedAt: before.updatedAt })
      .toEqual({ ...before, updatedAt: before.updatedAt });

    const stable = persisted();
    for (const backends of [
      ['yubikey-piv'],
      ['yubikey-piv', 'yubikey-piv'],
      ['yubikey-piv', 'unknown'],
      ['yubikey-piv', 'software-signer', 'unknown'],
    ]) {
      expect(() => reorderSignerInventoryKeyBackends({ publicKey: KEY_A, backends })).toThrow();
      expect(persisted()).toBe(stable);
    }
    expect(() => reorderSignerInventoryKeyBackends({ publicKey: KEY_B, backends: [] })).toThrow();
    expect(persisted()).toBe(stable);
  });

  it('rejects absent key and backend selectors for every inventory ordering mutation without changing state', () => {
    const location = { storageModule: 'encrypted-file', keyRef: 'keys/a' } satisfies SoftwareSignerBackend;
    upsertSignerInventoryKey({ ...software(KEY_A), backend: location });
    const before = persisted();
    const invalidTarget = { backend: 'future-plugin', location: { opaque: true } } as unknown as
      Exclude<Parameters<typeof forgetSignerInventoryKeyLocation>[1], 'all'>;

    for (const operation of [
      () => reorderSignerInventoryKeyBackends({ publicKey: KEY_B, backends: [] }),
      () => reorderSignerInventoryKeyLocations({ publicKey: KEY_B, signingModule: 'software-signer', locations: [location] }),
      () => forgetSignerInventoryKeyLocation(KEY_B, { backend: 'software-signer', location }),
      () => forgetSignerInventoryKeyLocation(KEY_A, invalidTarget),
    ]) {
      expect(operation).toThrow(Error);
      expect(persisted()).toBe(before);
    }
  });

  it('preserves a present opaque backend through reads, backend reorder, and whole-key forget', () => {
    const location = { opaque: true };
    persistRaw({
      version: 1, updatedAt: 'now', keys: {
        [ed25519SignerKeyRef(KEY_A)]: {
          scheme: 'Ed25519', createdAt: 'created', updatedAt: 'updated', backends: [{
            signingModule: 'future-plugin', backend: location, createdAt: 'backend-created', updatedAt: 'backend-updated',
          }],
        },
      },
    });
    expect(loadSignerInventory().keys[ed25519SignerKeyRef(KEY_A)]?.backends[0]?.backend).toEqual(location);
    reorderSignerInventoryKeyBackends({ publicKey: KEY_A, backends: ['future-plugin'] });
    expect(loadSignerInventory().keys[ed25519SignerKeyRef(KEY_A)]?.backends[0]?.backend).toEqual(location);
    forgetSignerInventoryKeyLocation(KEY_A, 'all');
    expect(loadSignerInventory().keys[ed25519SignerKeyRef(KEY_A)]).toBeUndefined();
  });

  it('reorders hardware locations by stable locator identity while preserving every stored field', () => {
    const first = {
      kind: 'yubikey', serial: '111', slot: '9c', pinPolicy: 'once', touchPolicy: 'cached',
      lastSeenAt: 'first-observation', extension: 'keep-first',
    };
    const second = {
      kind: 'yubikey', serial: '222', slot: '82', pinPolicy: 'always', touchPolicy: 'always',
      lastSeenAt: 'second-observation', extension: 'keep-second',
    };
    persistRaw({
      version: 1, updatedAt: 'catalog-time', keys: {
        [ed25519SignerKeyRef(KEY_A)]: {
          scheme: 'Ed25519', createdAt: 'created', updatedAt: 'updated', backends: [{
            signingModule: 'yubikey-piv', createdAt: 'backend-created', updatedAt: 'backend-updated',
            envelopeExtension: true, backend: { devices: [first, second], payloadExtension: true },
          }],
        },
      },
    });

    reorderSignerInventoryKeyLocations({
      publicKey: KEY_A,
      signingModule: 'yubikey-piv',
      locations: [
        { kind: 'yubikey', serial: '222', slot: '82' } satisfies PivDeviceLocator,
        { kind: 'yubikey', serial: '111', slot: '9c' } satisfies PivDeviceLocator,
      ],
    });

    const backend = loadSignerInventory().keys[ed25519SignerKeyRef(KEY_A)]!.backends[0]!;
    expect(backend).toMatchObject({
      envelopeExtension: true,
      backend: { devices: [second, first], payloadExtension: true },
    });
    const stable = persisted();
    for (const locations of [
      [{ kind: 'yubikey', serial: '111', slot: '9c' }],
      [{ kind: 'yubikey', serial: '111', slot: '9c' }, { kind: 'yubikey', serial: '111', slot: '9c' }],
      [{ kind: 'yubikey', serial: '111', slot: '9c' }, { kind: 'yubikey', serial: '999', slot: '82' }],
      [{ kind: 'yubikey', serial: '111' }, { kind: 'yubikey', serial: '222', slot: '82' }],
    ]) {
      const input = { publicKey: KEY_A, signingModule: 'yubikey-piv', locations } as unknown as
        Parameters<typeof reorderSignerInventoryKeyLocations>[0];
      expect(() => reorderSignerInventoryKeyLocations(input)).toThrow();
      expect(persisted()).toBe(stable);
    }
  });

  it('rejects malformed stored and requested YubiKey locations without rewriting inventory', () => {
    const valid = { kind: 'yubikey', serial: '111', slot: '9c' } satisfies PivDeviceLocator;
    const malformed = { kind: 'yubikey', serial: 222, slot: '9c' };
    persistRaw({
      version: 1, updatedAt: 'now', keys: {
        [ed25519SignerKeyRef(KEY_A)]: {
          scheme: 'Ed25519', createdAt: 'created', updatedAt: 'updated', backends: [{
            signingModule: 'yubikey-piv', backend: { devices: [malformed, valid] },
            createdAt: 'backend-created', updatedAt: 'backend-updated',
          }],
        },
      },
    });
    const malformedStored = persisted();
    expect(() => reorderSignerInventoryKeyLocations({
      publicKey: KEY_A, signingModule: 'yubikey-piv', locations: [valid, valid],
    })).toThrow(Error);
    expect(persisted()).toBe(malformedStored);
    expect(() => forgetSignerInventoryKeyLocation(KEY_A, {
      backend: 'yubikey-piv', location: valid,
    })).toThrow(Error);
    expect(persisted()).toBe(malformedStored);

    persistRaw({
      version: 1, updatedAt: 'now', keys: {
        [ed25519SignerKeyRef(KEY_A)]: {
          scheme: 'Ed25519', createdAt: 'created', updatedAt: 'updated', backends: [{
            signingModule: 'yubikey-piv', backend: { devices: [valid] },
            createdAt: 'backend-created', updatedAt: 'backend-updated',
          }],
        },
      },
    });
    const malformedRequested = persisted();
    const invalidReorder = {
      publicKey: KEY_A, signingModule: 'yubikey-piv', locations: [malformed],
    } as unknown as Parameters<typeof reorderSignerInventoryKeyLocations>[0];
    expect(() => reorderSignerInventoryKeyLocations(invalidReorder)).toThrow(Error);
    expect(persisted()).toBe(malformedRequested);
    const invalidTarget = {
      backend: 'yubikey-piv', location: malformed,
    } as unknown as Exclude<Parameters<typeof forgetSignerInventoryKeyLocation>[1], 'all'>;
    expect(() => forgetSignerInventoryKeyLocation(KEY_A, invalidTarget)).toThrow(Error);
    expect(persisted()).toBe(malformedRequested);
  });

  it('treats a software backend as one ordered location and rejects malformed known backends', () => {
    const location = { storageModule: 'encrypted-file', keyRef: 'keys/a' } satisfies SoftwareSignerBackend;
    upsertSignerInventoryKey({ ...software(KEY_A), backend: location });
    expect(() => reorderSignerInventoryKeyLocations({
      publicKey: KEY_A, signingModule: 'software-signer', locations: [location],
    })).not.toThrow();
    const stable = persisted();
    expect(() => reorderSignerInventoryKeyLocations({
      publicKey: KEY_A, signingModule: 'software-signer', locations: [],
    })).toThrow();
    expect(persisted()).toBe(stable);

    persistRaw({
      version: 1, updatedAt: 'now', keys: {
        [ed25519SignerKeyRef(KEY_A)]: {
          scheme: 'Ed25519', createdAt: 'created', updatedAt: 'updated',
          backends: [{ signingModule: 'yubikey-piv', backend: { devices: 'invalid' }, createdAt: 'created', updatedAt: 'updated' }],
        },
      },
    });
    const malformed = persisted();
    expect(() => reorderSignerInventoryKeyLocations({
      publicKey: KEY_A, signingModule: 'yubikey-piv', locations: [],
    })).toThrow();
    expect(persisted()).toBe(malformed);
  });

  it.each([
    ['empty payload', {}],
    ['non-string storage module', { storageModule: 7, keyRef: 'keys/a' }],
    ['non-string key reference', { storageModule: 'encrypted-file', keyRef: 7 }],
  ])('rejects malformed stored and requested software locations (%s) without changing state', (_case, location) => {
    const stored = { storageModule: 'encrypted-file', keyRef: 'keys/a' } satisfies SoftwareSignerBackend;
    const before = persistSoftwareLocation(location);
    expect(() => reorderSignerInventoryKeyLocations({
      publicKey: KEY_A, signingModule: 'software-signer', locations: [stored],
    })).toThrow(Error);
    expect(persisted()).toBe(before);
    expect(() => forgetSignerInventoryKeyLocation(KEY_A, {
      backend: 'software-signer', location: stored,
    })).toThrow(Error);
    expect(persisted()).toBe(before);

    upsertSignerInventoryKey({ ...software(KEY_A), backend: stored });
    const valid = persisted();

    const input = {
      publicKey: KEY_A, signingModule: 'software-signer', locations: [location],
    } as unknown as Parameters<typeof reorderSignerInventoryKeyLocations>[0];
    expect(() => reorderSignerInventoryKeyLocations(input)).toThrow(Error);
    expect(persisted()).toBe(valid);
    const target = { backend: 'software-signer', location } as unknown as
      Exclude<Parameters<typeof forgetSignerInventoryKeyLocation>[1], 'all'>;
    expect(() => forgetSignerInventoryKeyLocation(KEY_A, target)).toThrow(Error);
    expect(persisted()).toBe(valid);
  });

  it('forgets exactly one public catalog location and prunes empty backends and keys only', () => {
    const retained = { kind: 'yubikey', serial: '111', slot: '9c', lastSeenAt: 'retained', extension: 1 };
    const forgotten = { kind: 'yubikey', serial: '222', slot: '82', lastSeenAt: 'forgotten', extension: 2 };
    persistRaw({
      version: 1, updatedAt: 'now', keys: {
        [ed25519SignerKeyRef(KEY_A)]: {
          scheme: 'Ed25519', createdAt: 'created', updatedAt: 'updated', backends: [
            { signingModule: 'yubikey-piv', backend: { devices: [retained, forgotten], extension: true }, createdAt: 'a', updatedAt: 'b' },
            { signingModule: 'software-signer', backend: { storageModule: 'encrypted-file', keyRef: 'keys/a' }, createdAt: 'c', updatedAt: 'd' },
          ],
        },
      },
    });
    const privateState = join(dirname(getSignerInventoryPath()), 'private-material');
    writeFileSync(privateState, 'must remain', { mode: 0o600 });

    const unchanged = persisted();
    expect(() => forgetSignerInventoryKeyLocation(KEY_A, {
      backend: 'yubikey-piv',
      location: { kind: 'yubikey', serial: 'missing', slot: '82' },
    })).toThrow();
    expect(persisted()).toBe(unchanged);

    forgetSignerInventoryKeyLocation(KEY_A, {
      backend: 'yubikey-piv',
      location: { kind: 'yubikey', serial: '222', slot: '82' },
    });
    expect(loadSignerInventory().keys[ed25519SignerKeyRef(KEY_A)]?.backends).toMatchObject([
      { signingModule: 'yubikey-piv', backend: { devices: [retained], extension: true } },
      { signingModule: 'software-signer' },
    ]);
    expect(readFileSync(privateState, 'utf8')).toBe('must remain');

    forgetSignerInventoryKeyLocation(KEY_A, {
      backend: 'yubikey-piv',
      location: { kind: 'yubikey', serial: '111', slot: '9c' },
    });
    expect(loadSignerInventory().keys[ed25519SignerKeyRef(KEY_A)]?.backends.map(entry => entry.signingModule))
      .toEqual(['software-signer']);
    forgetSignerInventoryKeyLocation(KEY_A, { backend: 'software-signer', location: {
      storageModule: 'encrypted-file', keyRef: 'keys/a',
    } });
    expect(loadSignerInventory().keys[ed25519SignerKeyRef(KEY_A)]).toBeUndefined();
    expect(readFileSync(privateState, 'utf8')).toBe('must remain');
  });

  it('forgets one whole public key record without deleting key material or unrelated keys', () => {
    upsertSignerInventoryKey(software(KEY_A));
    upsertSignerInventoryKey(software(KEY_B, 'retained'));
    const keyMaterial = join(dirname(getSignerInventoryPath()), 'keys', `${KEY_A}.json`);
    mkdirSync(dirname(keyMaterial), { recursive: true, mode: 0o700 });
    writeFileSync(keyMaterial, 'private key material', { mode: 0o600 });

    forgetSignerInventoryKeyLocation(KEY_A, 'all');

    expect(loadSignerInventory().keys[ed25519SignerKeyRef(KEY_A)]).toBeUndefined();
    expect(loadSignerInventory().keys[ed25519SignerKeyRef(KEY_B)]?.label).toBe('retained');
    expect(readFileSync(keyMaterial, 'utf8')).toBe('private key material');
    const before = persisted();
    expect(() => forgetSignerInventoryKeyLocation(KEY_A, 'all')).toThrow();
    expect(persisted()).toBe(before);
  });

  it('loads raw catalogs without stripping unknown envelopes, payloads, order, or stored label syntax', () => {
    const document = {
      version: 1, updatedAt: 'now', catalogExtension: { future: true },
      keys: {
        [ed25519SignerKeyRef(KEY_A)]: {
          scheme: 'Ed25519', label: '@Agent_1', createdAt: 'created', updatedAt: 'updated', keyExtension: 7,
          backends: [
            { signingModule: 'future-plugin', backend: { opaque: ['x', 1] }, createdAt: 'one', updatedAt: 'two', envelopeExtension: 'kept' },
            { signingModule: 'software-signer', backend: { storageModule: 'future-store', keyRef: 'opaque', payloadExtension: true }, createdAt: 'three', updatedAt: 'four' },
          ],
        },
      },
    };
    persistRaw(document);
    expect(loadSignerInventory()).toEqual(document);
  });

  it.each(['ed25519', ' ED25519 '])('accepts the persisted scheme alias %j and returns its canonical value', (scheme) => {
    persistRaw({
      version: 1, updatedAt: 'now', keys: {
        [ed25519SignerKeyRef(KEY_A)]: {
          scheme, backends: [], createdAt: 'created', updatedAt: 'updated',
        },
      },
    });
    expect(loadSignerInventory().keys[ed25519SignerKeyRef(KEY_A)]?.scheme).toBe(keySchemes.Ed25519);
  });

  it('retains unsupported raw devices and backend metadata while removing a recognized matching device', () => {
    persistRaw({
      version: 1, updatedAt: 'now', keys: {
        [ed25519SignerKeyRef(KEY_A)]: {
          scheme: 'Ed25519', createdAt: 'created', updatedAt: 'updated', backends: [
            { signingModule: 'future-plugin', backend: { order: 1 }, createdAt: 'a', updatedAt: 'b' },
            {
              signingModule: 'yubikey-piv', createdAt: 'c', updatedAt: 'd', envelopeExtension: 'outer',
              backend: { payloadExtension: 'inner', devices: [
                { kind: 'future-device', locator: 'opaque' },
                { kind: 'yubikey', serial: '123', slot: '9c', deviceExtension: true },
                { kind: 'yubikey', serial: '456', slot: '82', lastSeenAt: 'then' },
              ] },
            },
          ],
        },
      },
    });
    expect(forgetYubiKeyPivSignerLocator({ serial: '123', slot: '9c' })).toEqual({ removedPublicKeys: [KEY_A] });
    const entry = loadSignerInventory().keys[ed25519SignerKeyRef(KEY_A)]!;
    expect(entry.backends.map((backend) => backend.signingModule)).toEqual(['future-plugin', 'yubikey-piv']);
    expect(entry.backends[1]).toMatchObject({
      envelopeExtension: 'outer',
      backend: {
        payloadExtension: 'inner',
        devices: [
          { kind: 'future-device', locator: 'opaque' },
          { kind: 'yubikey', serial: '456', slot: '82', lastSeenAt: 'then' },
        ],
      },
    });
  });

  it('rejects malformed inventory references before locator removal can rewrite state', () => {
    const now = '2026-10-23T00:00:00.000Z';
    const malformed = {
      version: 1,
      updatedAt: now,
      keys: {
        invalid: { scheme: 'Ed25519', backends: [], createdAt: now, updatedAt: now },
        [ed25519SignerKeyRef(KEY_A)]: {
          scheme: 'Ed25519', createdAt: now, updatedAt: now,
          backends: [
            { signingModule: 'yubikey-piv', backend: null, createdAt: now, updatedAt: now },
            { signingModule: 'yubikey-piv', backend: {}, createdAt: now, updatedAt: now },
          ],
        },
      },
    };
    persistRaw(malformed);
    const before = persisted();
    expect(() => forgetYubiKeyPivSignerLocator({ serial: '123', slot: '9c' })).toThrow(/invalid/i);
    expect(persisted()).toBe(before);
  });

  it('rejects malformed, unsupported, duplicate-label, and unsafe persisted catalogs without rewriting', () => {
    const validEntry = {
      scheme: 'Ed25519', backends: [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', label: 'same',
    };
    for (const document of [
      { version: 2, updatedAt: 'now', keys: {} },
      { version: 1, updatedAt: 'now', keys: { bad: validEntry } },
      { version: 1, updatedAt: 'now', keys: { [ed25519SignerKeyRef(KEY_A)]: { ...validEntry, scheme: 'unknown' } } },
      { version: 1, updatedAt: 'now', keys: { [ed25519SignerKeyRef(KEY_A)]: { ...validEntry, label: '@bad label' } } },
      { version: 1, updatedAt: 'now', keys: { [ed25519SignerKeyRef(KEY_A)]: { ...validEntry, backends: [{ signingModule: 'plugin', createdAt: 'now', updatedAt: 'now' }] } } },
    ]) {
      const text = persistRaw(document);
      expect(() => loadSignerInventory()).toThrow();
      expect(readFileSync(getSignerInventoryPath(), 'utf8')).toBe(text);
    }
    chmodSync(getSignerInventoryPath(), 0o644);
    expect(() => loadSignerInventory()).toThrow(/unsafe/i);
  });
});
