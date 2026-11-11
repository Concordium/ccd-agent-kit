import { describe,expect,it,vi } from 'vitest';
import { IdentityProviderError } from '../../src/core/providers/error.js';
import { createIdentityProviderService } from '../../src/core/providers/service.js';
import { NETWORK,inventory,memoryRegistry,nodeContext,settings } from '../providerHelpers.js';

function fixture(withSettings = settings()) {
  const memory = memoryRegistry(inventory(), withSettings);
  const readNodeContext = vi.fn(async () => nodeContext());
  const service = createIdentityProviderService({
    registry: memory.registry,
    readNodeContext,
  });
  return { ...memory, readNodeContext, service };
}

async function captureFailure(operation: () => Promise<unknown>): Promise<unknown> {
  try { await operation(); } catch (error) { return error; }
  throw new Error('Expected operation to fail');
}

describe('identity-provider service', () => {
  it('uses the inert 24-hour identity request timeout default when the root setting is omitted', async () => {
    const h = fixture(settings({ identityRequestTimeoutSeconds: undefined }));
    await expect(h.service.getIdentityRequestTimeoutMs({ network: NETWORK })).resolves.toBe(86_400_000);
    expect(h.registry.read).toHaveBeenCalledExactlyOnceWith(NETWORK);
    expect(h.registry.updateSettings).not.toHaveBeenCalled();
  });

  it('returns a configured identity request timeout in milliseconds', async () => {
    const h = fixture(settings({ identityRequestTimeoutSeconds: 43_200 }));
    await expect(h.service.getIdentityRequestTimeoutMs({ network: NETWORK })).resolves.toBe(43_200_000);
  });

  it('configures the root identity request timeout without changing provider or historical settings', async () => {
    const h = fixture();
    const before = h.get().settings;
    await expect(h.service.configureIdentityRequestTimeout({ network: NETWORK, seconds: 7_200 })).resolves.toEqual({
      network: NETWORK.caip2,
      identityRequestTimeoutSeconds: 7_200,
    });
    expect(h.get().settings).toEqual({ ...before, identityRequestTimeoutSeconds: 7_200 });
    expect(h.registry.read).not.toHaveBeenCalled();
    expect(h.registry.updateSettings).toHaveBeenCalledExactlyOnceWith(NETWORK, expect.any(Function));
  });

  it.each([0, -1, 1.5, Number.POSITIVE_INFINITY, Number.NaN, Math.floor(Number.MAX_SAFE_INTEGER / 1_000) + 1])(
    'rejects invalid identity request timeout seconds %s without saving',
    async (seconds) => {
      const h = fixture();
      const before = h.get().settings;
      await expect(h.service.configureIdentityRequestTimeout({ network: NETWORK, seconds }))
        .rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' });
      expect(h.get().settings).toEqual(before);
      expect(h.registry.updateSettings).not.toHaveBeenCalled();
    },
  );

  it('projects a sorted safe local inventory without network access or endpoint disclosure', async () => {
    const h = fixture(settings({ providers: {
      ...settings().providers, '0': { ...settings().providers['0']!, label: '@primary' },
    } }));
    const result = await h.service.inventory({ network: NETWORK });
    expect(result).toEqual({
      network: NETWORK.caip2,
      refreshedAt: inventory().refreshedAt,
      providers: [
        { index: 0, name: 'Zero ID', description: 'Provider zero', label: 'primary', enabled: true },
        { index: 2, name: 'Two ID', enabled: false },
      ],
    });
    expect(JSON.stringify(result)).not.toContain('issuanceUrl');
    expect(h.readNodeContext).not.toHaveBeenCalled();
  });

  it('returns an empty projection for missing inventory and invents no freshness', async () => {
    const memory = memoryRegistry();
    const readNodeContext = vi.fn();
    const service = createIdentityProviderService({ registry: memory.registry, readNodeContext });
    await expect(service.inventory({ network: NETWORK })).resolves.toEqual({ network: NETWORK.caip2, providers: [] });
    expect(readNodeContext).not.toHaveBeenCalled();
  });

  it('cannot resolve an explicit provider without a verified inventory', async () => {
    const memory = memoryRegistry(undefined, settings());
    const service = createIdentityProviderService({ registry: memory.registry, readNodeContext: vi.fn() });
    await expect(service.resolve({ network: NETWORK, selector: 0, requireEnabled: false }))
      .rejects.toMatchObject({ code: 'PROVIDER_NOT_FOUND' });
  });

  it('suppresses a configured default when local inventory is missing', async () => {
    const memory = memoryRegistry(undefined, settings());
    const service = createIdentityProviderService({ registry: memory.registry, readNodeContext: vi.fn() });
    await expect(service.inventory({ network: NETWORK })).resolves.toEqual({ network: NETWORK.caip2, providers: [] });
  });

  it('projects one fresh node context without persisting chain data', async () => {
    const h = fixture();
    const refreshed = await h.service.refresh({ network: NETWORK });
    expect(refreshed).toMatchObject({
      network: NETWORK.caip2,
      refreshedAt: '2026-10-16T12:00:00.000Z',
    });
    expect(h.readNodeContext).toHaveBeenCalledExactlyOnceWith(NETWORK);
    expect(refreshed.providers).toEqual([
      { index: 0, name: 'Zero ID', description: 'Provider zero', label: 'primary', enabled: true },
      { index: 2, name: 'Two ID', enabled: false },
    ]);
    expect(h.registry.read).toHaveBeenCalledExactlyOnceWith(NETWORK);
    expect(JSON.stringify(refreshed)).not.toMatch(/ipVerifyKey|ipCdiVerifyKey|globalContext|issuanceUrl|recoveryUrl/);
    expect(h.get().inventory).toEqual(inventory());
    expect(h.get().settings).toEqual(settings());
  });

  it('uses node-owned observation time rather than a service clock', async () => {
    const h = fixture();
    h.readNodeContext.mockResolvedValue(nodeContext({ observedAt: '2027-03-04T05:06:07.000Z' }));
    await expect(h.service.refresh({ network: NETWORK })).resolves.toMatchObject({
      refreshedAt: '2027-03-04T05:06:07.000Z',
      providers: [
        expect.objectContaining({ index: 0 }),
        expect.objectContaining({ index: 2 }),
      ],
    });
  });

  it('rejects mismatched node network without changing cached registry state', async () => {
    const h = fixture();
    const before = h.get();
    h.readNodeContext.mockResolvedValue(nodeContext({ network: { ...NETWORK, genesisHash: '34'.repeat(32) } }));
    await expect(h.service.refresh({ network: NETWORK })).rejects.toMatchObject({ code: 'CONTEXT_MISMATCH' });
    expect(h.get()).toEqual(before);
  });

  it('preserves configured AR policy when the network-wide AR inventory changes', async () => {
    const h = fixture();
    const context = nodeContext();
    h.readNodeContext.mockResolvedValue(nodeContext({ anonymityRevokers: context.anonymityRevokers.slice(1) }));
    await expect(h.service.refresh({ network: NETWORK })).resolves.toMatchObject({
      providers: expect.arrayContaining([expect.objectContaining({ index: 0, enabled: true })]),
    });
    expect(h.get().settings).toEqual(settings());
  });

  it('exposes configured AR fields only from inspect and resolved action configuration', async () => {
    const configured = settings({ providers: {
      ...settings().providers,
      '0': { ...settings().providers['0']!, anonymityRevokers: [3, 1], anonymityRevokerThreshold: 2 } as never,
    } });
    const h = fixture(configured);
    await expect(h.service.inspect({ network: NETWORK, selector: 0 })).resolves.toMatchObject({
      anonymityRevokers: [3, 1], anonymityRevokerThreshold: 2,
    });
    await expect(h.service.resolve({ network: NETWORK, selector: 0, requireEnabled: true })).resolves.toMatchObject({
      anonymityRevokers: [3, 1], anonymityRevokerThreshold: 2,
    });
    await expect(h.service.inventory({ network: NETWORK })).resolves.not.toHaveProperty('anonymityRevokers');
  });

  it('omits unconfigured AR fields from resolved action configuration', async () => {
    const policyless = settings();
    delete policyless.providers['0']!.anonymityRevokers;
    await expect(fixture(policyless).service.resolve({
      network: NETWORK, selector: 0, requireEnabled: true,
    })).resolves.toEqual({
      index: 0,
      issuanceUrl: 'https://idp.example/issue',
      recoveryUrl: 'https://idp.example/recover',
      issuanceMethod: 'GET',
    });
  });

  it('returns detached configured AR arrays from inspect and resolve', async () => {
    const h = fixture();
    const inspected = await h.service.inspect({ network: NETWORK, selector: 0 }) as unknown as {
      anonymityRevokers: number[];
    };
    const resolved = await h.service.resolve({ network: NETWORK, selector: 0, requireEnabled: true }) as unknown as {
      anonymityRevokers: number[];
    };
    inspected.anonymityRevokers.push(99);
    resolved.anonymityRevokers.reverse();
    await expect(h.service.inspect({ network: NETWORK, selector: 0 })).resolves.toMatchObject({
      anonymityRevokers: [1, 2],
    });
    expect(h.get().settings.providers['0']!.anonymityRevokers).toEqual([1, 2]);
  });

  it.each([[0], ['0'], ['primary']] as const)(
    'resolves explicit selector %j to complete action configuration',
    async (selector) => {
      const h = fixture();
      await expect(h.service.resolve({ network: NETWORK, selector, requireEnabled: true })).resolves.toEqual({
        index: 0,
        issuanceUrl: 'https://idp.example/issue',
        recoveryUrl: 'https://idp.example/recover',
        issuanceMethod: 'GET',
        anonymityRevokers: [1, 2],
      });
      expect(h.readNodeContext).not.toHaveBeenCalled();
    },
  );

  it('selects by native index or trimmed case-insensitive local label and treats node names as display-only', async () => {
    const h = fixture();
    h.set({
      inventory: inventory({ providers: [
        { index: 0, name: 'GeneratedIP0' },
        { index: 2, name: 'Provider With Spaces' },
      ] }),
      settings: settings(),
    });
    await expect(h.service.resolve({ network: NETWORK, selector: '  PRIMARY ', requireEnabled: true }))
      .resolves.toMatchObject({ index: 0 });
    await expect(h.service.resolve({ network: NETWORK, selector: 'GeneratedIP0', requireEnabled: false }))
      .rejects.toMatchObject({ code: 'PROVIDER_NOT_FOUND' });
    await expect(h.service.resolve({ network: NETWORK, selector: 'Provider With Spaces', requireEnabled: false }))
      .rejects.toMatchObject({ code: 'INVALID_SELECTOR' });
  });

  it('does not case-fold native numeric provider selectors', async () => {
    const h = fixture();
    await expect(h.service.resolve({ network: NETWORK, selector: '０', requireEnabled: false }))
      .rejects.toMatchObject({ code: 'INVALID_SELECTOR' });
  });

  it('rejects a missing selector even when historical default metadata exists', async () => {
    const h = fixture();
    await expect(h.service.resolve({ network: NETWORK, requireEnabled: true } as never)).rejects.toMatchObject({
      code: 'INVALID_SELECTOR',
    });
  });

  it('never uses inert historical default metadata as a selector', async () => {
    const h = fixture(
      settings({
        providers: {
          '0': {
            label: 'primary',
            issuanceUrl: 'https://idp.example/issue',
            recoveryUrl: 'https://idp.example/recover',
            anonymityRevokers: [1, 2],
            enabled: false,
          },
          '2': {
            issuanceUrl: 'https://two.example/issue',
            recoveryUrl: 'https://two.example/recover',
            anonymityRevokers: [1, 2],
            enabled: true,
          },
        },
        defaultIdentityProvider: undefined,
      }),
    );
    await expect(h.service.resolve({ network: NETWORK, selector: undefined, requireEnabled: true } as never))
      .rejects.toMatchObject({ code: 'INVALID_SELECTOR' });
    await expect(
      h.service.resolve({ network: NETWORK, selector: 'primary', requireEnabled: true }),
    ).rejects.toMatchObject({ code: 'PROVIDER_DISABLED' });
    await expect(h.service.resolve({ network: NETWORK, selector: 9, requireEnabled: true })).rejects.toMatchObject({
      code: 'PROVIDER_NOT_FOUND',
    });
  });

  it('allows an explicitly selected complete disabled provider only when enablement is not required', async () => {
    const h = fixture(
      settings({
        providers: { '0': { ...settings().providers['0']!, enabled: false } },
        defaultIdentityProvider: undefined,
      }),
    );
    await expect(
      h.service.resolve({ network: NETWORK, selector: 'primary', requireEnabled: false }),
    ).resolves.toMatchObject({ index: 0 });
    await expect(
      h.service.resolve({ network: NETWORK, selector: 'primary', requireEnabled: true }),
    ).rejects.toMatchObject({ code: 'PROVIDER_DISABLED' });
  });

  it('distinguishes absent, partial, disabled, and invalid selectors', async () => {
    const h = fixture(
      settings({
        providers: { '0': { label: 'primary', enabled: false }, '2': { enabled: false } },
        defaultIdentityProvider: undefined,
      }),
    );
    await expect(h.service.resolve({ network: NETWORK, selector: 0, requireEnabled: false })).rejects.toMatchObject({
      code: 'PROVIDER_NOT_CONFIGURED',
    });
    await expect(
      h.service.resolve({ network: NETWORK, selector: 'unknown', requireEnabled: false }),
    ).rejects.toMatchObject({ code: 'PROVIDER_NOT_FOUND' });
    await expect(
      h.service.resolve({ network: NETWORK, selector: 'not valid!', requireEnabled: false }),
    ).rejects.toMatchObject({ code: 'INVALID_SELECTOR' });
  });

  it('configures one known provider and returns its full updated inspection from the atomic snapshot', async () => {
    const h = fixture();
    await expect(h.service.configure({
      network: NETWORK,
      selector: 'primary',
      patch: { issuanceUrl: 'https://new.example/issue' },
    })).resolves.toEqual({
      index: 0,
      name: 'Zero ID',
      description: 'Provider zero',
      label: 'primary',
      enabled: true,
      issuanceUrl: 'https://new.example/issue',
      recoveryUrl: 'https://idp.example/recover',
      issuanceMethod: 'GET',
      anonymityRevokers: [1, 2],
    });
    expect(h.get().settings).toEqual(
      settings({
        providers: {
          ...settings().providers,
          '0': { ...settings().providers['0']!, issuanceUrl: 'https://new.example/issue' },
        },
      }),
    );
    expect(h.registry.read).not.toHaveBeenCalled();
    expect(h.registry.updateSettings).toHaveBeenCalledOnce();
  });

  it('delegates explicit label mode in the same atomic update without a second read or inspect', async () => {
    const h = fixture();
    const inspect = vi.spyOn(h.service, 'inspect');
    await expect(h.service.configure({
      network: NETWORK, selector: 'primary', patch: { label: 'office', mode: 'soft' },
    }))
      .resolves.toEqual({
        index: 0,
        name: 'Zero ID',
        description: 'Provider zero',
        label: 'office',
        enabled: true,
        issuanceUrl: 'https://idp.example/issue',
        recoveryUrl: 'https://idp.example/recover',
        issuanceMethod: 'GET',
        anonymityRevokers: [1, 2],
      });
    expect(h.registry.read).not.toHaveBeenCalled();
    expect(h.registry.updateSettings).toHaveBeenCalledOnce();
    expect(h.get().settings.providers['0']!.label).toBe('@office');
    expect(inspect).not.toHaveBeenCalled();
  });

  it('creates settings for an inventoried provider with all supported patch fields', async () => {
    const h = fixture(settings({ providers: {}, defaultIdentityProvider: undefined }));
    await h.service.configure({
      network: NETWORK,
      selector: 2,
      patch: {
        label: 'secondary',
        issuanceUrl: 'https://two.example/issue',
        recoveryUrl: 'https://two.example/recover',
      },
    });
    expect(h.get().settings.providers['2']).toEqual({
      label: 'secondary',
      issuanceUrl: 'https://two.example/issue',
      recoveryUrl: 'https://two.example/recover',
      enabled: false,
    });
  });

  it.each([
    ['list only', { anonymityRevokers: [3, 1] }, { anonymityRevokers: [3, 1] }],
    ['threshold only', { anonymityRevokerThreshold: 2 }, { anonymityRevokerThreshold: 2 }],
    ['both', { anonymityRevokers: [3, 2], anonymityRevokerThreshold: 2 }, {
      anonymityRevokers: [3, 2], anonymityRevokerThreshold: 2,
    }],
  ] as const)('atomically configures AR policy with %s', async (_case, patch, expected) => {
    const policyless = settings();
    delete policyless.providers['0']!.anonymityRevokers;
    const h = fixture(policyless);
    await expect(h.service.configure({ network: NETWORK, selector: 0, patch: patch as never }))
      .resolves.toMatchObject(expected);
    expect(h.get().settings.providers['0']).toMatchObject(expected);
    expect(h.registry.updateSettings).toHaveBeenCalledOnce();
  });

  it('clears each AR field independently and represents deletion as null only at the patch boundary', async () => {
    const h = fixture(settings({ providers: {
      ...settings().providers,
      '0': { ...settings().providers['0']!, anonymityRevokerThreshold: 1 } as never,
    } }));
    await h.service.configure({ network: NETWORK, selector: 0, patch: { anonymityRevokers: null } as never });
    expect(h.get().settings.providers['0']).toMatchObject({ anonymityRevokerThreshold: 1 });
    expect(h.get().settings.providers['0']).not.toHaveProperty('anonymityRevokers');

    await h.service.configure({ network: NETWORK, selector: 0, patch: { anonymityRevokerThreshold: null } as never });
    expect(h.get().settings.providers['0']).not.toHaveProperty('anonymityRevokerThreshold');
  });

  it('accepts explicit threshold one for a single selected AR while rejecting its omitted default of zero', async () => {
    const h = fixture();
    await expect(h.service.configure({
      network: NETWORK, selector: 0, patch: { anonymityRevokers: [1] } as never,
    })).rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' });
    await expect(h.service.configure({
      network: NETWORK, selector: 0,
      patch: { anonymityRevokers: [1], anonymityRevokerThreshold: 1 } as never,
    })).resolves.toMatchObject({ anonymityRevokers: [1], anonymityRevokerThreshold: 1 });
  });

  it('configures AR policy without inventing a label for an unlabeled provider', async () => {
    const h = fixture();
    const configured = await h.service.configure({
      network: NETWORK, selector: 2,
      patch: { anonymityRevokers: [1, 2], anonymityRevokerThreshold: 1 } as never,
    });
    expect(configured).toMatchObject({ anonymityRevokers: [1, 2], anonymityRevokerThreshold: 1 });
    expect(configured).not.toHaveProperty('label');
    expect(h.get().settings.providers['2']).not.toHaveProperty('label');
  });

  it('accepts threshold 255 for 255 selected ARs', async () => {
    const ids = Array.from({ length: 255 }, (_, index) => index + 1);
    const h = fixture();
    h.set({ inventory: inventory({ anonymityRevokers: ids }), settings: h.get().settings });
    await expect(h.service.configure({
      network: NETWORK, selector: 0,
      patch: { anonymityRevokers: ids, anonymityRevokerThreshold: 255 } as never,
    })).resolves.toMatchObject({ anonymityRevokerThreshold: 255 });
  });

  it('rejects an effective default threshold above 255 rather than clamping it', async () => {
    const ids = Array.from({ length: 257 }, (_, index) => index + 1);
    const policyless = settings();
    delete policyless.providers['0']!.anonymityRevokers;
    const h = fixture(policyless);
    h.set({ inventory: inventory({ anonymityRevokers: ids }), settings: h.get().settings });
    await expect(h.service.configure({ network: NETWORK, selector: 0, patch: { label: 'renamed' } }))
      .rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' });
  });

  it.each([
    ['empty list', { anonymityRevokers: [] }],
    ['duplicate IDs', { anonymityRevokers: [1, 1], anonymityRevokerThreshold: 1 }],
    ['zero ID', { anonymityRevokers: [0, 1], anonymityRevokerThreshold: 1 }],
    ['fractional ID', { anonymityRevokers: [1.5], anonymityRevokerThreshold: 1 }],
    ['oversized ID', { anonymityRevokers: [0x1_0000_0000], anonymityRevokerThreshold: 1 }],
    ['unknown ID', { anonymityRevokers: [1, 99], anonymityRevokerThreshold: 1 }],
    ['zero threshold', { anonymityRevokerThreshold: 0 }],
    ['fractional threshold', { anonymityRevokerThreshold: 1.5 }],
    ['threshold above selected count', { anonymityRevokers: [1, 2], anonymityRevokerThreshold: 3 }],
    ['threshold above byte range', { anonymityRevokerThreshold: 256 }],
  ])('rejects invalid AR policy without changing any settings: %s', async (_case, patch) => {
    const h = fixture();
    const before = h.get().settings;
    await expect(h.service.configure({ network: NETWORK, selector: 0, patch: patch as never }))
      .rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' });
    expect(h.get().settings).toEqual(before);
  });

  it('validates the merged AR policy against the inventory captured by the atomic update', async () => {
    const h = fixture();
    h.set({ inventory: inventory({ anonymityRevokers: [1] }), settings: h.get().settings });
    await expect(h.service.configure({
      network: NETWORK, selector: 0, patch: { anonymityRevokerThreshold: 1 } as never,
    })).rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' });
    expect(h.registry.read).not.toHaveBeenCalled();
  });

  it.each([
    ['label', { label: 'renamed' }],
    ['recovery endpoint', { recoveryUrl: 'https://changed.example/recover' }],
  ] as const)('updates only the %s of an enabled provider without disabling it', async (_name, patch) => {
    const h = fixture();
    await expect(h.service.configure({ network: NETWORK, selector: 0, patch }))
      .resolves.toHaveProperty('enabled', true);
    expect(h.get().settings.providers['0']!.enabled).toBe(true);
  });

  it('uses the same endpoint-specific diagnostic when resolving a partial provider', async () => {
    const h = fixture(settings({
      providers: { '0': { issuanceUrl: 'https://idp.example/issue', enabled: false } },
      defaultIdentityProvider: undefined,
    }));
    await expect(h.service.resolve({ network: NETWORK, selector: 0, requireEnabled: false }))
      .rejects.toMatchObject({ code: 'RECOVERY_NOT_CONFIGURED', message: expect.stringContaining('--recovery') });
  });

  it.each([
    ['empty patch', {}, 'INVALID_CONFIGURATION'],
    ['numeric label', { label: '123' }, 'INVALID_LABEL'],
    ['duplicate label', { label: 'primary' }, 'DUPLICATE_LABEL'],
  ] as const)('rejects %s without saving', async (_label, patch, code) => {
    const h = fixture(
      settings({ providers: { ...settings().providers, '2': { label: 'secondary', enabled: false } } }),
    );
    const before = h.get().settings;
    const failure = await captureFailure(() => h.service.configure({ network: NETWORK, selector: 2, patch }));
    expect(failure).toBeInstanceOf(IdentityProviderError);
    expect(failure).toMatchObject({ code });
    expect(h.get().settings).toEqual(before);
  });

  it('translates a mode-only mutation without an existing label and preserves settings', async () => {
    const h = fixture(settings({ providers: { '2': { enabled: false } }, defaultIdentityProvider: undefined }));
    const before = h.get().settings;
    const failure = await captureFailure(() => h.service.configure({
      network: NETWORK, selector: 2, patch: { mode: 'soft' },
    }));
    expect(failure).toBeInstanceOf(IdentityProviderError);
    expect(failure).toMatchObject({ code: 'INVALID_LABEL' });
    expect(h.get().settings).toEqual(before);
  });

  it.each([
    ['unsupported issuance method', { issuanceMethod: 'DELETE' as never }],
    ['obsolete issuance body', { issuanceBody: { locale: 'en' } } as never],
  ])('rejects %s at the service boundary without saving', async (_case, patch) => {
    const h = fixture();
    const before = h.get().settings;
    await expect(h.service.configure({ network: NETWORK, selector: 0, patch }))
      .rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' });
    expect(h.get().settings).toEqual(before);
  });

  it('validates active cached AR configuration when updating an enabled provider', async () => {
    const h = fixture(settings({
      providers: {
        '0': {
          ...settings().providers['0']!,
          anonymityRevokers: [1, 99],
          enabled: true,
        },
      },
      defaultIdentityProvider: undefined,
    }));
    const before = h.get().settings;
    await expect(h.service.configure({ network: NETWORK, selector: 0, patch: { label: 'renamed' } }))
      .rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' });
    expect(h.get().settings).toEqual(before);
  });

  it('enables only complete current configuration and permits disabling it again', async () => {
    const h = fixture(
      settings({
        providers: { '0': { ...settings().providers['0']!, enabled: false }, '2': { enabled: false } },
        defaultIdentityProvider: undefined,
      }),
    );
    await h.service.setEnabled({ network: NETWORK, selector: 0, enabled: true });
    expect(h.get().settings.providers['0']!.enabled).toBe(true);
    const disabled = await h.service.setEnabled({ network: NETWORK, selector: 0, enabled: false });
    expect(disabled).toMatchObject({
      providers: expect.arrayContaining([expect.objectContaining({ index: 0, enabled: false })]),
    });
  });

  it('inspects endpoints only in the explicit CLI detail projection', async () => {
    const h = fixture();
    await expect(h.service.inspect({ network: NETWORK, selector: 'primary' })).resolves.toEqual({
      index: 0,
      name: 'Zero ID',
      description: 'Provider zero',
      label: 'primary',
      enabled: true,
      issuanceUrl: 'https://idp.example/issue',
      recoveryUrl: 'https://idp.example/recover',
      issuanceMethod: 'GET',
      anonymityRevokers: [1, 2],
    });
  });

  it('inspects an unconfigured provider without inventing optional configuration', async () => {
    const h = fixture(settings({ providers: {}, defaultIdentityProvider: undefined }));
    await expect(h.service.inspect({ network: NETWORK, selector: 2 })).resolves.toEqual({
      index: 2,
      name: 'Two ID',
      enabled: false,
      issuanceMethod: 'GET',
    });
  });

  it.each([
    ['negative number', -1],
    ['oversized numeric string', '2147483648'],
  ] as const)('rejects an invalid %s selector', async (_name, selector) => {
    const h = fixture();
    await expect(h.service.resolve({ network: NETWORK, selector, requireEnabled: false }))
      .rejects.toMatchObject({ code: 'INVALID_SELECTOR' });
  });

  it.each([
    ['unsafe issuance URL', { issuanceUrl: 'http://public.example/issue' }],
    ['unsafe recovery URL', { recoveryUrl: 'file:///private/recover' }],
  ] as const)('rejects %s before registry mutation', async (_name, patch) => {
    const h = fixture();
    await expect(h.service.configure({ network: NETWORK, selector: 0, patch }))
      .rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' });
    expect(h.registry.updateSettings).not.toHaveBeenCalled();
  });

  it('refuses to enable an unconfigured provider and can disable a non-default provider', async () => {
    const h = fixture();
    await expect(h.service.setEnabled({ network: NETWORK, selector: 2, enabled: true }))
      .rejects.toMatchObject({ code: 'PROVIDER_NOT_CONFIGURED' });
    await expect(h.service.setEnabled({ network: NETWORK, selector: 2, enabled: false }))
      .resolves.toMatchObject({ providers: expect.arrayContaining([expect.objectContaining({ index: 2, enabled: false })]) });
  });

  it.each([
    [{ enabled: false }, 'PROVIDER_NOT_CONFIGURED', '--issuance', '--recovery'],
    [{ issuanceUrl: 'https://idp.example/issue', enabled: false }, 'RECOVERY_NOT_CONFIGURED', '--recovery', undefined],
    [{ recoveryUrl: 'https://idp.example/recover', enabled: false }, 'ISSUANCE_NOT_CONFIGURED', '--issuance', undefined],
  ] as const)('reports a specific static configuration diagnostic', async (configuration, code, hint, absentHint) => {
    const h = fixture(settings({ providers: { '2': configuration }, defaultIdentityProvider: undefined }));
    const error = await h.service.setEnabled({ network: NETWORK, selector: 2, enabled: true })
      .catch((failure: unknown) => failure) as Error & { code: string };
    expect(error.code).toBe(code);
    expect(error.message).toContain(hint);
    if (absentHint !== undefined) expect(error.message).toContain(absentHint);
    if (code === 'PROVIDER_NOT_CONFIGURED') expect(error.message).toContain('configure');
    expect(error.message).not.toContain('https://');
    expect(h.get().settings).toEqual(settings({ providers: { '2': configuration }, defaultIdentityProvider: undefined }));
  });

  it('creates a disabled settings entry when disabling an inventoried unconfigured provider', async () => {
    const h = fixture(settings({ providers: {}, defaultIdentityProvider: undefined }));
    await h.service.setEnabled({ network: NETWORK, selector: 2, enabled: false });
    expect(h.get().settings.providers['2']).toEqual({ enabled: false });
  });

  it('preserves a known provider error from refresh and sanitizes an unknown node failure', async () => {
    const known = fixture();
    const knownFailure = new (await import('../../src/core/providers/error.js')).IdentityProviderError('INVALID_NETWORK');
    known.readNodeContext.mockRejectedValue(knownFailure);
    await expect(known.service.refresh({ network: NETWORK })).rejects.toBe(knownFailure);

    const unknown = fixture();
    unknown.readNodeContext.mockRejectedValue(new Error('/private/node diagnostics'));
    await expect(unknown.service.refresh({ network: NETWORK })).rejects.toMatchObject({ code: 'NODE_FAILED' });
    expect(unknown.get()).toEqual({ inventory: inventory(), settings: settings() });
  });
});
