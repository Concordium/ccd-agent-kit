import type { Ed25519PublicKeyHex } from '@ccd-agent-kit/sdk-utils';
import {
  parseYubiKeyPivBackend,
  YUBIKEY_PIV_MODULE_ID,
  type SignerInventoryBackendEntry,
} from '@ccd-agent-kit/config-utils';
import {
  createNativePivYubiKeyService,
  type PivSigningDeviceLocator,
  type YubiKeyPinPolicy,
  type YubiKeyService,
  type YubiKeySigningSlot,
} from '@ccd-agent-kit/piv-utils';
import { type SignerBackendStatus, type SignerModule } from './types.js';

const backendStatus = new Map<string, SignerBackendStatus>();

/** Built-in YubiKey PIV Ed25519 signing module using fresh device PIN status. */
export const yubiKeyPivModule: SignerModule = {
  controls: [],
  defaultEnabled: true,
  id: YUBIKEY_PIV_MODULE_ID,
  isBackendVisible(entry: SignerInventoryBackendEntry): boolean {
    return parseYubiKeyPivBackend(entry.backend) !== undefined;
  },
  getBackendStatus(entry: SignerInventoryBackendEntry): SignerBackendStatus {
    const backend = parseYubiKeyPivBackend(entry.backend);
    if (backend === undefined || backend.devices.length === 0) return 'unavailable';
    const statuses = backend.devices.map(device => backendStatus.get(statusKey(device)) ?? 'unknown');
    if (statuses.includes('unlocked')) return 'unlocked';
    if (statuses.includes('locked')) return 'locked';
    if (statuses.includes('unknown')) return 'unknown';
    return 'unavailable';
  },
  async activate({ backends, notifyChanged, services }) {
    const service = services?.yubiKeyService ?? createNativePivYubiKeyService();
    let closed = false;
    let refreshRunning: Promise<void> | undefined;
    let refreshAgain = false;
    const refresh = (): Promise<void> => {
      if (closed) return Promise.resolve();
      if (refreshRunning) {
        refreshAgain = true;
        return refreshRunning;
      }
      refreshRunning = (async () => {
        do {
          refreshAgain = false;
          const snapshot = backends;
          const before = statusSnapshot();
          backendStatus.clear();
          try {
            await refreshYubiKeyStatuses(snapshot, service, () => !closed);
          } catch {
            if (!closed) markBackendsUnknown(snapshot);
          }
          if (!closed && before !== statusSnapshot()) notifyChanged?.();
        } while (refreshAgain && !closed);
      })().finally(() => { refreshRunning = undefined; });
      return refreshRunning;
    };
    void refresh();
    const watcher = await service.watchDevices?.({
      onChanged: refresh,
      onError: () => refresh(),
    }).catch(() => {
      markBackendsUnknown(backends);
      notifyChanged?.();
      return undefined;
    });
    return {
      async refresh(current) {
        backends = current;
        await refresh();
      },
      async close() {
        closed = true;
        await watcher?.close();
      },
    };
  },
  async signEd25519Digest(input): Promise<string> {
    const backend = parseYubiKeyPivBackend(input.backendEntry.backend);
    if (backend === undefined || backend.devices.length === 0) throw new Error(`YubiKey key ${input.publicKey} has malformed backend metadata.`);
    return (await (input.services?.yubiKeyService ?? createNativePivYubiKeyService()).signEd25519Digest({
      digest: input.digest,
      devices: backend.devices.map(toPivSigningDeviceLocator),
      ...(input.services?.yubiKeyInteraction === undefined ? {} : { interaction: input.services.yubiKeyInteraction }),
      publicKey: input.publicKey,
    })).signatureHex;
  },
};

function statusSnapshot(): string {
  return JSON.stringify([...backendStatus].sort(([left], [right]) => left.localeCompare(right)));
}

async function refreshYubiKeyStatuses(
  descriptors: Array<{ publicKey: Ed25519PublicKeyHex; backendEntry: SignerInventoryBackendEntry }>,
  service: YubiKeyService,
  shouldApply: () => boolean,
): Promise<void> {
  const serials = referencedYubiKeySerials(descriptors);
  const { devices, inspections: inspectedDevices } = await service.listAndInspectDeviceKeys(serials);
  if (!shouldApply()) return;
  const connectedSerials = new Set(devices.map((device) => device.serial).filter((serial): serial is string => serial !== undefined));
  const inspections = new Map<string, Awaited<ReturnType<YubiKeyService['inspectDevice']>>>();
  for (const inspection of inspectedDevices) {
    if (inspection.serial !== undefined) inspections.set(inspection.serial, inspection);
  }

  for (const descriptor of descriptors) {
    const backend = parseYubiKeyPivBackend(descriptor.backendEntry.backend);
    for (const device of backend?.devices ?? []) {
      const key = statusKey(device);
      if (device.kind !== 'yubikey') {
        backendStatus.set(key, 'unknown');
        continue;
      }
      if (device.serial === undefined || !connectedSerials.has(device.serial)) {
        backendStatus.set(key, 'unavailable');
        continue;
      }
      const slot = inspections.get(device.serial)?.slots.find((candidate) => candidate.slot === device.slot);
      if (slot?.publicKey !== descriptor.publicKey) {
        backendStatus.set(key, 'unavailable');
        continue;
      }
      backendStatus.set(key, presentDeviceStatus(device, inspections.get(device.serial)!.pinStatus.status));
    }
  }
}

function referencedYubiKeySerials(descriptors: Array<{ backendEntry: SignerInventoryBackendEntry }>): string[] {
  const serials = new Set<string>();
  for (const descriptor of descriptors) {
    const backend = parseYubiKeyPivBackend(descriptor.backendEntry.backend);
    for (const device of backend?.devices ?? []) {
      if (device.kind === 'yubikey' && device.serial !== undefined) serials.add(device.serial);
    }
  }
  return [...serials];
}

function markBackendsUnknown(descriptors: Array<{ backendEntry: SignerInventoryBackendEntry }>): void {
  for (const descriptor of descriptors) {
    const backend = parseYubiKeyPivBackend(descriptor.backendEntry.backend);
    for (const device of backend?.devices ?? []) backendStatus.set(statusKey(device), 'unknown');
  }
}

function statusKey(device: { kind: 'generic_piv' | 'yubikey'; serial?: string; slot: YubiKeySigningSlot }): string {
  return `${device.serial ?? ''}:${device.slot}`;
}

function presentDeviceStatus(device: { kind: 'generic_piv' | 'yubikey'; pinPolicy?: YubiKeyPinPolicy }, pinStatus: string): SignerBackendStatus {
  if (device.pinPolicy === 'never') return 'unlocked';
  if (device.pinPolicy === 'always') return 'locked';
  return pinStatus === 'verified' ? 'unlocked' : 'locked';
}

function toPivSigningDeviceLocator(device: { kind: 'generic_piv' | 'yubikey'; pinPolicy?: YubiKeyPinPolicy; serial?: string; slot: YubiKeySigningSlot }): PivSigningDeviceLocator {
  return {
    kind: device.kind,
    ...(device.pinPolicy === undefined ? {} : { pinPolicy: device.pinPolicy }),
    ...(device.serial === undefined ? {} : { serial: device.serial }),
    slot: device.slot,
  };
}
