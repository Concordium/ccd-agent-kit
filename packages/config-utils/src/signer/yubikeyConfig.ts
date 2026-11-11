import { readFileSync } from 'node:fs';
import {
  assertAllowedYubiKeySigningSlot, assertYubiKeyPinPolicy, assertYubiKeyTouchPolicy,
  BUILTIN_YUBIKEY_DEFAULTS, type YubiKeyPinPolicy, type YubiKeySigningSlot, type YubiKeyTouchPolicy,
} from '@ccd-agent-kit/piv-utils';

import { getSignerYubiKeyConfigPath } from '../paths.js';
import { protectedFileExists, writeProtectedJsonAtomic } from './protectedFile.js';

/** Persisted YubiKey generation defaults. */
export interface YubiKeyGenerationDefaults { slot?: YubiKeySigningSlot; pinPolicy?: YubiKeyPinPolicy; touchPolicy?: YubiKeyTouchPolicy; }
/** Persisted shared YubiKey provisioning defaults. */
export interface YubiKeyConfig { defaults?: YubiKeyGenerationDefaults; devices?: Record<string, YubiKeyGenerationDefaults>; }
/** Fully resolved YubiKey generation defaults. */
export interface ResolvedYubiKeyGenerationDefaults { slot: YubiKeySigningSlot; pinPolicy: YubiKeyPinPolicy; touchPolicy: YubiKeyTouchPolicy; }

/** Loads persisted YubiKey provisioning defaults. */
export function loadYubiKeyConfig(): YubiKeyConfig { if (!protectedFileExists(getSignerYubiKeyConfigPath())) return {}; try { return normalize(JSON.parse(readFileSync(getSignerYubiKeyConfigPath(), 'utf8')) as unknown); } catch { return {}; } }
/** Atomically saves producer-validated YubiKey provisioning defaults. */
export function saveYubiKeyConfig(config: YubiKeyConfig): void { writeProtectedJsonAtomic(getSignerYubiKeyConfigPath(), config, 'yubikey-config'); }
/** Resolves effective generation defaults for an optional serial and explicit overrides. */
export function resolveYubiKeyGenerationDefaults(input: { config?: YubiKeyConfig; overrides?: YubiKeyGenerationDefaults; serial?: string }): ResolvedYubiKeyGenerationDefaults {
  const config = input.config ?? loadYubiKeyConfig(); const device = input.serial === undefined ? undefined : config.devices?.[input.serial];
  return {
    slot: input.overrides?.slot ?? device?.slot ?? config.defaults?.slot ?? BUILTIN_YUBIKEY_DEFAULTS.slot,
    pinPolicy: input.overrides?.pinPolicy ?? device?.pinPolicy ?? config.defaults?.pinPolicy ?? BUILTIN_YUBIKEY_DEFAULTS.pinPolicy,
    touchPolicy: input.overrides?.touchPolicy ?? device?.touchPolicy ?? config.defaults?.touchPolicy ?? BUILTIN_YUBIKEY_DEFAULTS.touchPolicy,
  };
}
/** Updates global or per-device generation defaults. */
export function setYubiKeyGenerationDefaults(input: { defaults: YubiKeyGenerationDefaults; serial?: string }): YubiKeyConfig { const config = loadYubiKeyConfig(); if (input.serial === undefined) config.defaults = { ...config.defaults, ...input.defaults }; else { if (!/^\d+$/.test(input.serial)) throw new Error('Invalid YubiKey serial in defaults.'); config.devices ??= {}; config.devices[input.serial] = { ...config.devices[input.serial], ...input.defaults }; } saveYubiKeyConfig(config); return config; }
/** Resets global defaults or removes one device override. */
export function resetYubiKeyGenerationDefaults(serial?: string): YubiKeyConfig { const config = loadYubiKeyConfig(); if (serial === undefined) delete config.defaults; else if (config.devices !== undefined) { delete config.devices[serial]; if (Object.keys(config.devices).length === 0) delete config.devices; } saveYubiKeyConfig(config); return config; }
function normalize(value: unknown): YubiKeyConfig { if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}; const raw = value as Record<string, unknown>; const defaults = normalizeDefaults(raw.defaults); const devices: Record<string, YubiKeyGenerationDefaults> = {}; if (typeof raw.devices === 'object' && raw.devices !== null && !Array.isArray(raw.devices)) for (const [serial, entry] of Object.entries(raw.devices)) { if (!/^\d+$/.test(serial)) throw new Error('Invalid YubiKey serial in defaults.'); devices[serial] = normalizeDefaults(entry); } return { ...(Object.keys(defaults).length === 0 ? {} : { defaults }), ...(Object.keys(devices).length === 0 ? {} : { devices }) }; }
function normalizeDefaults(value: unknown): YubiKeyGenerationDefaults { if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}; const raw = value as Record<string, unknown>; return { ...(typeof raw.slot === 'string' ? { slot: assertAllowedYubiKeySigningSlot(raw.slot) } : {}), ...(typeof raw.pinPolicy === 'string' ? { pinPolicy: assertYubiKeyPinPolicy(raw.pinPolicy) } : {}), ...(typeof raw.touchPolicy === 'string' ? { touchPolicy: assertYubiKeyTouchPolicy(raw.touchPolicy) } : {}) }; }
