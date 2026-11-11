import type { ModulePolicy, SignerConfigFile } from '@ccd-agent-kit/config-utils';

/** Runtime readiness for an enabled module. */
export type ModuleReadiness = 'ready' | 'uninitialized' | 'locked' | 'unavailable' | 'error';

/** Policy and optional runtime status for a signer module. */
export interface ModuleStatus {
  /** Configured policy. Disabled modules hide their keys and capabilities. */
  policy: ModulePolicy;
  /** Current operation readiness. */
  readiness: ModuleReadiness;
  /** Optional human-readable operational guidance. */
  message?: string;
}

/** Returns whether a registered module is enabled in a supplied config snapshot. */
export function isRegisteredSigningModuleEnabledInConfig(
  moduleId: string,
  defaultEnabled: boolean,
  config: SignerConfigFile,
): boolean {
  return config.signer.config.signingModules[moduleId]?.enabled ?? defaultEnabled;
}
