import { readFileSync } from 'node:fs';

import { getSignerConfigPath } from '../paths.js';
import { protectedFileExists, writeProtectedJsonAtomic } from './protectedFile.js';
import {
  ED25519_SCHEME,
  ENCRYPTED_FILE_STORAGE_MODULE_ID,
  SOFTWARE_SIGNER_MODULE_ID,
  YUBIKEY_PIV_MODULE_ID,
  type SigningModuleId,
  type SoftwareKeyStorageModuleId,
} from './constants.js';
import { parseSoftwareKeyStorageModuleId } from './backends.js';

type UnknownRecord = Record<string, unknown>;
/** Signer module enablement policy. */
export type ModulePolicy = 'enabled' | 'disabled';
/** Persisted signer module configuration. */
export interface SignerConfigFile {
  version: 1;
  signer: { config: { signingModules: Record<string, { enabled?: boolean } & UnknownRecord> } & UnknownRecord } & UnknownRecord;
  moduleConfigs: Record<string, { config: UnknownRecord } & UnknownRecord>;
}

/** Loads signer module configuration with dependency-light built-in defaults. */
export function loadModuleConfig(): SignerConfigFile {
  if (!protectedFileExists(getSignerConfigPath())) return normalizeSignerConfig({});
  try { return normalizeSignerConfig(JSON.parse(readFileSync(getSignerConfigPath(), 'utf8')) as unknown); }
  catch { return normalizeSignerConfig({}); }
}

/** Atomically saves protected signer module configuration. */
export function saveModuleConfig(config: SignerConfigFile): void { writeProtectedJsonAtomic(getSignerConfigPath(), config, 'signer-config'); }

/** Returns whether a built-in signing module is enabled. */
export function getSigningModuleEnabled(moduleId: string): boolean {
  return loadModuleConfig().signer.config.signingModules[moduleId]?.enabled ?? false;
}

/** Updates a built-in signing module policy. */
export function setSigningModulePolicy(moduleId: SigningModuleId, policy: ModulePolicy): void {
  const config = loadModuleConfig();
  config.signer.config.signingModules[moduleId] = { ...(config.signer.config.signingModules[moduleId] ?? {}), enabled: policy === 'enabled' };
  saveModuleConfig(config);
}

/** Returns whether a software key-storage module is enabled. */
export function isSoftwareStorageModuleEnabled(moduleId: SoftwareKeyStorageModuleId): boolean {
  return softwareConfig(loadModuleConfig()).storageModules[moduleId]!.enabled;
}

/** Updates software key-storage module policy. */
export function setSoftwareStorageModulePolicy(moduleId: SoftwareKeyStorageModuleId, policy: ModulePolicy): void {
  const config = loadModuleConfig();
  const software = softwareConfig(config);
  software.storageModules[moduleId] = { ...(software.storageModules[moduleId] ?? {}), enabled: policy === 'enabled' };
  saveModuleConfig(config);
}

/** Parses a software key-storage module identifier. */
export const parseSoftwareKeyStorageModule = parseSoftwareKeyStorageModuleId;

function normalizeSignerConfig(value: unknown): SignerConfigFile {
  const raw = record(value); const signer = record(raw.signer); const signerConfig = record(signer.config);
  const rawModules = record(signerConfig.signingModules); const rawConfigs = record(raw.moduleConfigs);
  const signingModules: SignerConfigFile['signer']['config']['signingModules'] = {};
  for (const [id, value] of Object.entries(rawModules)) {
    const { enabled, ...entry } = record(value);
    signingModules[id] = { ...entry, ...(typeof enabled === 'boolean' ? { enabled } : {}) };
  }
  signingModules[SOFTWARE_SIGNER_MODULE_ID] ??= { enabled: true };
  signingModules[YUBIKEY_PIV_MODULE_ID] ??= { enabled: true };
  const moduleConfigs: SignerConfigFile['moduleConfigs'] = {};
  for (const [id, value] of Object.entries(rawConfigs)) { const entry = record(value); moduleConfigs[id] = { ...entry, config: record(entry.config) }; }
  const software = record(moduleConfigs[SOFTWARE_SIGNER_MODULE_ID]?.config);
  moduleConfigs[SOFTWARE_SIGNER_MODULE_ID] = {
    ...(moduleConfigs[SOFTWARE_SIGNER_MODULE_ID] ?? {}),
    config: {
      ...software,
      schemes: normalizeEnabled(record(software.schemes), { [ED25519_SCHEME]: true }),
      schemeConfigs: record(software.schemeConfigs),
      storageModules: normalizeEnabled(record(software.storageModules), {
        [ENCRYPTED_FILE_STORAGE_MODULE_ID]: true,
      }),
      storageModuleConfigs: record(software.storageModuleConfigs),
    },
  };
  moduleConfigs[YUBIKEY_PIV_MODULE_ID] ??= { config: {} };
  return { version: 1, signer: { ...signer, config: { ...signerConfig, signingModules } }, moduleConfigs };
}

function softwareConfig(config: SignerConfigFile): {
  storageModules: Record<string, { enabled: boolean } & UnknownRecord>;
} & UnknownRecord {
  return config.moduleConfigs[SOFTWARE_SIGNER_MODULE_ID]!.config as ReturnType<typeof softwareConfig>;
}
function normalizeEnabled(value: UnknownRecord, defaults: Record<string, boolean>): Record<string, { enabled: boolean } & UnknownRecord> {
  const output: Record<string, { enabled: boolean } & UnknownRecord> = {};
  for (const [id, raw] of Object.entries(value)) { const entry = record(raw); output[id] = { ...entry, enabled: typeof entry.enabled === 'boolean' ? entry.enabled : (defaults[id] ?? false) }; }
  for (const [id, enabled] of Object.entries(defaults)) output[id] ??= { enabled };
  return output;
}
function record(value: unknown): UnknownRecord { return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as UnknownRecord : {}; }
