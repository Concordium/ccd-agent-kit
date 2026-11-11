import { getIdentityContextSnapshot,setIdentityContextSnapshot } from '@ccd-agent-kit/config-utils';
import { access,chmod,lstat,mkdir,readFile,stat,symlink,writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe,expect,it } from 'vitest';
import { IdentityProviderError } from '../../src/core/providers/error.js';
import { createIdentityProviderRegistry } from '../../src/core/providers/registry.js';
import type { IdentityProviderRegistry } from '../../src/core/providers/types.js';
import { GENESIS,NETWORK,contextSnapshot,inventory,settings,useProviderScratch } from '../providerHelpers.js';

const scratch = useProviderScratch('provider-registry-');
const REF = GENESIS.slice(0, 32);

describe('identity-provider settings and shared context registry', () => {
  it('reads missing state as empty without creating protected directories', async () => {
    await expect(createIdentityProviderRegistry().read(NETWORK)).resolves.toEqual({
      settings: { version: 1, genesisHash: GENESIS, providers: {} },
    });
    await expect(access(scratch.configDirectory())).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(scratch.dataDirectory())).rejects.toMatchObject({ code: 'ENOENT' });
    expect(getIdentityContextSnapshot(REF)).toBeUndefined();
  });

  it('derives safe inventory from the shared full snapshot while retaining protected settings', async () => {
    setIdentityContextSnapshot(REF, contextSnapshot());
    const contextBefore = await readFile(scratch.contextFile(), 'utf8');
    const registry = createIdentityProviderRegistry();
    await registry.updateSettings(NETWORK, () => settings());

    await expect(registry.read(NETWORK)).resolves.toEqual({ settings: settings(), inventory: inventory() });
    expect(await stat(scratch.contextFile())).toMatchObject({ mode: expect.any(Number) });
    expect(await readFile(scratch.contextFile(), 'utf8')).toBe(contextBefore);
    await expect(access(scratch.inventoryFile())).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('leaves an old identity-manager inventory byte-for-byte untouched and never uses it as fallback', async () => {
    await mkdir(scratch.dataDirectory(), { recursive: true, mode: 0o700 });
    const legacy = '{"version":1,"private":"legacy bytes"}\n';
    await writeFile(scratch.inventoryFile(), legacy, { mode: 0o600 });
    const registry = createIdentityProviderRegistry();

    await expect(registry.read(NETWORK)).resolves.toEqual({
      settings: { version: 1, genesisHash: GENESIS, providers: {} },
    });
    await registry.updateSettings(NETWORK, () => settings());
    expect(await readFile(scratch.inventoryFile(), 'utf8')).toBe(legacy);
  });

  it('projects observedAt, provider descriptions, and AR indexes without cryptographic keys', async () => {
    const snapshot = contextSnapshot({ observedAt: '2027-01-02T03:04:05.000Z' });
    setIdentityContextSnapshot(REF, snapshot);
    const result = await createIdentityProviderRegistry().read(NETWORK);

    expect(result.inventory).toEqual(inventory({ refreshedAt: snapshot.observedAt }));
    expect(JSON.stringify(result.inventory)).not.toMatch(/ipVerifyKey|ipCdiVerifyKey|arPublicKey|globalContext/);
  });

  it('ignores a shared snapshot for a different full genesis and does not fall back to legacy inventory', async () => {
    await mkdir(path.dirname(scratch.contextFile()), { recursive: true });
    await writeFile(scratch.contextFile(), JSON.stringify({
      ...contextSnapshot(), network: { caip2: NETWORK.caip2, genesisHash: `${GENESIS.slice(0, 32)}${'34'.repeat(16)}` },
    }));
    await mkdir(scratch.dataDirectory(), { recursive: true, mode: 0o700 });
    await writeFile(scratch.inventoryFile(), JSON.stringify(inventory()), { mode: 0o600 });

    await expect(createIdentityProviderRegistry().read(NETWORK)).resolves.toEqual({
      settings: { version: 1, genesisHash: GENESIS, providers: {} },
    });
  });

  it('reloads shared context and settings under the settings mutation lock', async () => {
    setIdentityContextSnapshot(REF, contextSnapshot());
    const registry = createIdentityProviderRegistry();
    const result = await registry.updateSettings(
      NETWORK,
      (current: Awaited<ReturnType<IdentityProviderRegistry['read']>>) => {
        expect(current.inventory).toEqual(inventory());
        return settings();
      },
    );
    expect(result).toEqual({ inventory: inventory(), settings: settings() });
    expect(JSON.parse(await readFile(scratch.settingsFile(), 'utf8'))).toEqual(settings());
    expect((await stat(scratch.settingsFile())).mode & 0o777).toBe(0o600);
    await expect(access(scratch.lockFile())).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('returns defensive clones for shared inventory and protected settings', async () => {
    setIdentityContextSnapshot(REF, contextSnapshot());
    const registry = createIdentityProviderRegistry();
    await registry.updateSettings(NETWORK, () => settings());
    const first = await registry.read(NETWORK);
    first.inventory!.providers[0]!.name = 'mutated';
    first.inventory!.anonymityRevokers.push(99);
    first.settings.providers['0']!.anonymityRevokers!.reverse();
    first.settings.providers['9'] = { enabled: false };
    await expect(registry.read(NETWORK)).resolves.toEqual({ inventory: inventory(), settings: settings() });
  });

  it('preserves valid AR policy and default settings across unrelated updates', async () => {
    const registry = createIdentityProviderRegistry();
    await registry.updateSettings(NETWORK, () => settings({ providers: {
      ...settings().providers,
      '0': { ...settings().providers['0']!, anonymityRevokers: [1], anonymityRevokerThreshold: 1 } as never,
    } }));
    await registry.updateSettings(NETWORK, snapshot => ({
      ...snapshot.settings,
      providers: {
        ...snapshot.settings.providers,
        '0': { ...snapshot.settings.providers['0']!, label: 'renamed' },
      },
    }));
    const persisted = JSON.parse(await readFile(scratch.settingsFile(), 'utf8')) as Record<string, unknown>;
    expect((persisted.providers as Record<string, { anonymityRevokers: number[] }>)['0']!.anonymityRevokers)
      .toEqual([1]);
    expect((persisted.providers as Record<string, { anonymityRevokerThreshold: number }>)['0']!.anonymityRevokerThreshold)
      .toBe(1);
    expect(persisted.defaultIdentityProvider).toBe(0);
  });

  it('accepts and preserves the optional network-wide identity request timeout', async () => {
    const registry = createIdentityProviderRegistry();
    const configured = settings({ identityRequestTimeoutSeconds: 43_200 });
    await registry.updateSettings(NETWORK, () => configured);
    await registry.updateSettings(NETWORK, snapshot => ({
      ...snapshot.settings,
      providers: {
        ...snapshot.settings.providers,
        '2': { ...snapshot.settings.providers['2']!, label: 'secondary' },
      },
    }));

    await expect(registry.read(NETWORK)).resolves.toEqual({
      settings: settings({
        identityRequestTimeoutSeconds: 43_200,
        providers: {
          ...settings().providers,
          '2': { ...settings().providers['2']!, label: 'secondary' },
        },
      }),
    });
  });

  it('accepts a stored threshold without a stored AR list', async () => {
    const configured = settings({ providers: {
      ...settings().providers,
      '2': { enabled: false, anonymityRevokerThreshold: 255 } as never,
    } });
    const registry = createIdentityProviderRegistry();
    await registry.updateSettings(NETWORK, () => configured);
    await expect(registry.read(NETWORK)).resolves.toEqual({ settings: configured });
  });

  it('never steals a pre-existing settings lock or changes trusted state', async () => {
    const registry = createIdentityProviderRegistry();
    await registry.updateSettings(NETWORK, () => settings());
    await writeFile(scratch.lockFile(), 'another owner', { flag: 'wx', mode: 0o600 });
    const before = await readFile(scratch.settingsFile(), 'utf8');
    await expect(registry.updateSettings(NETWORK, current => current.settings))
      .rejects.toMatchObject({ code: 'STORAGE_FAILED' });
    expect(await readFile(scratch.lockFile(), 'utf8')).toBe('another owner');
    expect(await readFile(scratch.settingsFile(), 'utf8')).toBe(before);
  });

  it.each([
    ['primitive settings', '7'],
    ['malformed JSON', '{'],
    ['unknown field', JSON.stringify({ ...settings(), extra: true })],
    ['unsupported version', JSON.stringify({ ...settings(), version: 2 })],
    ['genesis mismatch', JSON.stringify({ ...settings(), genesisHash: '34'.repeat(32) })],
    ['duplicate labels', JSON.stringify(settings({ providers: {
      '0': { label: '@Same', enabled: false }, '2': { label: 'same', enabled: false },
    } }))],
    ['enabled partial provider', JSON.stringify(settings({ providers: { '0': { enabled: true } } }))],
    ['primitive provider', JSON.stringify(settings({ providers: { '0': 7 as never } }))],
    ['unknown provider field', JSON.stringify(settings({ providers: {
      '0': { enabled: false, extra: true } as never,
    } }))],
    ['numeric endpoint', JSON.stringify(settings({ providers: {
      '0': { enabled: false, issuanceUrl: 7 } as never,
    } }))],
    ['unsafe endpoint', JSON.stringify(settings({ providers: {
      '0': { enabled: false, issuanceUrl: 'file:///identity' },
    } }))],
    ['duplicate historical AR indexes', JSON.stringify(settings({ providers: {
      '0': { enabled: false, anonymityRevokers: [1, 1] },
    } }))],
    ['empty AR indexes', JSON.stringify(settings({ providers: {
      '0': { enabled: false, anonymityRevokers: [] },
    } }))],
    ['zero AR index', JSON.stringify(settings({ providers: {
      '0': { enabled: false, anonymityRevokers: [0] },
    } }))],
    ['single AR without explicit threshold', JSON.stringify(settings({ providers: {
      '0': { enabled: false, anonymityRevokers: [1] },
    } }))],
    ['AR threshold above stored list count', JSON.stringify(settings({ providers: {
      '0': { enabled: false, anonymityRevokers: [1, 2], anonymityRevokerThreshold: 3 } as never,
    } }))],
    ['invalid AR threshold', JSON.stringify(settings({ providers: {
      '0': { enabled: false, anonymityRevokerThreshold: 0 } as never,
    } }))],
    ['null AR threshold', JSON.stringify(settings({ providers: {
      '0': { enabled: false, anonymityRevokerThreshold: null } as never,
    } }))],
    ['noncanonical provider key', JSON.stringify(settings({ providers: { '01': { enabled: false } } }))],
    ['unknown root field without a default', JSON.stringify({
      version: 1, genesisHash: GENESIS, providers: { '0': { enabled: false } }, unexpected: true,
    })],
    ['zero identity request timeout', JSON.stringify(settings({ identityRequestTimeoutSeconds: 0 }))],
    ['fractional identity request timeout', JSON.stringify(settings({ identityRequestTimeoutSeconds: 1.5 }))],
    ['unsafe identity request timeout', JSON.stringify(settings({
      identityRequestTimeoutSeconds: Number.MAX_SAFE_INTEGER + 1,
    }))],
  ])('fails closed on invalid settings without replacing them: %s', async (_label, contents) => {
    await mkdir(scratch.configDirectory(), { recursive: true, mode: 0o700 });
    await writeFile(scratch.settingsFile(), contents, { mode: 0o600 });
    const registry = createIdentityProviderRegistry();
    await expect(registry.read(NETWORK)).rejects.toBeInstanceOf(IdentityProviderError);
    await expect(registry.updateSettings(NETWORK, () => settings())).rejects.toMatchObject({ code: 'STORAGE_FAILED' });
    expect(await readFile(scratch.settingsFile(), 'utf8')).toBe(contents);
  });

  it('accepts and preserves settings that omit the inert historical default', async () => {
    const withoutDefault = { version: 1 as const, genesisHash: GENESIS, providers: { '0': { enabled: false } } };
    await mkdir(scratch.configDirectory(), { recursive: true, mode: 0o700 });
    await writeFile(scratch.settingsFile(), JSON.stringify(withoutDefault), { mode: 0o600 });
    await expect(createIdentityProviderRegistry().read(NETWORK)).resolves.toEqual({ settings: withoutDefault });
  });

  it.each(['config directory', 'settings file'] as const)('rejects a symlinked protected %s', async (kind) => {
    const outside = path.join(scratch.root(), 'outside');
    await mkdir(outside, { recursive: true });
    if (kind === 'config directory') {
      await mkdir(path.dirname(scratch.configDirectory()), { recursive: true });
      await symlink(outside, scratch.configDirectory());
    } else {
      await mkdir(scratch.configDirectory(), { recursive: true, mode: 0o700 });
      await writeFile(path.join(outside, 'idps.json'), JSON.stringify(settings()));
      await symlink(path.join(outside, 'idps.json'), scratch.settingsFile());
    }
    await expect(createIdentityProviderRegistry().read(NETWORK)).rejects.toMatchObject({ code: 'STORAGE_FAILED' });
    expect((await lstat(kind === 'config directory' ? scratch.configDirectory() : scratch.settingsFile())).isSymbolicLink())
      .toBe(true);
  });

  it('rejects group-accessible protected settings but does not inspect the obsolete data file', async () => {
    const registry = createIdentityProviderRegistry();
    await registry.updateSettings(NETWORK, () => settings());
    await chmod(scratch.settingsFile(), 0o640);
    await expect(registry.read(NETWORK)).rejects.toMatchObject({ code: 'STORAGE_FAILED' });

    await chmod(scratch.settingsFile(), 0o600);
    await mkdir(scratch.dataDirectory(), { recursive: true, mode: 0o700 });
    await writeFile(scratch.inventoryFile(), 'legacy', { mode: 0o666 });
    await expect(registry.read(NETWORK)).resolves.toMatchObject({ settings: settings() });
  });

  it.each([
    ['primitive network', null],
    ['extra network field', { ...NETWORK, extra: true }],
    ['noncanonical genesis', { caip2: `ccd:${'ab'.repeat(16)}`, genesisHash: 'ab'.repeat(32).toUpperCase() }],
    ['mismatched CAIP reference', { ...NETWORK, caip2: `ccd:${'34'.repeat(16)}` }],
  ])('rejects %s before touching protected state', async (_name, network) => {
    await expect(createIdentityProviderRegistry().read(network as never)).rejects.toMatchObject({ code: 'INVALID_NETWORK' });
    await expect(access(scratch.configDirectory())).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preserves a known callback error and always removes its owned lock', async () => {
    const registry = createIdentityProviderRegistry();
    const failure = new IdentityProviderError('INVALID_LABEL');
    await expect(registry.updateSettings(NETWORK, () => { throw failure; })).rejects.toBe(failure);
    await expect(access(scratch.lockFile())).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('sanitizes unexpected network-object and directory traversal failures', async () => {
    const hostile = new Proxy({}, { ownKeys() { throw new Error('/private/network-object'); } });
    await expect(createIdentityProviderRegistry().read(hostile as never))
      .rejects.toMatchObject({ code: 'STORAGE_FAILED' });

    await mkdir(path.dirname(process.env.XDG_CONFIG_HOME!), { recursive: true });
    await writeFile(process.env.XDG_CONFIG_HOME!, 'not a directory');
    await expect(createIdentityProviderRegistry().read(NETWORK))
      .rejects.toMatchObject({ code: 'STORAGE_FAILED' });
  });
});
