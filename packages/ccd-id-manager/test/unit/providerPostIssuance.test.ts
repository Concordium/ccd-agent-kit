import { mkdir,readFile,writeFile } from 'node:fs/promises';
import { describe,expect,it } from 'vitest';
import { IdentityProviderError } from '../../src/core/providers/error.js';
import { createIdentityProviderRegistry } from '../../src/core/providers/registry.js';
import { NETWORK,settings,useProviderScratch } from '../providerHelpers.js';

const scratch = useProviderScratch('provider-post-');

describe('per-provider issuance transport settings', () => {
  it('ignores an obsolete issuance body on read and drops it on the next settings write', async () => {
    const configured = settings({ providers: {
      ...settings().providers,
      '0': {
        ...settings().providers['0']!,
        issuanceMethod: 'POST',
        issuanceBody: { network: 'devnet', tenant: 'office=west' },
      } as never,
    } });
    await mkdir(scratch.configDirectory(), { recursive: true, mode: 0o700 });
    await writeFile(scratch.settingsFile(), JSON.stringify(configured), { mode: 0o600 });

    const registry = createIdentityProviderRegistry();
    const expected = structuredClone(configured) as typeof configured & { providers: Record<string, Record<string, unknown>> };
    delete expected.providers['0']!.issuanceBody;
    await expect(registry.read(NETWORK)).resolves.toEqual({ settings: expected });
    await registry.updateSettings(NETWORK, snapshot => ({
      ...snapshot.settings,
      identityRequestTimeoutSeconds: 3_600,
    }));

    expect(JSON.parse(await readFile(scratch.settingsFile(), 'utf8'))).toEqual({
      ...expected, identityRequestTimeoutSeconds: 3_600,
    });
  });

  it.each([
    ['lowercase method', { issuanceMethod: 'post' }],
    ['unknown method', { issuanceMethod: 'PUT' }],
  ])('rejects invalid persisted %s without rewriting it', async (_name, transport) => {
    const invalid = settings({ providers: {
      '0': { ...settings().providers['0']!, ...transport } as never,
    } });
    const contents = JSON.stringify(invalid);
    await mkdir(scratch.configDirectory(), { recursive: true, mode: 0o700 });
    await writeFile(scratch.settingsFile(), contents, { mode: 0o600 });

    await expect(createIdentityProviderRegistry().read(NETWORK)).rejects.toBeInstanceOf(IdentityProviderError);
    expect(await readFile(scratch.settingsFile(), 'utf8')).toBe(contents);
  });
});
