import type { SignerModule } from './types.js';

const extraModules = new Map<string, SignerModule>();

/** Lists process-local signing modules registered outside the built-in module set. */
export function listProcessSignerModules(): SignerModule[] {
  return [...extraModules.values()];
}

/** Looks up a process-local signing module by stable module ID. */
export function getProcessSignerModule(moduleId: string): SignerModule | undefined {
  return extraModules.get(moduleId);
}

/** Registers a process-local signing module and returns a cleanup function. */
export function registerProcessSignerModule(module: SignerModule): () => void {
  if (extraModules.has(module.id)) {
    throw new Error(`Signer module ${module.id} is already registered.`);
  }
  extraModules.set(module.id, module);
  return () => {
    extraModules.delete(module.id);
  };
}
