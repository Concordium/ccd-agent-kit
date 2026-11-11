import {
  ED25519_SCHEME,
  ENCRYPTED_FILE_STORAGE_MODULE_ID,
  SOFTWARE_SIGNER_MODULE_ID,
  type SignerConfigFile,
} from '@ccd-agent-kit/config-utils';

type UnknownRecord = Record<string, unknown>;

interface SoftwareSignerConfig {
  schemes: Record<string, { enabled: boolean } & UnknownRecord>;
  storageModules: Record<string, { enabled: boolean } & UnknownRecord>;
}

/** Returns whether a software signing scheme is enabled in a caller-provided signer config snapshot. */
export function getSoftwareSchemeEnabledInConfig(scheme: string, config: SignerConfigFile): boolean {
  if (scheme !== ED25519_SCHEME) return false;
  const software = getSoftwareSignerConfig(config);
  return software.schemes[scheme]?.enabled ?? true;
}

/** Returns whether a software storage module is enabled in a caller-provided signer config snapshot. */
export function getSoftwareStorageModuleEnabledInConfig(moduleId: string, config: SignerConfigFile): boolean {
  if (moduleId !== ENCRYPTED_FILE_STORAGE_MODULE_ID) return false;
  const software = getSoftwareSignerConfig(config);
  return software.storageModules[moduleId]?.enabled ?? true;
}

function getSoftwareSignerConfig(config: SignerConfigFile): SoftwareSignerConfig & UnknownRecord {
  return config.moduleConfigs[SOFTWARE_SIGNER_MODULE_ID]!.config as SoftwareSignerConfig & UnknownRecord;
}
