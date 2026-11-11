import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createECDH, createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  assertIdentitySourceLabelAvailable,
  createIdentitySourceRegistry,
  deriveIdentitySourceId,
  getIdentitySourcesPath,
  IDENTITY_SOURCE_ID_PATTERN,
  IdentitySourceError,
  resolveIdentitySource,
  type IdentitySourceRegistryDocument,
  type IdentitySourceRecord,
} from '../../src/index.js';
import { useConfigSandbox } from '../helpers/configSandbox.js';

function source(label = 'primary', scalar?: number): IdentitySourceRecord {
  const ecdh = createECDH('prime256v1');
  if (scalar === undefined) ecdh.generateKeys();
  else {
    const key = Buffer.alloc(32);
    key[31] = scalar;
    ecdh.setPrivateKey(key);
    key.fill(0);
  }
  const root = ecdh.getPublicKey(undefined, 'uncompressed');
  return {
    label,
    backends: [{ backend: 'yubikey-piv', locations: [{ serial: '12345678' }, { serial: '87654321' }] }],
    rootPublicKey: root.toString('hex'),
    rootPublicKeyFingerprint: createHash('sha256').update(root).digest('hex'),
    recipeVersion: 1,
  };
}

describe('identity source catalog', () => {
  useConfigSandbox();

  it('enrolls a first root and merges ordered locations across repeated device enrollment', async () => {
    const registry = createIdentitySourceRegistry();
    const first = source('primary', 1);
    first.backends = [{ backend: 'yubikey-piv', locations: [{ serial: '11111111' }] }];
    const enrolled = await registry.enroll(first);
    const repeated = source('ignored', 1);
    repeated.backends = [
      { backend: 'yubikey-piv', locations: [{ serial: '11111111' }, { serial: '22222222' }] },
      { backend: 'future', locations: [{ key: 'third' }] },
    ];
    delete repeated.label;

    const merged = await registry.enroll(repeated);

    expect(enrolled.id).toBe(deriveIdentitySourceId(first.rootPublicKey, 1));
    expect(merged).toEqual({ id: enrolled.id, ...first, backends: [
      { backend: 'yubikey-piv', locations: [{ serial: '11111111' }, { serial: '22222222' }] },
      { backend: 'future', locations: [{ key: 'third' }] },
    ] });
    expect((await registry.read()).sources[enrolled.id]).toEqual({
      ...first,
      backends: [
        { backend: 'yubikey-piv', locations: [{ serial: '11111111' }, { serial: '22222222' }] },
        { backend: 'future', locations: [{ key: 'third' }] },
      ],
    });
  });

  it('updates an existing target label only when enrollment supplies one', async () => {
    const registry = createIdentitySourceRegistry();
    const existing = source('original', 1);
    existing.backends = [{ backend: 'future', locations: [{ key: 'one' }] }];
    const added = await registry.enroll(existing);
    const unnamed = source('unused', 1);
    unnamed.backends = [{ backend: 'future', locations: [{ key: 'two' }] }];
    delete unnamed.label;
    expect((await registry.enroll(unnamed)).label).toBe('original');

    const relabeled = source('@agent', 1);
    relabeled.backends = [{ backend: 'future', locations: [{ key: 'three' }] }];
    const result = await registry.enroll(relabeled);
    expect(result).toMatchObject({ id: added.id, label: '@agent' });
    expect(result.backends[0]?.locations).toEqual([{ key: 'one' }, { key: 'two' }, { key: 'three' }]);
  });

  it('atomically transfers a sole location from an old root and clears its default', async () => {
    const registry = createIdentitySourceRegistry();
    const old = source('old', 1);
    old.backends = [{ backend: 'yubikey-piv', locations: [{ serial: '11111111' }] }];
    const oldAdded = await registry.enroll(old);
    await registry.setDefault(oldAdded.id);
    const replacement = source('new', 2);
    replacement.backends = [{ backend: 'yubikey-piv', locations: [{ serial: '11111111' }] }];

    const enrolled = await registry.enroll(replacement, { replaceLocations: true });
    const document = await registry.read();

    expect(document.sources[oldAdded.id]).toBeUndefined();
    expect(document.defaultSourceId).toBeUndefined();
    expect(document.sources[enrolled.id]).toEqual(replacement);
  });

  it('transfers only claimed locations while preserving old-root labels, defaults, and other locations', async () => {
    const registry = createIdentitySourceRegistry();
    const old = source('@old-agent', 1);
    old.backends = [
      { backend: 'yubikey-piv', locations: [{ serial: '11111111' }, { serial: '22222222' }] },
      { backend: 'future', locations: [{ key: 'keep' }] },
    ];
    const oldAdded = await registry.enroll(old);
    await registry.setDefault(oldAdded.id);
    const target = source('target', 2);
    target.backends = [{ backend: 'future', locations: [{ key: 'existing' }] }];
    const targetAdded = await registry.enroll(target);
    const replacement = source('renamed-target', 2);
    replacement.backends = [{ backend: 'yubikey-piv', locations: [{ serial: '11111111' }] }];

    const result = await registry.enroll(replacement, { replaceLocations: true });
    const document = await registry.read();

    expect(result).toMatchObject({ id: targetAdded.id, label: 'renamed-target' });
    expect(result.backends).toEqual([
      { backend: 'future', locations: [{ key: 'existing' }] },
      { backend: 'yubikey-piv', locations: [{ serial: '11111111' }] },
    ]);
    expect(document.sources[oldAdded.id]).toEqual({
      ...old,
      backends: [
        { backend: 'yubikey-piv', locations: [{ serial: '22222222' }] },
        { backend: 'future', locations: [{ key: 'keep' }] },
      ],
    });
    expect(document.defaultSourceId).toBe(oldAdded.id);
  });

  it('rejects adoption transfers and label conflicts without changing catalog bytes', async () => {
    const registry = createIdentitySourceRegistry();
    const old = source('old', 1);
    old.backends = [{ backend: 'yubikey-piv', locations: [{ serial: '11111111' }] }];
    await registry.enroll(old);
    const other = source('other', 2);
    other.backends = [{ backend: 'future', locations: [{ key: 'other' }] }];
    await registry.enroll(other);
    const replacement = source('new', 3);
    replacement.backends = [{ backend: 'yubikey-piv', locations: [{ serial: '11111111' }] }];
    const before = readFileSync(getIdentitySourcesPath(), 'utf8');

    await expect(registry.enroll(replacement)).rejects.toMatchObject({ code: 'DUPLICATE_LOCATOR' });
    expect(readFileSync(getIdentitySourcesPath(), 'utf8')).toBe(before);
    replacement.label = 'other';
    await expect(registry.enroll(replacement, { replaceLocations: true }))
      .rejects.toMatchObject({ code: 'DUPLICATE_LABEL' });
    expect(readFileSync(getIdentitySourcesPath(), 'utf8')).toBe(before);
  });

  it('preserves the existing catalog when the atomic enrollment write fails', async () => {
    const registry = createIdentitySourceRegistry();
    const first = source('first', 1);
    first.backends = [{ backend: 'future', locations: [{ key: 'first' }] }];
    await registry.enroll(first);
    const before = readFileSync(getIdentitySourcesPath(), 'utf8');
    const directory = dirname(getIdentitySourcesPath());
    chmodSync(directory, 0o500);
    const second = source('second', 2);
    second.backends = [{ backend: 'future', locations: [{ key: 'second' }] }];
    try {
      await expect(registry.enroll(second)).rejects.toMatchObject({ code: 'STORAGE_FAILED' });
    } finally {
      chmodSync(directory, 0o700);
    }
    expect(readFileSync(getIdentitySourcesPath(), 'utf8')).toBe(before);
  });

  it('resolves canonical IDs, ordinary labels, and defaults while rejecting absent selectors', async () => {
    const registry = createIdentitySourceRegistry();
    const added = await registry.enroll(source());
    await registry.setDefault(added.id);
    const document = await registry.read();
    expect(resolveIdentitySource(document)).toEqual([added.id, document.sources[added.id]]);
    expect(resolveIdentitySource(document, 'primary')[0]).toBe(added.id);
    expect(resolveIdentitySource(document, 'PRIMARY')[0]).toBe(added.id);
    expect(resolveIdentitySource(document, added.id)[0]).toBe(added.id);
    expect(() => resolveIdentitySource(document, added.id.toUpperCase())).toThrow('SOURCE_NOT_FOUND');
    expect(() => resolveIdentitySource(document, 'two words')).toThrow('SOURCE_NOT_FOUND');
    expect(() => resolveIdentitySource({ version: 1, sources: {} })).toThrow('NO_DEFAULT_SOURCE');
    expect(() => resolveIdentitySource(document, 'missing')).toThrow('SOURCE_NOT_FOUND');

    const firstId = 'ir:abcdefghijklmno';
    const otherId = 'ir:bcdefghijklmnoa';
    const disjoint = {
      version: 1,
      sources: { [firstId]: document.sources[added.id]!, [otherId]: { ...document.sources[added.id]!, label: 'abcdefghijklmno' } },
    } satisfies IdentitySourceRegistryDocument;
    expect(resolveIdentitySource(disjoint, firstId)[0]).toBe(firstId);
    expect(resolveIdentitySource(disjoint, 'abcdefghijklmno')[0]).toBe(otherId);
  });

  it('rejects invalid derivation inputs and accepts nested finite JSON locations', async () => {
    expect(deriveIdentitySourceId(source('vector', 1).rootPublicKey, 1)).toBe('ir:y27dru5wlwjzay6');
    expect(IDENTITY_SOURCE_ID_PATTERN).toEqual(/^ir:[a-z2-7]{15}$/);
    expect(() => deriveIdentitySourceId('not-hex', 1)).toThrow('INVALID_SOURCE');
    expect(() => deriveIdentitySourceId(source().rootPublicKey, 2 as never)).toThrow('INVALID_SOURCE');
    expect(() => deriveIdentitySourceId(`04${'00'.repeat(64)}`, 1)).toThrow('INVALID_SOURCE');
    const registry = createIdentitySourceRegistry();
    const record = source();
    record.backends = [{ backend: 'future', locations: [{
      nil: null, text: 'value', enabled: true, count: 2, nested: [{ b: 2, a: 1 }],
    }] }];
    const added = await registry.enroll(record);
    expect((await registry.read()).sources[added.id]?.backends).toEqual(record.backends);
    await registry.enroll({
      ...record,
      backends: [{ backend: 'second-backend', locations: [{ serial: 'new', nested: [] }] }],
    });
    await registry.reorderBackends(added.id, ['second-backend', 'future']);
    expect((await registry.read()).sources[added.id]?.backends).toEqual([
      { backend: 'second-backend', locations: [{ serial: 'new', nested: [] }] },
      record.backends[0],
    ]);
  });

  it('supports unnamed multi-backend sources', async () => {
    const registry = createIdentitySourceRegistry();
    const unnamed = source();
    delete unnamed.label;
    unnamed.backends.push({ backend: 'future', locations: [{ serial: 'future' }] });
    const added = await registry.enroll(unnamed);
    await registry.enroll({
      ...unnamed,
      backends: [{ backend: 'yubikey-piv', locations: [{ serial: '11223344' }] }],
    });
    expect((await registry.read()).sources[added.id]?.backends).toHaveLength(2);
  });

  it('persists and projects the prepared identity-source label with canonical casing', async () => {
    const registry = createIdentitySourceRegistry();
    const unnamed = source('unused', 1);
    delete unnamed.label;
    const added = await registry.enroll(unnamed);
    const unrelatedRecord = source('Unrelated', 2);
    unrelatedRecord.backends = [{ backend: 'future', locations: [{ key: 'unrelated' }] }];
    const unrelated = await registry.enroll(unrelatedRecord);
    await registry.setLabel(added.id, { label: 'SourceCase', mode: 'soft' });

    const labeled = await registry.read();
    expect(labeled.sources[added.id]?.label).toBe('@SourceCase');
    expect(labeled.sources[unrelated.id]?.label).toBe('Unrelated');
    expect(resolveIdentitySource(labeled, 'sourcecase')[0]).toBe(added.id);
  });

  it('replaces a soft identity-source label through the agent-facing owner method', async () => {
    const registry = createIdentitySourceRegistry();
    const added = await registry.enroll(source('@AgentCase', 1));

    await registry.setSoftLabel(added.id, 'NextCase');

    expect((await registry.read()).sources[added.id]?.label).toBe('@NextCase');
    expect(resolveIdentitySource(await registry.read(), 'nextcase')[0]).toBe(added.id);
  });

  it('removes a soft identity-source label without removing its custody record', async () => {
    const registry = createIdentitySourceRegistry();
    const added = await registry.enroll(source('@AgentCase', 1));

    await registry.setSoftLabel(added.id);

    const document = await registry.read();
    expect(document.sources[added.id]?.label).toBeUndefined();
    expect(document.sources[added.id]?.backends).toHaveLength(1);
  });

  it('keeps operator label removal idempotent for an unlabeled source', async () => {
    const registry = createIdentitySourceRegistry();
    const record = source('unused', 1);
    delete record.label;
    const added = await registry.enroll(record);
    const before = readFileSync(getIdentitySourcesPath(), 'utf8');

    await registry.removeLabel(added.id);

    expect((await registry.read()).sources[added.id]?.label).toBeUndefined();
    expect(readFileSync(getIdentitySourcesPath(), 'utf8')).toBe(before);
  });

  it('forgets matching locations, prunes empty roots, and rejects unregistered custody', async () => {
    const registry = createIdentitySourceRegistry();
    const added = await registry.enroll(source());
    await expect(registry.setDefault('missing')).rejects.toMatchObject({ code: 'SOURCE_NOT_FOUND' });
    await registry.setDefault(added.id);
    await registry.setLabel(added.id, { label: 'renamed', mode: 'hard' });
    await expect(registry.forgetLocation('renamed', { backend: 'yubikey-piv', location: { serial: '12345678' } })).resolves.toMatchObject({
      id: added.id, label: 'renamed', backends: [{ backend: 'yubikey-piv', locations: [{ serial: '87654321' }] }],
    });
    const document = await registry.read();
    expect(document.defaultSourceId).toBe(added.id);
    expect(document.sources[added.id]).toMatchObject({
      label: 'renamed', backends: [{ backend: 'yubikey-piv', locations: [{ serial: '87654321' }] }],
    });
    const before = readFileSync(getIdentitySourcesPath(), 'utf8');
    const invalidTarget = { backend: 'missing', location: { serial: '87654321' } } as unknown as
      Exclude<Parameters<typeof registry.forgetLocation>[1], 'all'>;
    await expect(registry.forgetLocation(added.id, invalidTarget))
      .rejects.toMatchObject({ code: 'INVALID_SOURCE' });
    await expect(registry.forgetLocation(added.id, { backend: 'yubikey-piv', location: { serial: 'unregistered' } }))
      .rejects.toMatchObject({ code: 'INVALID_SOURCE' });
    await expect(registry.forgetLocation('missing', { backend: 'yubikey-piv', location: { serial: '87654321' } }))
      .rejects.toMatchObject({ code: 'SOURCE_NOT_FOUND' });
    expect(readFileSync(getIdentitySourcesPath(), 'utf8')).toBe(before);

    await expect(registry.forgetLocation(added.id, { backend: 'yubikey-piv', location: { serial: '87654321' } }))
      .resolves.toEqual({ id: added.id });
    expect(await registry.read()).toEqual({ version: 1, sources: {} });
  });

  it('merges duplicate canonical locations idempotently', async () => {
    const registry = createIdentitySourceRegistry();
    const firstRecord = source();
    const first = await registry.enroll(firstRecord);
    const before = readFileSync(getIdentitySourcesPath(), 'utf8');
    await expect(registry.enroll({
      ...firstRecord,
      backends: [{ backend: 'yubikey-piv', locations: [{ serial: '12345678' }] }],
    })).resolves.toMatchObject({ id: first.id });
    expect(readFileSync(getIdentitySourcesPath(), 'utf8')).toBe(before);

  });

  it('keeps canonical source IDs disjoint from bare labels and rejects colon labels', async () => {
    const registry = createIdentitySourceRegistry();
    const first = await registry.enroll(source('primary', 1));
    const firstPayload = first.id.slice(3);
    const secondRecord = source(firstPayload, 2);
    secondRecord.backends = [{ backend: 'future', locations: [{ serial: 'other' }] }];
    const second = await registry.enroll(secondRecord);
    const document = await registry.read();
    expect(resolveIdentitySource(document, first.id)[0]).toBe(first.id);
    expect(resolveIdentitySource(document, firstPayload)[0]).toBe(second.id);
    expect(() => assertIdentitySourceLabelAvailable(document, first.id))
      .toThrow(expect.objectContaining({ code: 'INVALID_LABEL' }));
    expect(() => assertIdentitySourceLabelAvailable(document, 'two words'))
      .toThrow(expect.objectContaining({ code: 'INVALID_LABEL' }));
  });

  it('rejects unknown version-1 top-level keys without rewriting the catalog', async () => {
    const record = source();
    const id = deriveIdentitySourceId(record.rootPublicKey, 1);
    const document = { version: 1, sources: { [id]: record }, extra: true };
    mkdirSync(dirname(getIdentitySourcesPath()), { recursive: true, mode: 0o700 });
    const original = `${JSON.stringify(document)}\n`;
    writeFileSync(getIdentitySourcesPath(), original, { mode: 0o600 });
    await expect(createIdentitySourceRegistry().read()).rejects.toMatchObject({ code: 'STORAGE_FAILED' });
    expect(readFileSync(getIdentitySourcesPath(), 'utf8')).toBe(original);
  });

  it.each([
    ['bare source ID', (document: IdentitySourceRegistryDocument) => ({ ...document, sources: { '2abcdefghijklmn': Object.values(document.sources)[0]! } })],
    ['missing default', (document: IdentitySourceRegistryDocument) => ({ ...document, defaultSourceId: 'ir:abcdefghijklmno' })],
    ['duplicate labels', (document: IdentitySourceRegistryDocument) => {
      const other = source('primary', 2);
      other.backends = [{ backend: 'future', locations: [{ serial: 'other' }] }];
      return { ...document, sources: {
        ...document.sources,
        [deriveIdentitySourceId(other.rootPublicKey, 1)]: other,
      } };
    }],
    ['duplicate locations', (document: IdentitySourceRegistryDocument) => {
      const other = source('other', 2);
      return { ...document, sources: {
        ...document.sources,
        [deriveIdentitySourceId(other.rootPublicKey, 1)]: other,
      } };
    }],
  ])('rejects persisted catalogs with %s', async (_case, mutate) => {
    const record = source('primary', 1);
    const document: IdentitySourceRegistryDocument = {
      version: 1, sources: { [deriveIdentitySourceId(record.rootPublicKey, 1)]: record },
    };
    const invalid = mutate(document);
    mkdirSync(dirname(getIdentitySourcesPath()), { recursive: true, mode: 0o700 });
    const bytes = `${JSON.stringify(invalid)}\n`;
    writeFileSync(getIdentitySourcesPath(), bytes, { mode: 0o600 });
    await expect(createIdentitySourceRegistry().read()).rejects.toMatchObject({ code: 'STORAGE_FAILED' });
    expect(readFileSync(getIdentitySourcesPath(), 'utf8')).toBe(bytes);
  });

  it('rejects duplicate locations inside one source record', async () => {
    const record = source();
    record.backends[0]!.locations.push({ serial: '12345678' });
    await expect(createIdentitySourceRegistry().enroll(record)).rejects.toMatchObject({ code: 'INVALID_SOURCE' });
  });

  it.each([
    ['wrong root fingerprint', (record: IdentitySourceRecord) => ({ ...record, rootPublicKeyFingerprint: '00' })],
    ['invalid root public key', (record: IdentitySourceRecord) => ({ ...record, rootPublicKey: `04${'00'.repeat(64)}` })],
    ['empty backends', (record: IdentitySourceRecord) => ({ ...record, backends: [] })],
    ['duplicate backends', (record: IdentitySourceRecord) => ({
      ...record, backends: [record.backends[0]!, record.backends[0]!],
    })],
    ['malformed backend location', (record: IdentitySourceRecord) => ({
      ...record, backends: [{ backend: 'future', locations: [null as unknown as Record<string, unknown>] }],
    })],
    ['malformed YubiKey locator', (record: IdentitySourceRecord) => ({
      ...record, backends: [{ backend: 'yubikey-piv', locations: [{ serial: 'not-a-serial' }] }],
    })],
  ])('rejects semantically invalid typed enrollment with %s without changing catalog bytes', async (_case, invalidate) => {
    const registry = createIdentitySourceRegistry();
    await registry.enroll(source('existing', 1));
    const before = readFileSync(getIdentitySourcesPath(), 'utf8');
    const candidate = source('invalid', 2);
    candidate.backends = [{ backend: 'yubikey-piv', locations: [{ serial: '22222222' }] }];

    await expect(registry.enroll(invalidate(candidate)))
      .rejects.toMatchObject({ code: 'INVALID_SOURCE' });
    expect(readFileSync(getIdentitySourcesPath(), 'utf8')).toBe(before);
  });

  it('classifies an invalid label without creating state', async () => {
    const failure = await createIdentitySourceRegistry().enroll({ ...source(), label: 'two words' })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(IdentitySourceError);
    expect(failure).toMatchObject({ code: 'INVALID_LABEL' });
    expect(() => readFileSync(getIdentitySourcesPath())).toThrow();
  });

  it('classifies invalid operator labels as input errors rather than storage failures', async () => {
    const registry = createIdentitySourceRegistry();
    const added = await registry.enroll(source());
    const before = readFileSync(getIdentitySourcesPath(), 'utf8');
    const failure = await registry.setLabel(added.id, { label: 'two words', mode: 'soft' })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(IdentitySourceError);
    expect(failure).toMatchObject({ code: 'INVALID_LABEL' });
    expect(readFileSync(getIdentitySourcesPath(), 'utf8')).toBe(before);
  });

  it('rejects agent replacement of a hard source label without changing the registry', async () => {
    const registry = createIdentitySourceRegistry();
    const added = await registry.enroll(source());
    const before = readFileSync(getIdentitySourcesPath(), 'utf8');

    await expect(registry.setSoftLabel(added.id, 'agent')).rejects.toMatchObject({ code: 'LABEL_PROTECTED' });
    expect(readFileSync(getIdentitySourcesPath(), 'utf8')).toBe(before);
  });

  it('rejects a default-source mutation without overwriting a corrupted registry', async () => {
    const registry = createIdentitySourceRegistry();
    const added = await registry.enroll(source());
    writeFileSync(getIdentitySourcesPath(), '{invalid');
    await expect(registry.setDefault(added.id)).rejects.toMatchObject({ code: 'STORAGE_FAILED' });
    expect(readFileSync(getIdentitySourcesPath(), 'utf8')).toBe('{invalid');
  });

  it('does not lose independent catalog mutations issued in the same process', async () => {
    const registry = createIdentitySourceRegistry();
    const second = source('second', 2);
    second.backends = [{ backend: 'future', locations: [{ serial: 'other' }] }];
    const added = await Promise.all([registry.enroll(source('first', 1)), registry.enroll(second)]);
    expect(Object.keys((await registry.read()).sources).sort()).toEqual(added.map(record => record.id).sort());
  });

  it('reorders only existing root custody without changing material identity', async () => {
    const registry = createIdentitySourceRegistry();
    const record = source();
    record.backends.push({ backend: 'future', locations: [{ key: 'a' }, { key: 'b' }] });
    const added = await registry.enroll(record);
    await registry.reorderBackends(added.id, ['future', 'yubikey-piv']);
    await registry.reorderLocations(added.id, 'future', [{ key: 'b' }, { key: 'a' }]);
    const updated = (await registry.read()).sources[added.id]!;
    expect(updated.rootPublicKey).toBe(record.rootPublicKey);
    expect(updated.backends).toEqual([{ backend: 'future', locations: [{ key: 'b' }, { key: 'a' }] }, record.backends[0]]);
    const before = readFileSync(getIdentitySourcesPath(), 'utf8');
    for (const backends of [['future'], ['future', 'future'], ['future', 'unknown']]) {
      await expect(registry.reorderBackends(added.id, backends)).rejects.toMatchObject({ code: 'INVALID_SOURCE' });
    }
    for (const locations of [[{ key: 'a' }], [{ key: 'a' }, { key: 'a' }], [{ key: 'a' }, { key: 'unknown' }]]) {
      await expect(registry.reorderLocations(added.id, 'future', locations)).rejects.toMatchObject({ code: 'INVALID_SOURCE' });
    }
    await expect(registry.reorderLocations(added.id, 'missing', [])).rejects.toMatchObject({ code: 'INVALID_SOURCE' });
    expect(readFileSync(getIdentitySourcesPath(), 'utf8')).toBe(before);
  });

  it.each([true, false])('forgets only selected source (is default: %s) without deleting identity data', async isDefault => {
    const registry = createIdentitySourceRegistry();
    const first = await registry.enroll(source('first', 1));
    const other = source('other', 2);
    other.backends = [{ backend: 'future', locations: [{ key: 'other' }] }];
    const second = await registry.enroll(other);
    await registry.setDefault(isDefault ? first.id : second.id);
    const identityFile = join(dirname(getIdentitySourcesPath()), 'test-network', 'identity.json');
    mkdirSync(dirname(identityFile), { mode: 0o700 });
    writeFileSync(identityFile, 'identity object, not catalog metadata', { mode: 0o600 });
    await expect(registry.forgetLocation(first.id, 'all')).resolves.toEqual({ id: first.id });
    const remaining = await registry.read();
    expect(remaining.defaultSourceId).toBe(isDefault ? undefined : second.id);
    expect(readFileSync(identityFile, 'utf8')).toBe('identity object, not catalog metadata');
    expect(Object.keys(remaining.sources)).toEqual([second.id]);
    const before = readFileSync(getIdentitySourcesPath(), 'utf8');
    await expect(registry.forgetLocation(first.id, 'all')).rejects.toMatchObject({ code: 'SOURCE_NOT_FOUND' });
    expect(readFileSync(getIdentitySourcesPath(), 'utf8')).toBe(before);
  });
});
