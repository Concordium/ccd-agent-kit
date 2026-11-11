import {
  IdentitySourceError, deriveIdentitySourceId, resolveIdentitySource,
  type IdentitySourceRecord, type IdentitySourceRegistry, type IdentitySourceRegistryDocument,
} from '@ccd-agent-kit/config-utils';
import { describe,expect,it,vi } from 'vitest';
import { createIdentitySourceService } from '../../src/core/sources/service.js';
import type { IdentitySourceBackendInspection } from '../../src/core/sources/types.js';
import {
OTHER_ROOT_PUBLIC_KEY,
OTHER_SOURCE_ID,
ROOT_PUBLIC_KEY,
SERIAL,
SOURCE_ID,
fakeSourceBackend,
otherSourceRecord,
presentInspection,
sourceRecord,
} from '../sourceHelpers.js';



function fakeRegistry(initial: IdentitySourceRegistryDocument = { version: 1, sources: {} }): IdentitySourceRegistry {
  const document = structuredClone(initial);
  return {
    read: vi.fn(async () => structuredClone(document)),
    enroll: vi.fn(async (record: IdentitySourceRecord) => {
      const id = deriveIdentitySourceId(record.rootPublicKey, record.recipeVersion);
      document.sources[id] = structuredClone(record);
      return { id, ...structuredClone(record) };
    }),
    setDefault: vi.fn(async (source: string) => {
      const [id, record] = resolveIdentitySource(document, source);
      document.defaultSourceId = id;
      return { id, ...structuredClone(record) };
    }),
  } as unknown as IdentitySourceRegistry;
}

function fixture(inspection: IdentitySourceBackendInspection = presentInspection()) {
  const fake = fakeSourceBackend(inspection);
  const registry = fakeRegistry();
  const service = createIdentitySourceService({ registry, backends: [fake.backend], refresh: async () => undefined });
  return { ...fake, registry, service };
}

describe('backend-neutral identity-source service', () => {
  it('delegates explicit refresh to the configured lifecycle callback', async () => {
    const refresh = vi.fn(async () => undefined);
    const h = fixture();
    const service = createIdentitySourceService({ registry: h.registry, backends: [h.backend], refresh });

    await expect(service.refresh()).resolves.toBeUndefined();

    expect(refresh).toHaveBeenCalledOnce();
    expect(h.backend.inspect).not.toHaveBeenCalled();
  });

  it('returns cloned records for every source without hardware access or availability projection', async () => {
    const h = fixture();
    await h.registry.enroll(sourceRecord());
    await h.registry.enroll(otherSourceRecord());
    await h.registry.setDefault(SOURCE_ID);
    const records = await h.service.records();
    expect(records).toHaveLength(2);
    expect(records).toEqual(expect.arrayContaining([
      { id: SOURCE_ID, ...sourceRecord() },
      { id: OTHER_SOURCE_ID, ...otherSourceRecord() },
    ]));
    expect(h.backend.inspect).not.toHaveBeenCalled();
    expect(h.backend.createAgreement).not.toHaveBeenCalled();
    records[0]!.id = OTHER_SOURCE_ID;
    records[0]!.label = 'mutated';
    records[0]!.rootPublicKey = OTHER_ROOT_PUBLIC_KEY;
    records[0]!.backends[0]!.locations[0]!.serial = '0';
    await expect(h.registry.read()).resolves.toEqual({
      version: 1,
      defaultSourceId: SOURCE_ID,
      sources: { [SOURCE_ID]: sourceRecord(), [OTHER_SOURCE_ID]: otherSourceRecord() },
    });
    await expect(h.service.records()).resolves.toEqual(expect.arrayContaining([
      { id: SOURCE_ID, ...sourceRecord() },
      { id: OTHER_SOURCE_ID, ...otherSourceRecord() },
    ]));
  });

  it('propagates the catalog producer error without touching a backend', async () => {
    const h = fixture();
    vi.mocked(h.registry.read).mockRejectedValueOnce(new IdentitySourceError('STORAGE_FAILED'));

    await expect(h.service.records()).rejects.toMatchObject({ code: 'STORAGE_FAILED' });
    expect(h.backend.inspect).not.toHaveBeenCalled();
    expect(h.backend.createAgreement).not.toHaveBeenCalled();
  });

  it.each([
    ['unlocked', undefined], ['locked', undefined], ['unlocked', 'always'], ['locked', 'never'],
  ] as const)('projects generic backend authorization %s independently of optional PIN detail %s', async (authorization, pinPolicy) => {
    const h = fixture({
      status: 'present', rootPublicKey: ROOT_PUBLIC_KEY, authorization,
      ...(pinPolicy === undefined ? {} : { pinPolicy }),
    });
    await h.registry.enroll(sourceRecord());
    const result = await h.service.inspect('primary');
    expect(result).toMatchObject({ availability: authorization });
    if (pinPolicy === undefined) expect(result).not.toHaveProperty('pinPolicy');
    else expect(result).toHaveProperty('pinPolicy', pinPolicy);
    expect(result).not.toHaveProperty('touchPolicy');
  });

  it('requires generic authorization and compares the public key without interpreting PIV PIN policy', async () => {
    const fake = fakeSourceBackend({
      status: 'present', rootPublicKey: ROOT_PUBLIC_KEY, authorization: 'unlocked', pinPolicy: 'always',
    }, 'generic-hardware');
    const registry = fakeRegistry();
    const service = createIdentitySourceService({ registry, backends: [fake.backend], refresh: async () => undefined });
    await registry.enroll(sourceRecord({ backends: [{ backend: 'generic-hardware', locations: [{ path: ['A', 1] }] }] }));

    await expect(service.inspect('primary')).resolves.toMatchObject({
      availability: 'unlocked', rootPublicKey: ROOT_PUBLIC_KEY, pinPolicy: 'always',
    });
    fake.backend.inspect.mockResolvedValue({
      status: 'present', rootPublicKey: OTHER_ROOT_PUBLIC_KEY, authorization: 'unlocked', pinPolicy: 'never',
    });
    await expect(service.inspect('primary')).resolves.toMatchObject({
      availability: 'unavailable', reason: 'ROOT_MISMATCH',
    });
  });

  it('continues ordered inspection after an unavailable or mismatched candidate and selects a pinned match', async () => {
    const h = fixture();
    await h.registry.enroll(sourceRecord({
      backends: [{ backend: 'yubikey-piv', locations: [
        { serial: '11111111' }, { serial: '22222222' }, { serial: SERIAL },
      ] }],
    }));
    h.backend.inspect
      .mockResolvedValueOnce({ status: 'unavailable', reason: 'DEVICE_MISSING' })
      .mockResolvedValueOnce(presentInspection({ rootPublicKey: OTHER_ROOT_PUBLIC_KEY }))
      .mockResolvedValueOnce(presentInspection({ authorization: 'locked' }));

    await expect(h.service.inspect('primary')).resolves.toMatchObject({ availability: 'locked' });
    expect(h.backend.inspect.mock.calls.map(([locator]) => locator)).toEqual([
      { serial: '11111111' }, { serial: '22222222' }, { serial: SERIAL },
    ]);
  });

  it('tries ordered matching agreement candidates and skips locked candidates without a PIN callback', async () => {
    const h = fixture();
    await h.registry.enroll(sourceRecord({
      backends: [{ backend: 'yubikey-piv', locations: [
        { serial: '11111111' }, { serial: '22222222' }, { serial: SERIAL },
      ] }],
    }));
    h.backend.inspect
      .mockResolvedValueOnce(presentInspection({ rootPublicKey: OTHER_ROOT_PUBLIC_KEY }))
      .mockResolvedValueOnce(presentInspection({ authorization: 'locked' }))
      .mockResolvedValueOnce(presentInspection());
    const succeeded = { agree: vi.fn(async () => ({ publicKey: Buffer.from(ROOT_PUBLIC_KEY, 'hex'), sharedSecret: Buffer.alloc(32, 1) })) };
    h.backend.createAgreement.mockReturnValueOnce(succeeded);

    const agreement = await h.service.createAgreement('primary');
    await expect(agreement.agree(Buffer.from(OTHER_ROOT_PUBLIC_KEY, 'hex'))).resolves.toMatchObject({ sharedSecret: Buffer.alloc(32, 1) });
    expect(h.backend.createAgreement.mock.calls.map(([input]) => input.locator)).toEqual([
      { serial: SERIAL },
    ]);
    expect(succeeded.agree).toHaveBeenCalledOnce();
  });

  it('gates inspection and both new and existing agreements when backend policy changes', async () => {
    const h = fixture();
    let enabled = true;
    const service = createIdentitySourceService({
      registry: h.registry,
      backends: [h.backend],
      isBackendEnabled: () => enabled,
      refresh: async () => undefined,
    });
    await h.registry.enroll(sourceRecord());
    const agreement = await service.createAgreement('primary');
    h.backend.inspect.mockClear();
    vi.mocked(h.agreement.agree).mockClear();

    enabled = false;
    await expect(service.inspect('primary')).resolves.toMatchObject({
      availability: 'unavailable', reason: 'UNSUPPORTED_BACKEND',
    });
    await expect(service.createAgreement('primary')).rejects.toMatchObject({ code: 'INVALID_SOURCE' });
    await expect(agreement.agree(Buffer.from(OTHER_ROOT_PUBLIC_KEY, 'hex')))
      .rejects.toMatchObject({ code: 'INVALID_SOURCE' });
    expect(h.backend.inspect).not.toHaveBeenCalled();
    expect(h.backend.createAgreement).toHaveBeenCalledOnce();
    expect(h.agreement.agree).not.toHaveBeenCalled();

    enabled = true;
    h.backend.inspect.mockImplementationOnce(async () => {
      enabled = false;
      return presentInspection();
    });
    await expect(service.inspect('primary')).resolves.toMatchObject({
      availability: 'unavailable', reason: 'UNSUPPORTED_BACKEND',
    });
  });

  it('tries the next ordered unlocked agreement candidate after the first matching candidate fails', async () => {
    const h = fixture();
    await h.registry.enroll(sourceRecord({
      backends: [{ backend: 'yubikey-piv', locations: [{ serial: '11111111' }, { serial: SERIAL }] }],
    }));
    h.backend.inspect.mockResolvedValue(presentInspection());
    const failed = { agree: vi.fn(async () => { throw new Error('device disconnected'); }) };
    const result = { publicKey: Buffer.from(ROOT_PUBLIC_KEY, 'hex'), sharedSecret: Buffer.alloc(32, 2) };
    const succeeded = { agree: vi.fn(async () => result) };
    h.backend.createAgreement.mockReturnValueOnce(failed).mockReturnValueOnce(succeeded);

    const agreement = await h.service.createAgreement('primary');
    await expect(agreement.agree(Buffer.from(OTHER_ROOT_PUBLIC_KEY, 'hex'))).resolves.toEqual(result);
    expect(failed.agree).toHaveBeenCalledOnce();
    expect(succeeded.agree).toHaveBeenCalledOnce();
  });

  it('keeps a locked matching candidate in order only when a PIN callback is available', async () => {
    const h = fixture();
    await h.registry.enroll(sourceRecord({
      backends: [{ backend: 'yubikey-piv', locations: [{ serial: '11111111' }, { serial: SERIAL }] }],
    }));
    h.backend.inspect
      .mockResolvedValueOnce(presentInspection({ authorization: 'locked' }))
      .mockResolvedValueOnce(presentInspection());
    const promptPin = vi.fn(async () => '123456');
    const locked = { agree: vi.fn() };
    const unlocked = { agree: vi.fn() };
    h.backend.createAgreement.mockReturnValueOnce(locked).mockReturnValueOnce(unlocked);

    await h.service.createAgreement('primary', { promptPin });
    expect(h.backend.createAgreement.mock.calls.map(([input]) => input.locator)).toEqual([
      { serial: '11111111' }, { serial: SERIAL },
    ]);
    expect(h.backend.createAgreement.mock.calls.every(([input]) => input.promptPin === promptPin)).toBe(true);
  });

  it.each([
    ['wrong key', presentInspection({ rootPublicKey: OTHER_ROOT_PUBLIC_KEY }), 'ROOT_MISMATCH'],
    ['missing device', { status: 'unavailable', reason: 'DEVICE_MISSING' }, 'DEVICE_MISSING'],
    ['busy device', { status: 'unavailable', reason: 'DEVICE_BUSY' }, 'DEVICE_BUSY'],
    ['unreadable device', { status: 'unavailable', reason: 'UNREADABLE' }, 'UNREADABLE'],
  ] satisfies Array<[string, IdentitySourceBackendInspection, string]>)('projects %s as unavailable/%s', async (_label, inspection, reason) => {
    const h = fixture(inspection);
    await h.registry.enroll(sourceRecord());
    await expect(h.service.inspect('primary')).resolves.toMatchObject({ availability: 'unavailable', reason });
  });

  it('treats an unknown stored backend as unavailable without plugin loading or registry reset', async () => {
    const h = fixture();
    await h.registry.enroll(sourceRecord({ backends: [{ backend: 'future-device', locations: [{ port: 'A' }] }] }));
    await expect(h.service.inspect('primary')).resolves.toMatchObject({
      label: 'primary', availability: 'unavailable', reason: 'UNSUPPORTED_BACKEND',
    });
    expect(h.backend.inspect).not.toHaveBeenCalled();
    await expect(h.registry.read()).resolves.toMatchObject({
      sources: { [SOURCE_ID]: { backends: [{ backend: 'future-device' }] } },
    });
  });

  it('lists label-sorted reduced snapshots with stable IDs and bare persisted spelling', async () => {
    const fake = fakeSourceBackend();
    const registry = fakeRegistry();
    const service = createIdentitySourceService({ registry, backends: [fake.backend], refresh: async () => undefined });
    await registry.enroll(sourceRecord({ label: '@zeta' }));
    await registry.enroll(otherSourceRecord({ label: 'Alpha' }));
    await registry.setDefault('zeta');
    const result = await service.list();
    expect(result).toEqual([
      { id: OTHER_SOURCE_ID, label: 'Alpha', isDefault: false, availability: 'unavailable' },
      { id: SOURCE_ID, label: 'zeta', isDefault: true, availability: 'unlocked' },
    ]);
  });

  it('pins agreement creation to the enrolled locator and key while keeping availability read-only', async () => {
    const h = fixture();
    await h.registry.enroll(sourceRecord());
    await h.service.inspect('primary');
    expect(h.backend.createAgreement).not.toHaveBeenCalled();
    const promptPin = vi.fn(async () => '123456');
    const agreement = await h.service.createAgreement('primary', { promptPin });
    await agreement.agree(Buffer.from(OTHER_ROOT_PUBLIC_KEY, 'hex'));
    expect(h.agreement.agree).toHaveBeenCalledOnce();
    expect(h.backend.createAgreement).toHaveBeenCalledExactlyOnceWith({
      sourceId: SOURCE_ID, locator: { serial: SERIAL }, expectedPublicKey: Buffer.from(ROOT_PUBLIC_KEY, 'hex'), promptPin,
    });
  });

  it('omits an absent PIN callback from agreement delegation', async () => {
    const h = fixture();
    await h.registry.enroll(sourceRecord());
    const agreement = await h.service.createAgreement('primary');
    await agreement.agree(Buffer.from(OTHER_ROOT_PUBLIC_KEY, 'hex'));
    expect(h.agreement.agree).toHaveBeenCalledOnce();
    expect(h.backend.createAgreement).toHaveBeenCalledExactlyOnceWith({
      sourceId: SOURCE_ID, locator: { serial: SERIAL }, expectedPublicKey: Buffer.from(ROOT_PUBLIC_KEY, 'hex'),
    });
  });

  it('rejects missing sources and unsupported stored agreement backends', async () => {
    const h = fixture();
    await expect(h.service.inspect('missing')).rejects.toMatchObject({ code: 'SOURCE_NOT_FOUND' });
    await expect(h.service.createAgreement('missing')).rejects.toMatchObject({ code: 'SOURCE_NOT_FOUND' });
    await h.registry.enroll(sourceRecord({ backends: [{ backend: 'future-device', locations: [{ port: 'A' }] }] }));
    await expect(h.service.createAgreement('primary')).rejects.toMatchObject({ code: 'INVALID_SOURCE' });
    expect(h.backend.createAgreement).not.toHaveBeenCalled();
  });

  it('keeps native source IDs exact but trims and case-folds local-label selection', async () => {
    const h = fixture();
    await h.registry.enroll(sourceRecord());
    await expect(h.service.inspect(SOURCE_ID)).resolves.toMatchObject({ id: SOURCE_ID, label: 'primary' });
    await expect(h.service.inspect('  PRIMARY  ')).resolves.toMatchObject({ id: SOURCE_ID, label: 'primary' });
    await expect(h.service.createAgreement(SOURCE_ID)).resolves.toHaveProperty('agree');
    await expect(h.service.createAgreement('PrImArY')).resolves.toHaveProperty('agree');
    await expect(h.service.inspect(SOURCE_ID.toUpperCase())).rejects.toMatchObject({ code: 'SOURCE_NOT_FOUND' });
  });

  it('resolves explicit or configured-default sources without hardware inspection', async () => {
    const h = fixture();
    await h.registry.enroll(sourceRecord());
    await expect(h.service.resolve()).rejects.toMatchObject({ code: 'NO_DEFAULT_SOURCE' });
    await expect(h.service.resolve('missing')).rejects.toMatchObject({ code: 'SOURCE_NOT_FOUND' });
    await h.registry.setDefault(SOURCE_ID);
    await expect(h.service.resolve()).resolves.toEqual({ id: SOURCE_ID, ...sourceRecord() });
    await expect(h.service.resolve(' PRIMARY ')).resolves.toEqual({ id: SOURCE_ID, ...sourceRecord() });
    expect(h.backend.inspect).not.toHaveBeenCalled();
    expect(h.backend.createAgreement).not.toHaveBeenCalled();
  });

  it('rejects malformed explicit selectors without touching hardware', async () => {
    const h = fixture();
    await h.registry.enroll(sourceRecord());
    await expect(h.service.resolve('not a selector')).rejects.toMatchObject({ code: 'SOURCE_NOT_FOUND' });
    expect(h.backend.inspect).not.toHaveBeenCalled();
  });
});
