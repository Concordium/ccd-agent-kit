import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import {
  assertUniqueCatalogLabels, getConfigDir, getIdentityContextSnapshot, parseCatalogLabel,
} from '@ccd-agent-kit/config-utils';
import { serializeJsonFile } from '@ccd-agent-kit/mcp-utils';
import { safeHttpUrl } from '../workflowValidation.js';
import { IdentityProviderError } from './error.js';
import { providerInventory } from './inventory.js';
import { validateStoredAnonymityRevocationPolicy } from './anonymityRevocation.js';
import type {
  CanonicalNetwork,
  IdentityProviderRegistry,
  ProviderConfiguration,
  ProviderRegistrySnapshot,
  ProviderSettings,
} from './types.js';

const MAX_ID = 0x7fffffff;
const GENESIS = /^[0-9a-f]{64}$/;

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function exact(value: Record<string, unknown>, fields: readonly string[]): boolean {
  return Object.keys(value).length === fields.length && fields.every((field) => Object.hasOwn(value, field));
}
function validId(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_ID;
}
function fail(): never { throw new IdentityProviderError('STORAGE_FAILED'); }

function assertNetwork(network: CanonicalNetwork): string {
  if (!object(network) || !exact(network, ['caip2', 'genesisHash'])
    || typeof network.genesisHash !== 'string' || !GENESIS.test(network.genesisHash)
    || network.caip2 !== `ccd:${network.genesisHash.slice(0, 32)}`) {
    throw new IdentityProviderError('INVALID_NETWORK');
  }
  return network.genesisHash.slice(0, 32);
}

function validUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try { safeHttpUrl(value); return true; } catch { return false; }
}

function parseConfiguration(value: unknown): ProviderConfiguration {
  if (!object(value)) fail();
  const allowed = [
    'label', 'issuanceUrl', 'recoveryUrl', 'issuanceMethod', 'anonymityRevokers',
    'anonymityRevokerThreshold', 'enabled', 'issuanceBody',
  ];
  if (!Object.keys(value).every((key) => allowed.includes(key)) || !Object.hasOwn(value, 'enabled')
    || typeof value.enabled !== 'boolean'
    || (value.label !== undefined && typeof value.label !== 'string')
    || (value.issuanceUrl !== undefined && !validUrl(value.issuanceUrl))
    || (value.recoveryUrl !== undefined && !validUrl(value.recoveryUrl))
    || (value.issuanceMethod !== undefined && value.issuanceMethod !== 'GET' && value.issuanceMethod !== 'POST')
    ) fail();
  try {
    validateStoredAnonymityRevocationPolicy({
      ...(value.anonymityRevokers === undefined ? {} : { anonymityRevokers: value.anonymityRevokers as number[] }),
      ...(value.anonymityRevokerThreshold === undefined ? {} : {
        anonymityRevokerThreshold: value.anonymityRevokerThreshold as number,
      }),
    });
  } catch { fail(); }
  const complete = typeof value.issuanceUrl === 'string' && typeof value.recoveryUrl === 'string';
  if (value.enabled && !complete) fail();
  if (typeof value.label === 'string') {
    try { parseCatalogLabel(value.label); } catch { fail(); }
  }
  const configuration = structuredClone(value);
  // Obsolete operator field: ignore on read and discard on the next settings write.
  delete configuration.issuanceBody;
  return configuration as unknown as ProviderConfiguration;
}

function parseSettings(value: unknown, network: CanonicalNetwork): ProviderSettings {
  if (!object(value)) fail();
  const fields = [
    'version',
    'genesisHash',
    'providers',
    ...(Object.hasOwn(value, 'defaultIdentityProvider') ? ['defaultIdentityProvider'] : []),
    ...(Object.hasOwn(value, 'identityRequestTimeoutSeconds') ? ['identityRequestTimeoutSeconds'] : []),
  ];
  if (!exact(value, fields) || value.version !== 1 || value.genesisHash !== network.genesisHash
    || !object(value.providers)
    || (Object.hasOwn(value, 'defaultIdentityProvider') && !validId(value.defaultIdentityProvider))
    || (Object.hasOwn(value, 'identityRequestTimeoutSeconds')
      && (typeof value.identityRequestTimeoutSeconds !== 'number'
        || !Number.isSafeInteger(value.identityRequestTimeoutSeconds)
        || value.identityRequestTimeoutSeconds <= 0))) fail();
  const providers: Record<string, ProviderConfiguration> = {};
  for (const [key, candidate] of Object.entries(value.providers)) {
    if (!/^(?:0|[1-9]\d*)$/.test(key) || !validId(Number(key))) fail();
    const parsed = parseConfiguration(candidate);
    providers[key] = parsed;
  }
  try { assertUniqueCatalogLabels(Object.values(providers).map(provider => provider.label)); } catch { fail(); }
  return {
    version: 1,
    genesisHash: network.genesisHash,
    providers,
    ...(typeof value.defaultIdentityProvider === 'number' ? { defaultIdentityProvider: value.defaultIdentityProvider } : {}),
    ...(typeof value.identityRequestTimeoutSeconds === 'number'
      ? { identityRequestTimeoutSeconds: value.identityRequestTimeoutSeconds }
      : {}),
  };
}

function directories(network: CanonicalNetwork) {
  const reference = assertNetwork(network);
  return {
    configRoot: path.join(getConfigDir(), 'id-manager'),
    config: path.join(getConfigDir(), 'id-manager', reference),
  };
}

async function assertDirectory(dirname: string, protectedMode: boolean): Promise<boolean> {
  try {
    const details = await lstat(dirname);
    if (!details.isDirectory() || (protectedMode && (details.mode & 0o077) !== 0)) fail();
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    if (error instanceof IdentityProviderError) throw error;
    return fail();
  }
}

async function ensureProtected(root: string, networkDirectory: string, sharedRoot: string): Promise<void> {
  await mkdir(sharedRoot, { recursive: true, mode: 0o700 });
  await assertDirectory(sharedRoot, false);
  if (!await assertDirectory(root, true)) await mkdir(root, { mode: 0o700 });
  await chmod(root, 0o700);
  if (!await assertDirectory(networkDirectory, true)) await mkdir(networkDirectory, { mode: 0o700 });
  await chmod(networkDirectory, 0o700);
}

async function readDocument(filename: string): Promise<unknown | undefined> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    const details = await handle.stat();
    if (!details.isFile() || (details.mode & 0o077) !== 0) fail();
    return JSON.parse(await handle.readFile({ encoding: 'utf8' })) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    if (error instanceof IdentityProviderError) throw error;
    return fail();
  } finally { await handle?.close().catch(() => undefined); }
}

async function load(network: CanonicalNetwork): Promise<ProviderRegistrySnapshot> {
  const dirs = directories(network);
  let settingsValue: unknown | undefined;
  if (await assertDirectory(getConfigDir(), false)
    && await assertDirectory(dirs.configRoot, true) && await assertDirectory(dirs.config, true)) {
    settingsValue = await readDocument(path.join(dirs.config, 'idps.json'));
  }
  const context = getIdentityContextSnapshot(network.genesisHash.slice(0, 32));
  return {
    settings: settingsValue === undefined
      ? { version: 1, genesisHash: network.genesisHash, providers: {} }
      : parseSettings(settingsValue, network),
    ...(context?.network.genesisHash === network.genesisHash ? { inventory: providerInventory(context) } : {}),
  };
}

async function atomicJson(filename: string, value: unknown): Promise<void> {
  const temporary = path.join(path.dirname(filename), `.${path.basename(filename)}.${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    await handle.writeFile(serializeJsonFile(value));
    await handle.close(); handle = undefined;
    await rename(temporary, filename);
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

/** Create the protected network-scoped identity-provider registry. */
export function createIdentityProviderRegistry(): IdentityProviderRegistry {
  const read = async (network: CanonicalNetwork): Promise<ProviderRegistrySnapshot> => {
    try { return structuredClone(await load(network)); }
    catch (error) {
      if (error instanceof IdentityProviderError) throw error;
      throw new IdentityProviderError('STORAGE_FAILED');
    }
  };
  const mutate = async (
    network: CanonicalNetwork,
    operation: (snapshot: ProviderRegistrySnapshot, dirs: ReturnType<typeof directories>) => Promise<void>,
  ): Promise<ProviderRegistrySnapshot> => {
    const dirs = directories(network);
    let lock: Awaited<ReturnType<typeof open>> | undefined;
    const lockFile = path.join(dirs.config, '.idps.mutation.lock');
    try {
      await ensureProtected(dirs.configRoot, dirs.config, getConfigDir());
      lock = await open(lockFile, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      const snapshot = await load(network);
      await operation(snapshot, dirs);
      return structuredClone(await load(network));
    } catch (error) {
      if (error instanceof IdentityProviderError) throw error;
      throw new IdentityProviderError('STORAGE_FAILED');
    } finally {
      if (lock) {
        await lock.close().catch(() => undefined);
        await rm(lockFile, { force: true }).catch(() => undefined);
      }
    }
  };
  return {
    read,
    updateSettings(network, update) {
      return mutate(network, async (snapshot, dirs) => {
        const next = parseSettings(update(structuredClone(snapshot)), network);
        await atomicJson(path.join(dirs.config, 'idps.json'), next);
      });
    },
  };
}
