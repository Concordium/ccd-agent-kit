import { softwareSignerModule } from './softwareSignerModule.js';
import type { SignerModule } from './types.js';
import { yubiKeyPivModule } from './yubiKeyPivModule.js';
import { getProcessSignerModule, listProcessSignerModules, registerProcessSignerModule } from './registryState.js';

const builtInModules = [softwareSignerModule, yubiKeyPivModule] as const;

/** Lists signing modules registered in the current signer build and process. */
export function listSignerModules(): SignerModule[] {
  return [...builtInModules, ...listProcessSignerModules()];
}

/** Looks up a registered signing module by stable module ID. */
export function getSignerModule(moduleId: string): SignerModule | undefined {
  return getProcessSignerModule(moduleId) ?? builtInModules.find((module) => module.id === moduleId);
}

/** Returns whether a signing module is registered in the current signer build and process. */
export function isSignerModuleRegistered(moduleId: string): boolean {
  return getSignerModule(moduleId) !== undefined;
}

/** Registers a process-local signing module and returns a cleanup function. */
export function registerSignerModule(module: SignerModule): () => void {
  if (builtInModules.some((builtIn) => builtIn.id === module.id)) {
    throw new Error(`Signer module ${module.id} is already registered.`);
  }
  return registerProcessSignerModule(module);
}
