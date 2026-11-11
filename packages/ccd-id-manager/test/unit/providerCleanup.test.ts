import { access,readFile,readdir,rm } from 'node:fs/promises';
import path from 'node:path';
import { afterEach,describe,expect,it,vi } from 'vitest';
import { createIdentityProviderRegistry } from '../../src/core/providers/registry.js';
import { GENESIS,NETWORK,settings } from '../providerHelpers.js';
import { useTestXdg } from '../xdgTestHelpers.js';

const faults = vi.hoisted(() => ({
  closeAfter: undefined as RegExp | undefined,
  writeBefore: undefined as RegExp | undefined,
  removeBefore: undefined as RegExp | undefined,
}));

function take(name: keyof typeof faults, filename: string): boolean {
  const pattern = faults[name];
  if (!pattern?.test(filename)) return false;
  faults[name] = undefined;
  return true;
}

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    async open(...args: Parameters<typeof actual.open>) {
      const handle = await actual.open(...args);
      const filename = String(args[0]);
      return new Proxy(handle, {
        get(target, property) {
          if (property === 'close') {
            return async () => {
              await target.close();
              if (take('closeAfter', filename)) throw new Error(`injected close failure: ${filename}`);
            };
          }
          if (property === 'writeFile') {
            return async (...writeArgs: Parameters<typeof target.writeFile>) => {
              if (take('writeBefore', filename)) throw new Error(`injected write failure: ${filename}`);
              return target.writeFile(...writeArgs);
            };
          }
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    },
    async rm(target: Parameters<typeof actual.rm>[0], options?: Parameters<typeof actual.rm>[1]) {
      const filename = String(target);
      if (take('removeBefore', filename)) throw new Error(`injected remove failure: ${filename}`);
      return actual.rm(target, options);
    },
  };
});

useTestXdg('provider-cleanup-', ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME']);

const reference = GENESIS.slice(0, 32);
const configDirectory = () => path.join(process.env.XDG_CONFIG_HOME!, 'ccd-agent-kit', 'id-manager', reference);
const settingsFile = () => path.join(configDirectory(), 'idps.json');
const lockFile = () => path.join(configDirectory(), '.idps.mutation.lock');
const temporarySettings = () => new RegExp(`${path.sep.replaceAll('\\', '\\\\')}\\.idps\\.json\\..+\\.tmp$`);

afterEach(async () => {
  faults.closeAfter = undefined;
  faults.writeBefore = undefined;
  faults.removeBefore = undefined;
});

describe('provider registry I/O cleanup failures', () => {
  it('returns parsed state after the read handle is closed even when close reports an error', async () => {
    const registry = createIdentityProviderRegistry();
    await registry.updateSettings(NETWORK, () => settings());
    faults.closeAfter = /idps\.json$/;

    await expect(registry.read(NETWORK)).resolves.toEqual({ settings: settings() });
    expect(faults.closeAfter).toBeUndefined();
  });

  it('preserves the primary write failure and prior settings when temporary-handle close also fails', async () => {
    const registry = createIdentityProviderRegistry();
    await registry.updateSettings(NETWORK, () => settings());
    const before = await readFile(settingsFile(), 'utf8');
    faults.writeBefore = temporarySettings();
    faults.closeAfter = temporarySettings();

    const failure = await registry.updateSettings(NETWORK, current => ({
      ...current.settings,
      providers: { ...current.settings.providers, '2': { label: 'secondary', enabled: false } },
    })).catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: 'STORAGE_FAILED' });
    expect(String(failure)).not.toContain('injected');
    expect(await readFile(settingsFile(), 'utf8')).toBe(before);
    expect(faults.writeBefore).toBeUndefined();
    expect(faults.closeAfter).toBeUndefined();
    await expect(access(lockFile())).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preserves prior settings when failed temporary cleanup leaves a file for explicit owner cleanup', async () => {
    const registry = createIdentityProviderRegistry();
    await registry.updateSettings(NETWORK, () => settings());
    const before = await readFile(settingsFile(), 'utf8');
    faults.writeBefore = temporarySettings();
    faults.removeBefore = temporarySettings();

    await expect(registry.updateSettings(NETWORK, current => current.settings))
      .rejects.toMatchObject({ code: 'STORAGE_FAILED' });
    expect(await readFile(settingsFile(), 'utf8')).toBe(before);
    const temporary = (await readdir(configDirectory())).filter(name => name.endsWith('.tmp'));
    expect(temporary).toHaveLength(1);
    await rm(path.join(configDirectory(), temporary[0]!));
    await expect(access(lockFile())).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('commits valid state and removes its lock when lock-handle close reports an error', async () => {
    const registry = createIdentityProviderRegistry();
    faults.closeAfter = /\.idps\.mutation\.lock$/;

    await expect(registry.updateSettings(NETWORK, () => settings())).resolves.toMatchObject({ settings: settings() });
    expect(JSON.parse(await readFile(settingsFile(), 'utf8'))).toEqual(settings());
    await expect(access(lockFile())).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('commits valid state but never steals a lock whose unlink reports failure', async () => {
    const registry = createIdentityProviderRegistry();
    faults.removeBefore = /\.idps\.mutation\.lock$/;

    await expect(registry.updateSettings(NETWORK, () => settings())).resolves.toMatchObject({ settings: settings() });
    expect(JSON.parse(await readFile(settingsFile(), 'utf8'))).toEqual(settings());
    await expect(access(lockFile())).resolves.toBeUndefined();
    await expect(registry.updateSettings(NETWORK, () => settings())).rejects.toMatchObject({ code: 'STORAGE_FAILED' });
    await rm(lockFile());
  });
});
