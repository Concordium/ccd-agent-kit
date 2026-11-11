import { rename,symlink } from 'node:fs/promises';
import path from 'node:path';
import { describe,expect,it } from 'vitest';
import { createIdentityProviderRegistry } from '../../src/core/providers/registry.js';
import { NETWORK,settings,useProviderScratch } from '../providerHelpers.js';

useProviderScratch('provider-registry-parent-path-');

describe('provider registry shared parent paths', () => {
  it('rejects a symlinked ccd-agent-kit config directory during read-only access', async () => {
      const registry = createIdentityProviderRegistry();
      await registry.updateSettings(NETWORK, () => settings());
      const parent = path.join(process.env.XDG_CONFIG_HOME!, 'ccd-agent-kit');
      const target = `${parent}.original`;
      await rename(parent, target);
      await symlink(target, parent);
      await expect(registry.read(NETWORK)).rejects.toMatchObject({ code: 'STORAGE_FAILED' });
  });
});
