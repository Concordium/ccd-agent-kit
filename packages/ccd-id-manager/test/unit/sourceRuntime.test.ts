import type { IdentitySourceRegistryDocument } from '@ccd-agent-kit/config-utils';
import type {
  IdentitySourceBackend,
  IdentitySourceService,
  IdentitySourceServiceOptions,
} from '../../src/core/sources/types.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OTHER_SOURCE_ID, SOURCE_ID, otherSourceRecord, sourceRecord } from '../sourceHelpers.js';

const mocks = vi.hoisted(() => {
  const state = {
    enabled: true,
    document: { version: 1, sources: {} } satisfies IdentitySourceRegistryDocument,
    serviceOptions: undefined as IdentitySourceServiceOptions | undefined,
    deviceChanged: undefined as (() => void) | undefined,
  };
  const registry = { read: vi.fn(async () => structuredClone(state.document)) };
  const pool = {
    retain: vi.fn(async () => undefined),
    release: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    withCard: vi.fn(),
  };
  const watcher = { close: vi.fn(() => undefined) };
  const transport = {
    watchDevices: vi.fn(async ({ onChanged }: { onChanged: () => void }) => {
      state.deviceChanged = onChanged;
      return watcher;
    }),
  };
  const hardware = { close: vi.fn(async () => undefined) };
  const backend = {
    backend: 'yubikey-piv',
    refresh: vi.fn(async () => undefined),
    retain: vi.fn(async () => undefined),
    inspect: vi.fn(async () => ({ status: 'unavailable' as const, reason: 'DEVICE_MISSING' as const })),
    createAgreement: vi.fn(() => ({ agree: vi.fn() })),
  } satisfies IdentitySourceBackend;
  const service = {
    list: vi.fn(async () => []),
    records: vi.fn(async () => []),
    inspect: vi.fn(async () => { throw new Error('Unexpected service operation'); }),
    resolve: vi.fn(async () => { throw new Error('Unexpected service operation'); }),
    createAgreement: vi.fn(async () => { throw new Error('Unexpected service operation'); }),
    refresh: vi.fn(async () => state.serviceOptions?.refresh()),
    close: vi.fn(async () => state.serviceOptions?.close?.()),
  } satisfies IdentitySourceService;
  return { state, registry, pool, watcher, transport, hardware, backend, service };
});

vi.mock('@ccd-agent-kit/config-utils', async importOriginal => ({
  ...await importOriginal<typeof import('@ccd-agent-kit/config-utils')>(),
  createIdentitySourceRegistry: () => mocks.registry,
  getIdentitySourcesPath: () => '.test-tmp/id-manager/sources.json',
  getConfigDir: () => '.test-tmp/config/ccd-agent-kit',
  YUBIKEY_IDENTITY_SOURCE_BACKEND: 'yubikey-piv',
  isIdentitySourceBackendEnabled: () => mocks.state.enabled,
}));
vi.mock('@ccd-agent-kit/piv-utils', async importOriginal => ({
  ...await importOriginal<typeof import('@ccd-agent-kit/piv-utils')>(),
  createPivTransport: () => mocks.transport,
  createPivSessionPool: () => mocks.pool,
  createIdentityYubiKeyService: () => mocks.hardware,
}));
vi.mock('../../src/core/sources/yubikey.js', () => ({ createYubiKeySourceBackend: () => mocks.backend }));
vi.mock('../../src/core/sources/service.js', () => ({
  createIdentitySourceService: vi.fn((options: IdentitySourceServiceOptions) => {
    mocks.state.serviceOptions = options;
    return mocks.service;
  }),
}));

import { createDefaultIdentitySourceService } from '../../src/core/sources/runtime.js';

describe('runtime identity-source lifecycle', () => {
  function lifecycle(): IdentitySourceServiceOptions {
    const options = mocks.state.serviceOptions;
    if (options === undefined) throw new Error('Runtime lifecycle was not composed');
    return options;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.state.enabled = true;
    mocks.state.deviceChanged = undefined;
    mocks.state.serviceOptions = undefined;
    mocks.state.document = { version: 1, sources: { [SOURCE_ID]: sourceRecord() } };
    mocks.registry.read.mockImplementation(async () => structuredClone(mocks.state.document));
  });

  it('caches initial discovery and refreshes retained devices after reconnect', async () => {
    createDefaultIdentitySourceService({ persistent: true });
    await lifecycle().prepare!();
    await lifecycle().prepare!();
    expect(mocks.pool.retain).toHaveBeenCalledExactlyOnceWith('12345678');
    expect(mocks.backend.refresh).toHaveBeenCalledOnce();

    mocks.state.deviceChanged!();
    await lifecycle().prepare!();
    expect(mocks.backend.refresh).toHaveBeenCalledTimes(2);
    expect(mocks.pool.retain).toHaveBeenCalledTimes(2);
    await lifecycle().close!();
  });

  it('reconciles the latest catalog after a hardware device change', async () => {
    mocks.state.document = {
      version: 1,
      sources: {
        [SOURCE_ID]: sourceRecord(),
        [OTHER_SOURCE_ID]: otherSourceRecord(),
      },
    };
    createDefaultIdentitySourceService({ persistent: true });
    await lifecycle().prepare!();
    mocks.state.document = {
      version: 1,
      sources: { [SOURCE_ID]: sourceRecord() },
    };
    mocks.state.deviceChanged!();
    await lifecycle().prepare!();

    expect(mocks.pool.release).toHaveBeenCalledExactlyOnceWith('87654321');
    expect(mocks.pool.release).not.toHaveBeenCalledWith('12345678');
    expect(mocks.pool.retain).toHaveBeenLastCalledWith('12345678');
    expect(mocks.backend.retain).toHaveBeenLastCalledWith([{ serial: '12345678' }]);
    await lifecycle().close!();
  });

  it('serializes explicit refresh with device reconciliation and uses the latest catalog', async () => {
    const service = createDefaultIdentitySourceService({ persistent: true });
    await lifecycle().prepare!();
    mocks.state.document = {
      version: 1,
      sources: { [OTHER_SOURCE_ID]: otherSourceRecord() },
    };

    mocks.state.deviceChanged!();
    await service.refresh();

    expect(mocks.backend.retain).toHaveBeenLastCalledWith([{ serial: '87654321' }]);
    expect(mocks.pool.release).toHaveBeenCalledWith('12345678');
    await service.close!();
  });

  it('initializes from a refresh request and queues later refreshes', async () => {
    const service = createDefaultIdentitySourceService({ persistent: true });

    await service.refresh();
    expect(mocks.backend.refresh).toHaveBeenCalledOnce();
    await service.refresh();

    expect(mocks.backend.refresh).toHaveBeenCalledTimes(2);
    await service.close!();
  });

  it('does not run queued reconciliation or refresh after close starts', async () => {
    const service = createDefaultIdentitySourceService({ persistent: true });
    await lifecycle().prepare!();
    mocks.state.deviceChanged!();

    await service.close!();
    await service.refresh();

    expect(mocks.backend.refresh).toHaveBeenCalledOnce();
    expect(mocks.pool.retain).toHaveBeenCalledOnce();
  });

  it('retains only string serial locators while forwarding every locator to the backend', async () => {
    mocks.state.document = {
      version: 1,
      sources: {
        [SOURCE_ID]: sourceRecord({
          backends: [{ backend: 'yubikey-piv', locations: [{ slot: '9d' }, { serial: '12345678' }] }],
        }),
      },
    };
    createDefaultIdentitySourceService({ persistent: true });

    await lifecycle().prepare!();

    expect(mocks.pool.retain).toHaveBeenCalledExactlyOnceWith('12345678');
    expect(mocks.backend.retain).toHaveBeenCalledWith([{ slot: '9d' }, { serial: '12345678' }]);
    await lifecycle().close!();
  });

  it('does not retain hardware or start discovery while backend policy is disabled', async () => {
    mocks.state.enabled = false;
    createDefaultIdentitySourceService({ persistent: true });
    await lifecycle().prepare!();
    expect(mocks.pool.retain).not.toHaveBeenCalled();
    expect(mocks.transport.watchDevices).not.toHaveBeenCalled();
    await lifecycle().close!();
  });

  it('closes the device watcher, retained sessions, and hardware', async () => {
    const service = createDefaultIdentitySourceService({ persistent: true });
    await lifecycle().prepare!();

    await service.close!();

    expect(mocks.watcher.close).toHaveBeenCalledOnce();
    expect(mocks.pool.release).toHaveBeenCalledWith('12345678');
    expect(mocks.hardware.close).toHaveBeenCalledOnce();
  });

  it('does not create persistent sessions when persistent mode is omitted', async () => {
    createDefaultIdentitySourceService();
    await lifecycle().prepare!();

    expect(mocks.pool.retain).not.toHaveBeenCalled();
    expect(mocks.pool.release).not.toHaveBeenCalled();
    expect(mocks.backend.refresh).toHaveBeenCalledOnce();
    await lifecycle().close!();
  });
});
