import { createHash } from 'node:crypto';
import path from 'node:path';
import { vi } from 'vitest';
import type { IdentityRootAgreement } from '../src/core/identityRoot.js';
import type { IdentitySourceRecord } from '@ccd-agent-kit/config-utils';
import type {
  IdentitySourceBackend,
  IdentitySourceBackendInspection,
} from '../src/core/sources/types.js';
import { OTHER_KEY, PUBLIC_KEY, SERIAL } from './yubikeyHelpers.js';
import { useTestXdg } from './xdgTestHelpers.js';

export { SERIAL } from './yubikeyHelpers.js';

// Frozen vectors computed independently from the documented SHA-256/base32 recipe.
export const SOURCE_ID = 'ir:y27dru5wlwjzay6';
export const OTHER_SOURCE_ID = 'ir:nmla3jd74l7ehx7';
export const ROOT_PUBLIC_KEY = PUBLIC_KEY.toString('hex');
export const OTHER_ROOT_PUBLIC_KEY = OTHER_KEY.toString('hex');
export const ROOT_FINGERPRINT = createHash('sha256').update(PUBLIC_KEY).digest('hex');
export const OTHER_ROOT_FINGERPRINT = createHash('sha256').update(OTHER_KEY).digest('hex');

export function sourceRecord(overrides: Partial<IdentitySourceRecord> = {}): IdentitySourceRecord {
  return {
    label: 'primary',
    backends: [{ backend: 'yubikey-piv', locations: [{ serial: SERIAL }] }],
    rootPublicKey: ROOT_PUBLIC_KEY,
    rootPublicKeyFingerprint: ROOT_FINGERPRINT,
    recipeVersion: 1,
    ...overrides,
  };
}

export function otherSourceRecord(overrides: Partial<IdentitySourceRecord> = {}): IdentitySourceRecord {
  return sourceRecord({
    label: 'secondary',
    backends: [{ backend: 'yubikey-piv', locations: [{ serial: '87654321' }] }],
    rootPublicKey: OTHER_ROOT_PUBLIC_KEY,
    rootPublicKeyFingerprint: OTHER_ROOT_FINGERPRINT,
    ...overrides,
  });
}

export function presentInspection(overrides: Partial<Extract<IdentitySourceBackendInspection, { status: 'present' }>> = {}): IdentitySourceBackendInspection {
  return {
    status: 'present',
    rootPublicKey: ROOT_PUBLIC_KEY,
    authorization: 'unlocked',
    pinPolicy: 'never',
    touchPolicy: 'always',
    ...overrides,
  };
}

export function fakeSourceBackend(
  inspection: IdentitySourceBackendInspection = presentInspection(),
  backendName = 'yubikey-piv',
) {
  const agreement: IdentityRootAgreement = { agree: vi.fn() };
  const backend = {
    backend: backendName,
    inspect: vi.fn(async (_locator: Record<string, unknown>, _binding?: Parameters<IdentitySourceBackend['inspect']>[1]) => inspection),
    createAgreement: vi.fn((_input: Parameters<IdentitySourceBackend['createAgreement']>[0]) => agreement),
  } satisfies IdentitySourceBackend;
  return { backend, agreement };
}

/** Repository-local isolated XDG data home. Never reads a developer's real protected state. */
export function useSourceScratch(prefix: string) {
  useTestXdg(prefix, ['XDG_DATA_HOME']);
  return {
    directory: () => path.join(process.env.XDG_DATA_HOME!, 'ccd-agent-kit', 'id-manager'),
    filename: () => path.join(process.env.XDG_DATA_HOME!, 'ccd-agent-kit', 'id-manager', 'sources.json'),
    lockfile: () => path.join(process.env.XDG_DATA_HOME!, 'ccd-agent-kit', 'id-manager', '.sources.mutation.lock'),
  };
}
