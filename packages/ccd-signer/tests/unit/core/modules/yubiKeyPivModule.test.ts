import { beforeEach, describe, expect, it, vi } from 'vitest';

let yubiKeyPivModule: typeof import('../../../../src/core/modules/yubiKeyPivModule.js')['yubiKeyPivModule'];
import type {
  GenerateYubiKeyInput,
  GenerateYubiKeyResult,
  ImportYubiKeyInput,
  ImportYubiKeyResult,
  SignYubiKeyDigestInput,
  WatchYubiKeyDevicesInput,
  YubiKeyDeviceSummary,
  YubiKeyDeviceWatcher,
  YubiKeyInspection,
  YubiKeyService,
} from '@ccd-agent-kit/piv-utils';
import { TEST_PUBLIC_KEY_AB as KEY_A, TEST_PUBLIC_KEY_CD as KEY_C, testEd25519PublicKey } from '../../../helpers/ed25519.js';

const KEY_B = testEd25519PublicKey('bb');

describe('yubiKeyPivModule', () => {
  beforeEach(async () => {
    vi.resetModules();
    ({ yubiKeyPivModule } = await import('../../../../src/core/modules/yubiKeyPivModule.js'));
  });
  it('passes device PIN policy and interactive PIN callbacks to the YubiKey service', async () => {
    const promptPin = vi.fn(async () => '123456');
    const service = new FakeYubiKeyService();

    await expect(
      yubiKeyPivModule.signEd25519Digest({
        backendEntry: {
          backend: { devices: [{ kind: 'yubikey', pinPolicy: 'once', serial: '12345678', slot: '9c' }] },
          createdAt: '2026-01-01T00:00:00.000Z',
          signingModule: 'yubikey-piv',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
        digest: new Uint8Array([1, 2, 3]),
        publicKey: KEY_A,
        services: { yubiKeyInteraction: { promptPin }, yubiKeyService: service },
      }),
    ).resolves.toBe('bb'.repeat(64));

    expect(service.signInputs).toEqual([
      expect.objectContaining({
        devices: [{ kind: 'yubikey', pinPolicy: 'once', serial: '12345678', slot: '9c' }],
        interaction: { promptPin },
      }),
    ]);
    await expect(yubiKeyPivModule.signEd25519Digest({
      backendEntry: { ...yubiKeyBackend('12345678', '9c', 'once'), backend: {} },
      digest: new Uint8Array(), publicKey: KEY_A,
    })).rejects.toThrow('malformed backend metadata');
  });

  it('classifies present and missing YubiKey locators during module activation', async () => {
    const present = yubiKeyBackend('11111111', '9c', 'once');
    const neverPin = yubiKeyBackend('11111111', '82', 'never');
    const missing = yubiKeyBackend('22222222', '9c', 'once');
    const notifyChanged = vi.fn();
    const service = new FakeYubiKeyService({
      devices: [{ readerName: 'YubiKey', serial: '11111111' }],
      inspections: {
        '11111111': {
          ed25519Supported: true,
          readerName: 'YubiKey',
          serial: '11111111',
          pinStatus: { status: 'verified' },
          slots: [
            { algorithm: 'Ed25519', publicKey: KEY_A, slot: '9c', status: 'occupied' },
            { algorithm: 'Ed25519', publicKey: KEY_B, slot: '82', status: 'occupied' },
          ],
          touchPolicySupported: 'unknown',
        },
      },
    });

    expect(yubiKeyPivModule.getBackendStatus?.(present, 'Ed25519')).toBe('unknown');
    const runtime = await yubiKeyPivModule.activate?.({
      backends: [
        { backendEntry: present, publicKey: KEY_A, scheme: 'Ed25519' },
        { backendEntry: neverPin, publicKey: KEY_B, scheme: 'Ed25519' },
        { backendEntry: missing, publicKey: KEY_C, scheme: 'Ed25519' },
      ],
      notifyChanged,
      services: { yubiKeyService: service },
    });
    await tick();

    expect(yubiKeyPivModule.getBackendStatus?.(present, 'Ed25519')).toBe('unlocked');
    expect(yubiKeyPivModule.getBackendStatus?.(neverPin, 'Ed25519')).toBe('unlocked');
    expect(yubiKeyPivModule.getBackendStatus?.(missing, 'Ed25519')).toBe('unavailable');
    expect(service.listAndInspectInputs).toEqual([['11111111', '22222222']]);
    expect(notifyChanged).toHaveBeenCalledOnce();

    await runtime?.refresh?.([
      { backendEntry: present, publicKey: KEY_A, scheme: 'Ed25519' },
      { backendEntry: neverPin, publicKey: KEY_B, scheme: 'Ed25519' },
      { backendEntry: missing, publicKey: KEY_C, scheme: 'Ed25519' },
    ]);
    expect(notifyChanged).toHaveBeenCalledOnce();

    service.inspections['11111111']!.pinStatus = { status: 'required', retries: 3 };
    await runtime?.refresh?.([
      { backendEntry: present, publicKey: KEY_A, scheme: 'Ed25519' },
      { backendEntry: neverPin, publicKey: KEY_B, scheme: 'Ed25519' },
      { backendEntry: missing, publicKey: KEY_C, scheme: 'Ed25519' },
    ]);
    expect(yubiKeyPivModule.getBackendStatus?.(present, 'Ed25519')).toBe('locked');
    expect(notifyChanged).toHaveBeenCalledTimes(2);
  });

  it('uses the combined YubiKey list-and-inspect service once per refresh and skips unreferenced devices', async () => {
    const backend = yubiKeyBackend('11111111', '9c', 'once');
    const service = new FakeYubiKeyService({
      devices: [{ readerName: 'YubiKey one', serial: '11111111' }, { readerName: 'YubiKey two', serial: '22222222' }],
      inspections: {
        '11111111': {
          ed25519Supported: true,
          readerName: 'YubiKey one',
          serial: '11111111',
          pinStatus: { status: 'required', retries: 3 },
          slots: [{ algorithm: 'Ed25519', publicKey: KEY_A, slot: '9c', status: 'occupied' }],
          touchPolicySupported: 'unknown',
        },
      },
    });

    await yubiKeyPivModule.activate?.({
      backends: [{ backendEntry: backend, publicKey: KEY_A, scheme: 'Ed25519' }],
      services: { yubiKeyService: service },
    });
    await tick();

    expect(service.listCount).toBe(0);
    expect(service.inspectInputs).toEqual([]);
    expect(service.listAndInspectInputs).toEqual([['11111111']]);
    expect(yubiKeyPivModule.getBackendStatus?.(backend, 'Ed25519')).toBe('locked');
  });

  it('keeps generic PIV locators unknown instead of unavailable during YubiKey refresh', async () => {
    const backend = {
      backend: { devices: [{ kind: 'generic_piv' as const, pinPolicy: 'once', slot: '9c' }] },
      createdAt: '2026-01-01T00:00:00.000Z',
      signingModule: 'yubikey-piv',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };

    await yubiKeyPivModule.activate?.({
      backends: [{ backendEntry: backend, publicKey: KEY_A, scheme: 'Ed25519' }],
      services: { yubiKeyService: new FakeYubiKeyService() },
    });
    await tick();

    expect(yubiKeyPivModule.getBackendStatus?.(backend, 'Ed25519')).toBe('unknown');
  });

  it('refreshes YubiKey status after live device-change notifications', async () => {
    const backend = yubiKeyBackend('55555555', '9c', 'once');
    const service = new FakeYubiKeyService();

    await yubiKeyPivModule.activate?.({
      backends: [{ backendEntry: backend, publicKey: KEY_A, scheme: 'Ed25519' }],
      services: { yubiKeyService: service },
    });
    await tick();
    expect(yubiKeyPivModule.getBackendStatus?.(backend, 'Ed25519')).toBe('unavailable');

    service.devices = [{ readerName: 'YubiKey', serial: '55555555' }];
    service.inspections = {
      '55555555': {
        ed25519Supported: true,
        readerName: 'YubiKey',
        serial: '55555555',
        pinStatus: { status: 'required', retries: 3 },
        slots: [{ algorithm: 'Ed25519', publicKey: KEY_A, slot: '9c', status: 'occupied' }],
        touchPolicySupported: 'unknown',
      },
    };
    service.emitChange();
    await tick();

    expect(yubiKeyPivModule.getBackendStatus?.(backend, 'Ed25519')).toBe('locked');
  });

  it('queues another refresh when device changes arrive during a running refresh', async () => {
    const service = new FakeYubiKeyService();
    const refreshBlocker = deferred<void>();
    service.listDelay = refreshBlocker.promise;

    await yubiKeyPivModule.activate?.({ backends: [], services: { yubiKeyService: service } });
    await tick();
    expect(service.listAndInspectInputs).toHaveLength(1);

    service.emitChange();
    refreshBlocker.resolve();
    await tick();
    await tick();

    expect(service.listAndInspectInputs).toHaveLength(2);
  });

  it('refreshes YubiKey status after watcher error notifications', async () => {
    const service = new FakeYubiKeyService();

    await yubiKeyPivModule.activate?.({ backends: [], services: { yubiKeyService: service } });
    await tick();
    const before = service.listAndInspectInputs.length;

    service.emitError();
    await tick();

    expect(service.listAndInspectInputs.length).toBeGreaterThan(before);
  });

  it('marks present YubiKey locators unavailable when slot public keys do not match', async () => {
    const backend = yubiKeyBackend('77777777', '9c', 'once');
    const service = new FakeYubiKeyService({
      devices: [{ readerName: 'YubiKey', serial: '77777777' }],
      inspections: {
        '77777777': {
          ed25519Supported: true,
          readerName: 'YubiKey',
          serial: '77777777',
          pinStatus: { status: 'required', retries: 3 },
          slots: [{ algorithm: 'Ed25519', publicKey: KEY_B, slot: '9c', status: 'occupied' }],
          touchPolicySupported: 'unknown',
        },
      },
    });

    await yubiKeyPivModule.activate?.({
      backends: [{ backendEntry: backend, publicKey: KEY_A, scheme: 'Ed25519' }],
      services: { yubiKeyService: service },
    });
    await tick();

    expect(yubiKeyPivModule.getBackendStatus?.(backend, 'Ed25519')).toBe('unavailable');
  });

  it('marks activated YubiKey backends unknown when watcher setup fails', async () => {
    const backend = yubiKeyBackend('88888888', '9c', 'once');
    const notifyChanged = vi.fn();
    const service = new FakeYubiKeyService({ listError: new Error('list failed'), watchError: new Error('watch failed') });

    await yubiKeyPivModule.activate?.({
      backends: [{ backendEntry: backend, publicKey: KEY_A, scheme: 'Ed25519' }],
      notifyChanged,
      services: { yubiKeyService: service },
    });
    await tick();

    expect(yubiKeyPivModule.getBackendStatus?.(backend, 'Ed25519')).toBe('unknown');
    expect(notifyChanged).toHaveBeenCalled();
  });

  it('marks activated YubiKey backends unknown when live refresh errors', async () => {
    const backend = yubiKeyBackend('66666666', '9c', 'once');
    const service = new FakeYubiKeyService({
      devices: [{ readerName: 'YubiKey', serial: '66666666' }],
      inspections: {
        '66666666': {
          ed25519Supported: true,
          readerName: 'YubiKey',
          serial: '66666666',
          pinStatus: { status: 'required', retries: 3 },
          slots: [{ algorithm: 'Ed25519', publicKey: KEY_A, slot: '9c', status: 'occupied' }],
          touchPolicySupported: 'unknown',
        },
      },
    });

    await yubiKeyPivModule.activate?.({
      backends: [{ backendEntry: backend, publicKey: KEY_A, scheme: 'Ed25519' }],
      services: { yubiKeyService: service },
    });
    await tick();
    expect(yubiKeyPivModule.getBackendStatus?.(backend, 'Ed25519')).toBe('locked');

    service.listError = new Error('pcsc unavailable');
    service.emitChange();
    await tick();

    expect(yubiKeyPivModule.getBackendStatus?.(backend, 'Ed25519')).toBe('unknown');
  });

  it('closes live YubiKey watchers returned during activation', async () => {
    const service = new FakeYubiKeyService();
    const runtime = await yubiKeyPivModule.activate?.({ backends: [], services: { yubiKeyService: service } });

    await runtime?.close();

    expect(service.watchCloseCount).toBe(1);
  });

  it('lets the owning runtime close the device service while a refresh remains pending', async () => {
    const backend = yubiKeyBackend('99999999', '9c', 'once');
    const service = new FakeYubiKeyService({
      devices: [{ readerName: 'YubiKey', serial: '99999999' }],
      inspections: {
        '99999999': {
          ed25519Supported: true,
          readerName: 'YubiKey',
          serial: '99999999',
          pinStatus: { status: 'required', retries: 3 },
          slots: [{ algorithm: 'Ed25519', publicKey: KEY_A, slot: '9c', status: 'occupied' }],
          touchPolicySupported: 'unknown',
        },
      },
    });
    const refreshBlocker = deferred<void>();
    service.listDelay = refreshBlocker.promise;
    const runtime = await yubiKeyPivModule.activate?.({
      backends: [{ backendEntry: backend, publicKey: KEY_A, scheme: 'Ed25519' }],
      services: { yubiKeyService: service },
    });
    const shutdown = (async () => {
      await runtime?.close();
      await service.close();
    })();

    try {
      await tick();
      expect(service.watchCloseCount).toBe(1);
      expect(service.closeCount).toBe(1);
    } finally {
      refreshBlocker.resolve();
      await shutdown;
    }
    await tick();
    expect(yubiKeyPivModule.getBackendStatus?.(backend, 'Ed25519')).toBe('unknown');
  });

});

class FakeYubiKeyService implements YubiKeyService {
  public signInputs: SignYubiKeyDigestInput[] = [];
  public devices: YubiKeyDeviceSummary[];
  public inspections: Record<string, YubiKeyInspection>;
  public listCount = 0;
  public inspectInputs: Array<string | undefined> = [];
  public listAndInspectInputs: Array<readonly string[] | undefined> = [];
  public listDelay?: Promise<void>;
  public listError?: Error;
  public closeCount = 0;
  public watchCloseCount = 0;
  private watcherInput?: WatchYubiKeyDevicesInput;

  constructor(private readonly options: {
    devices?: YubiKeyDeviceSummary[];
    inspections?: Record<string, YubiKeyInspection>;
    listError?: Error;
    watchError?: Error;
  } = {}) {
    this.devices = options.devices ?? [];
    this.inspections = options.inspections ?? {};
    this.listError = options.listError;
  }

  public emitChange(): void {
    this.watcherInput?.onChanged();
  }

  public emitError(): void {
    this.watcherInput?.onError?.(new Error('watcher error'));
  }

  public async listDevices(): Promise<YubiKeyDeviceSummary[]> {
    this.listCount += 1;
    await this.listDelay;
    if (this.listError !== undefined) throw this.listError;
    return this.devices;
  }

  public async inspectDevice(serial?: string): Promise<YubiKeyInspection> {
    this.inspectInputs.push(serial);
    const inspection = serial === undefined ? undefined : this.inspections[serial];
    if (inspection === undefined) throw new Error('not used');
    return inspection;
  }

  public async listAndInspectDeviceKeys(serials?: readonly string[]): Promise<{ devices: YubiKeyDeviceSummary[]; inspections: YubiKeyInspection[] }> {
    this.listAndInspectInputs.push(serials === undefined ? undefined : [...serials]);
    await this.listDelay;
    if (this.listError !== undefined) throw this.listError;
    const selected = new Set(serials);
    return {
      devices: this.devices,
      inspections: Object.entries(this.inspections)
        .filter(([serial]) => serials === undefined || selected.has(serial))
        .map(([, inspection]) => inspection),
    };
  }

  public async watchDevices(input: WatchYubiKeyDevicesInput): Promise<YubiKeyDeviceWatcher> {
    if (this.options.watchError !== undefined) throw this.options.watchError;
    this.watcherInput = input;
    return { close: () => { this.watchCloseCount += 1; } };
  }

  public close(): void {
    this.closeCount += 1;
  }

  public async generateEd25519Key(_input: GenerateYubiKeyInput): Promise<GenerateYubiKeyResult> {
    throw new Error('not used');
  }

  public async importEd25519Key(_input: ImportYubiKeyInput): Promise<ImportYubiKeyResult> {
    throw new Error('not used');
  }

  public async unlockDevice(input: { serial?: string }): Promise<{ readerName: string; serial: string }> {
    return { readerName: 'YubiKey', serial: input.serial ?? '12345678' };
  }

  public async signEd25519Digest(input: SignYubiKeyDigestInput): Promise<{ signatureHex: string }> {
    this.signInputs.push(input);
    return { signatureHex: 'bb'.repeat(64) };
  }
}

function yubiKeyBackend(serial: string, slot: string, pinPolicy: string) {
  return {
    backend: { devices: [{ kind: 'yubikey' as const, pinPolicy, serial, slot }] },
    createdAt: '2026-01-01T00:00:00.000Z',
    signingModule: 'yubikey-piv',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}
