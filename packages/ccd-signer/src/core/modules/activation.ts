import { listVisibleSignerInventoryKeys } from './keyVisibility.js';
import { listSignerModules } from './registry.js';
import type { ActivatedSignerModule, SignerBackendDescriptor, SignerModuleServices } from './types.js';

/** Process-local activated signer module runtimes. */
export interface ActiveSignerModules {
  /** Reloads visible inventory and refreshes existing runtimes without resetting local authorization. */
  refresh(): Promise<void>;
  /** Closes all module-owned activated runtimes. */
  close(): Promise<void>;
}

/**
 * Activates runtime modules. Call {@link ActiveSignerModules.refresh} to refresh their visible inventory.
 * Closes already activated runtimes before surfacing a later activation failure.
 */
export async function activateSignerModules(input: { services?: SignerModuleServices; notifyChanged?: () => void } = {}): Promise<ActiveSignerModules> {
  const byModule = visibleBackendsByModule();
  const activated = new Map<string, ActivatedSignerModule>();
  try {
    for (const module of listSignerModules()) {
      const runtime = await module.activate?.({
        backends: byModule.get(module.id) ?? [],
        services: input.services,
        notifyChanged: input.notifyChanged,
      });
      if (runtime !== undefined) activated.set(module.id, runtime);
    }
  } catch (error) {
    await Promise.allSettled([...activated.values()].map(async runtime => runtime.close()));
    throw error;
  }

  let closed = false;
  const runtime: ActiveSignerModules = {
    async refresh() {
      if (closed) return;
      const current = visibleBackendsByModule();
      await Promise.all([...activated].map(async ([id, runtime]) => runtime.refresh?.(current.get(id) ?? [])));
    },
    async close() {
      if (closed) return;
      closed = true;
      await Promise.all([...activated.values()].map(async runtime => runtime.close()));
    },
  };
  return runtime;
}

function visibleBackendsByModule(): Map<string, SignerBackendDescriptor[]> {
  const byModule = new Map<string, SignerBackendDescriptor[]>();
  for (const { backends, entry, publicKey } of listVisibleSignerInventoryKeys()) {
    for (const backendEntry of backends) {
      const descriptors = byModule.get(backendEntry.signingModule) ?? [];
      descriptors.push({ backendEntry, publicKey, scheme: entry.scheme });
      byModule.set(backendEntry.signingModule, descriptors);
    }
  }

  return byModule;
}
