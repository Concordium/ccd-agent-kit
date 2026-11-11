import type {
  PivDeviceLocator, SignerInventoryBackendEntry, UpsertSignerInventoryKeyInput, YubiKeyPivSignerBackend,
} from './inventory.js';
import { ENCRYPTED_FILE_STORAGE_MODULE_ID, type SoftwareKeyStorageModuleId } from './constants.js';
import { assertYubiKeyPinPolicy, assertYubiKeyTouchPolicy, parseAllowedYubiKeySigningSlot } from '@ccd-agent-kit/piv-utils';
import { z } from 'zod';
import { mergeStable } from '../catalogOrder.js';
import { pivDeviceLocatorIdentity } from './pivDeviceLocator.js';

const softwareSignerBackendSchema = z.object({ storageModule: z.string(), keyRef: z.string() });

/** Public software-signer backend payload. */
export type SoftwareSignerBackend = z.infer<typeof softwareSignerBackendSchema>;

/** Parses the public software signer backend payload. */
export function parseSoftwareBackend(value: unknown): SoftwareSignerBackend | undefined {
  const parsed = softwareSignerBackendSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** Parses the public YubiKey PIV backend payload, dropping unsupported device entries. */
export function parseYubiKeyPivBackend(value: unknown): YubiKeyPivSignerBackend | undefined {
  if (!isRecord(value) || !Array.isArray(value.devices)) return undefined;
  const devices: PivDeviceLocator[] = [];
  for (const raw of value.devices) {
    if (!isRecord(raw) || (raw.kind !== 'yubikey' && raw.kind !== 'generic_piv')
      || typeof raw.slot !== 'string') continue;
    const slot = parseAllowedYubiKeySigningSlot(raw.slot);
    if (slot === undefined || slot !== raw.slot) continue;
    if (raw.kind === 'yubikey') {
      if (typeof raw.serial !== 'string'
        || (raw.pinPolicy !== undefined && typeof raw.pinPolicy !== 'string')
        || (raw.touchPolicy !== undefined && typeof raw.touchPolicy !== 'string')) continue;
      try {
        const pinPolicy = raw.pinPolicy === undefined ? undefined : assertYubiKeyPinPolicy(raw.pinPolicy);
        const touchPolicy = raw.touchPolicy === undefined ? undefined : assertYubiKeyTouchPolicy(raw.touchPolicy);
        devices.push({
          kind: 'yubikey', serial: raw.serial, slot,
          ...(pinPolicy === undefined ? {} : { pinPolicy }),
          ...(touchPolicy === undefined ? {} : { touchPolicy }),
          ...(typeof raw.lastSeenAt === 'string' ? { lastSeenAt: raw.lastSeenAt } : {}),
        });
      } catch { /* Unsupported policy observations are not usable custody locations. */ }
    } else {
      devices.push({
        kind: 'generic_piv', slot,
        ...(typeof raw.certificateFingerprint === 'string' ? { certificateFingerprint: raw.certificateFingerprint } : {}),
        ...(typeof raw.chuid === 'string' ? { chuid: raw.chuid } : {}),
        ...(typeof raw.lastSeenAt === 'string' ? { lastSeenAt: raw.lastSeenAt } : {}),
      });
    }
  }
  return { devices };
}

/** Merges repeated built-in backend upserts while preserving ordered hardware locations. */
export function mergeBuiltInSignerBackend(
  existing: SignerInventoryBackendEntry,
  next: UpsertSignerInventoryKeyInput,
): unknown | undefined {
  if (next.signingModule !== 'yubikey-piv') return undefined;
  const left = parseYubiKeyPivBackend(existing.backend);
  const right = parseYubiKeyPivBackend(next.backend);
  if (left === undefined || right === undefined) return undefined;
  const devices = mergeStable(left.devices, right.devices, pivDeviceLocatorIdentity, mergeDevice);
  return { devices };
}

function mergeDevice(left: PivDeviceLocator, right: PivDeviceLocator): PivDeviceLocator {
  if (left.kind === 'yubikey' && right.kind === 'yubikey') return { ...left, ...right };
  if (left.kind === 'generic_piv' && right.kind === 'generic_piv') return { ...left, ...right };
  return right;
}

/** Parses and validates a software key-storage module identifier. */
export function parseSoftwareKeyStorageModuleId(value: string): SoftwareKeyStorageModuleId {
  if (value === ENCRYPTED_FILE_STORAGE_MODULE_ID) return value;
  throw new Error(`Storage module ${value} is not supported. Supported storage: encrypted-file.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
