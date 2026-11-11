import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

import { getConfigDir } from './paths.js';
import { protectedFileExists, writeProtectedJsonAtomic } from './signer/protectedFile.js';

/** Built-in runtime identity-source backend identifier. */
export const YUBIKEY_IDENTITY_SOURCE_BACKEND = 'yubikey-piv';

/** Runtime policy for one identity-source backend. */
export type IdentitySourceBackendPolicy = 'enabled' | 'disabled';

const identitySourceBackendConfigSchema = z
  .object({
    version: z.literal(1),
    backends: z.record(z.string(), z.object({ enabled: z.boolean() }).strict()),
  })
  .strict();

type IdentitySourceBackendConfig = z.infer<typeof identitySourceBackendConfigSchema>;

/** Returns whether an identity-source backend is independently enabled for identity-manager. */
export function isIdentitySourceBackendEnabled(backend: string): boolean {
  return loadIdentitySourceBackendConfig().backends[backend]?.enabled
    ?? backend === YUBIKEY_IDENTITY_SOURCE_BACKEND;
}

/** Persists identity-manager runtime policy for a known identity-source backend. */
export function setIdentitySourceBackendPolicy(
  backend: string,
  policy: IdentitySourceBackendPolicy,
): void {
  if (backend !== YUBIKEY_IDENTITY_SOURCE_BACKEND) {
    throw new Error('Unknown identity-source backend.');
  }
  const config = loadIdentitySourceBackendConfig();
  config.backends[backend] = { enabled: policy === 'enabled' };
  writeProtectedJsonAtomic(identitySourceBackendConfigPath(), config, 'config');
}

function identitySourceBackendConfigPath(): string {
  return join(getConfigDir(), 'id-manager', 'config.json');
}

function loadIdentitySourceBackendConfig(): IdentitySourceBackendConfig {
  const path = identitySourceBackendConfigPath();
  if (!protectedFileExists(path)) return { version: 1, backends: {} };
  const parsed = identitySourceBackendConfigSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
  if (!parsed.success) {
    throw new Error('Unsupported identity-manager configuration.');
  }
  return parsed.data;
}
