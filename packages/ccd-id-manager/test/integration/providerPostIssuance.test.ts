import { describe,expect,it,vi } from 'vitest';
import { runCli } from '../../src/cli/index.js';
import { createIdentityProviderService } from '../../src/core/providers/service.js';
import type { IdentityProviderService } from '../../src/core/providers/types.js';
import { NETWORK,inventory,memoryRegistry,settings } from '../providerHelpers.js';

function serviceFixture(configuration = settings()) {
  const memory = memoryRegistry(inventory(), configuration);
  return {
    ...memory,
    service: createIdentityProviderService({ registry: memory.registry, readNodeContext: async () => { throw new Error('unused'); } }),
  };
}

describe('per-provider issuance transport service', () => {
  it('projects effective GET by default and POST method without operator-defined body fields', async () => {
    const get = serviceFixture();
    await expect(get.service.inspect({ network: NETWORK, selector: 0 })).resolves.toMatchObject({
      issuanceMethod: 'GET',
    });
    await expect(get.service.resolve({ network: NETWORK, selector: 0, requireEnabled: true })).resolves.toEqual({
      index: 0,
      issuanceUrl: 'https://idp.example/issue',
      recoveryUrl: 'https://idp.example/recover',
      issuanceMethod: 'GET',
      anonymityRevokers: [1, 2],
    });
    expect(await get.service.inventory({ network: NETWORK })).not.toHaveProperty('issuanceMethod');

    const postSettings = settings({ providers: {
      ...settings().providers,
      '0': { ...settings().providers['0']!, issuanceMethod: 'POST' },
    } });
    const post = serviceFixture(postSettings);
    await expect(post.service.inspect({ network: NETWORK, selector: 'primary' })).resolves.toMatchObject({
      issuanceMethod: 'POST',
    });
    await expect(post.service.resolve({ network: NETWORK, selector: 0, requireEnabled: true })).resolves.toMatchObject({
      issuanceMethod: 'POST',
    });
    expect(JSON.stringify(await post.service.inventory({ network: NETWORK }))).not.toMatch(/issuanceMethod|issuanceBody/);
  });

  it('atomically changes the method while preserving unrelated provider state', async () => {
    const h = serviceFixture();
    await h.service.configure({
      network: NETWORK, selector: 0, patch: { issuanceMethod: 'POST' },
    });
    expect(h.get().settings.providers['0']).toEqual({
      ...settings().providers['0'], issuanceMethod: 'POST',
    });
  });

  it('rejects the removed issuance body field at the service boundary', async () => {
    const h = serviceFixture();
    const before = h.get().settings;
    await expect(h.service.configure({
      network: NETWORK, selector: 0, patch: { issuanceBody: { network: 'devnet' } } as never,
    })).rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' });
    expect(h.get().settings).toEqual(before);
  });

  const invalidPatches: Array<{
    name: string;
    patch: { issuanceMethod?: string };
  }> = [
    { name: 'invalid method', patch: { issuanceMethod: 'PATCH' } },
  ];
  it.each(invalidPatches)('rejects a $name patch without changing settings', async ({ patch }) => {
    const h = serviceFixture();
    const before = h.get().settings;
    await expect(h.service.configure({ network: NETWORK, selector: 0, patch: patch as never }))
      .rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' });
    expect(h.get().settings).toEqual(before);
  });
});
describe('per-provider issuance CLI', () => {
  function cliFixture() {
    const configure = vi.fn(async () => ({ index: 0, name: 'Zero ID', enabled: false, issuanceMethod: 'POST' as const }));
    const providerService = { configure } as unknown as IdentityProviderService;
    const stdout = vi.fn<(value: string) => void>();
    const stderr = vi.fn<(value: string) => void>();
    return {
      configure, stdout, stderr,
      deps: { providerService, resolveProviderNetwork: () => NETWORK, stdout, stderr },
    };
  }

  it('normalizes the configured issuance method', async () => {
    const h = cliFixture();
    await expect(runCli([
      'idp', 'configure', '--idp', '0', '--issuance-method', 'post',
    ], h.deps)).resolves.toBe(0);
    expect(h.configure).toHaveBeenCalledWith({
      network: NETWORK, selector: 0,
      patch: { issuanceMethod: 'POST' },
    });
  });

  it.each([
    ['removed body option', ['--issuance-body', 'network=devnet']],
    ['removed clear-body option', ['--clear-issuance-body']],
    ['invalid method', ['--issuance-method', 'PUT']],
  ])('rejects %s before network or provider effects', async (_name, options) => {
    const h = cliFixture();
    const resolveProviderNetwork = vi.fn(() => NETWORK);
    await expect(runCli(['idp', 'configure', '--idp', '0', ...options], {
      ...h.deps, resolveProviderNetwork,
    })).resolves.toBe(2);
    expect(resolveProviderNetwork).not.toHaveBeenCalled();
    expect(h.configure).not.toHaveBeenCalled();
  });
});
