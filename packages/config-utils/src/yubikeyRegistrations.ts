import { readFileSync } from 'node:fs';

import { getYubiKeyRegistrationsPath } from './paths.js';
import { protectedFileExists, writeProtectedJsonAtomic } from './signer/protectedFile.js';

const NAME = /^[A-Za-z0-9._-]+$/;
const SERIAL = /^\d+$/;

/** Current shared YubiKey registration file version. */
export const YUBIKEY_REGISTRATIONS_VERSION = 1;

/** A registered YubiKey's public naming metadata. */
export interface YubiKeyRegistration {
  /** Decimal YubiKey serial number. */
  serial: string;
  /** ISO timestamp when this YubiKey was first registered. */
  registeredAt: string;
  /** ISO timestamp when this registration was last updated. */
  updatedAt: string;
}

/** Persisted shared YubiKey registrations keyed by friendly name. */
export interface YubiKeyRegistrations {
  /** File format version. */
  version: 1;
  /** ISO timestamp for the last registration update. */
  updatedAt: string;
  /** Registered YubiKeys keyed by friendly name. */
  devices: Record<string, YubiKeyRegistration>;
}

/** Loads shared YubiKey registrations, returning an empty catalog only when absent. */
export function loadYubiKeyRegistrations(): YubiKeyRegistrations {
  const filename = getYubiKeyRegistrationsPath();
  if (!protectedFileExists(filename)) return emptyYubiKeyRegistrations();
  const parsed = JSON.parse(readFileSync(filename, 'utf8')) as unknown;
  if (!isYubiKeyRegistrations(parsed)) throw new Error('Unsupported or invalid YubiKey registry format.');
  return structuredClone(parsed);
}

/** Atomically saves shared YubiKey registrations as protected public metadata. */
export function saveYubiKeyRegistrations(registrations: YubiKeyRegistrations): void { writeProtectedJsonAtomic(getYubiKeyRegistrationsPath(), registrations, 'yubikeys'); }

/** Registers a shared friendly name for a YubiKey serial number. */
export function registerYubiKey(input: { name: string; serial: string }): YubiKeyRegistrations {
  const name = assertYubiKeyRegistrationName(input.name);
  const serial = assertYubiKeySerial(input.serial);
  const registrations = loadYubiKeyRegistrations();
  if (registrations.devices[name] !== undefined) throw new Error(`YubiKey name '${name}' is already registered.`);
  const existingName = findYubiKeyRegistrationNameForSerial(serial, registrations);
  if (existingName !== undefined) throw new Error(`YubiKey serial ${serial} is already registered as '${existingName}'.`);
  const now = new Date().toISOString();
  registrations.devices[name] = { registeredAt: now, serial, updatedAt: now };
  registrations.updatedAt = now;
  saveYubiKeyRegistrations(registrations);
  return registrations;
}

/** Renames a shared YubiKey registration. */
export function renameYubiKeyRegistration(input: { currentName: string; nextName: string }): YubiKeyRegistrations {
  const currentName = assertYubiKeyRegistrationName(input.currentName);
  const nextName = assertYubiKeyRegistrationName(input.nextName);
  return renameRegistration(loadYubiKeyRegistrations(), currentName, nextName);
}

/** Renames a shared YubiKey registration selected by existing name or serial. */
export function renameYubiKeyRegistrationBySelector(input: { currentSelector: string; nextName: string }): YubiKeyRegistrations {
  const registrations = loadYubiKeyRegistrations();
  const currentName = resolveRegistrationName(input.currentSelector, registrations);
  if (currentName === undefined) throw new Error(`YubiKey '${input.currentSelector}' is not registered.`);
  return renameRegistration(registrations, currentName, assertYubiKeyRegistrationName(input.nextName));
}

/** Removes a shared YubiKey registration selected by existing name or serial. */
export function unregisterYubiKey(input: { selector: string }): YubiKeyRegistrations {
  const registrations = loadYubiKeyRegistrations();
  const name = resolveRegistrationName(input.selector, registrations);
  if (name === undefined) throw new Error(`YubiKey '${input.selector}' is not registered.`);
  delete registrations.devices[name];
  registrations.updatedAt = new Date().toISOString();
  saveYubiKeyRegistrations(registrations);
  return registrations;
}

/** Resolves a shared YubiKey friendly name. */
export function resolveYubiKeyRegistration(name: string): YubiKeyRegistration | undefined { return loadYubiKeyRegistrations().devices[assertYubiKeyRegistrationName(name)]; }

/** Finds the friendly name registered for a serial number. */
export function findYubiKeyRegistrationNameForSerial(
  serial: string,
  registrations: YubiKeyRegistrations = loadYubiKeyRegistrations(),
): string | undefined {
  if (!SERIAL.test(serial)) return undefined;
  return Object.entries(registrations.devices).find(([, registration]) => registration.serial === serial)?.[0];
}

/** Validates and returns a shared YubiKey registration name. */
export function assertYubiKeyRegistrationName(name: string): string {
  if (!NAME.test(name) || SERIAL.test(name)) {
    throw new Error('YubiKey name must use letters, numbers, dots, underscores, or hyphens and must not be all digits.');
  }
  return name;
}

/** Validates and returns a decimal YubiKey serial number. */
export function assertYubiKeySerial(serial: string): string { if (!SERIAL.test(serial)) throw new Error('YubiKey serial must be a decimal number.'); return serial; }

function emptyYubiKeyRegistrations(): YubiKeyRegistrations { return { devices: {}, updatedAt: new Date().toISOString(), version: YUBIKEY_REGISTRATIONS_VERSION }; }

function resolveRegistrationName(selector: string, registrations: YubiKeyRegistrations): string | undefined {
  return registrations.devices[selector] === undefined ? findYubiKeyRegistrationNameForSerial(selector, registrations) : selector;
}
function renameRegistration(registrations: YubiKeyRegistrations, currentName: string, nextName: string): YubiKeyRegistrations {
  const existing = registrations.devices[currentName];
  if (existing === undefined) throw new Error(`YubiKey name '${currentName}' is not registered.`);
  if (currentName !== nextName && registrations.devices[nextName] !== undefined) {
    throw new Error(`YubiKey name '${nextName}' is already registered.`);
  }
  const now = new Date().toISOString();
  delete registrations.devices[currentName];
  registrations.devices[nextName] = { ...existing, updatedAt: now };
  registrations.updatedAt = now;
  saveYubiKeyRegistrations(registrations);
  return registrations;
}

function isYubiKeyRegistrations(value: unknown): value is YubiKeyRegistrations {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (Object.keys(candidate).length !== 3 || candidate.version !== 1 || typeof candidate.updatedAt !== 'string'
    || typeof candidate.devices !== 'object' || candidate.devices === null || Array.isArray(candidate.devices)) return false;
  const serials = new Set<string>();
  return Object.entries(candidate.devices).every(([name, value]) => {
    if (!NAME.test(name) || SERIAL.test(name)
      || typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    const registration = value as Record<string, unknown>;
    const valid = Object.keys(registration).length === 3
      && typeof registration.serial === 'string' && SERIAL.test(registration.serial)
      && typeof registration.registeredAt === 'string' && typeof registration.updatedAt === 'string';
    if (!valid || serials.has(registration.serial as string)) return false;
    serials.add(registration.serial as string);
    return true;
  });
}
