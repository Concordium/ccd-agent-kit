import { createPivSessionPool, createPivTransport } from '@ccd-agent-kit/piv-utils';
import { createIdentityYubiKeyService } from '@ccd-agent-kit/piv-utils';
import {
  createIdentitySourceRegistry,
  isIdentitySourceBackendEnabled,
  YUBIKEY_IDENTITY_SOURCE_BACKEND,
} from '@ccd-agent-kit/config-utils';
import { createIdentitySourceService } from './service.js';
import type { IdentitySourceService } from './types.js';
import { createYubiKeySourceBackend } from './yubikey.js';

/** Construct the runtime protected registry with the current YubiKey PIV source backend. */
export function createDefaultIdentitySourceService(options: { persistent?: boolean } = {}): IdentitySourceService {
  const transport = createPivTransport();
  const pool = options.persistent ? createPivSessionPool(transport) : undefined;
  const hardware = createIdentityYubiKeyService(transport, pool);
  const registry = createIdentitySourceRegistry();
  const backend = createYubiKeySourceBackend(hardware);
  let retained = new Set<string>();
  let closed = false;
  let initialized: Promise<void> | undefined;
  let pending = Promise.resolve();
  let deviceWatcher: Awaited<ReturnType<typeof transport.watchDevices>> | undefined;
  const referencedLocators = async () => {
    if (!isIdentitySourceBackendEnabled(YUBIKEY_IDENTITY_SOURCE_BACKEND)) return [];
    const document = await registry.read();
    return Object.values(document.sources).flatMap(record => record.backends
      .filter(reference => reference.backend === YUBIKEY_IDENTITY_SOURCE_BACKEND)
      .flatMap(reference => reference.locations));
  };
  const reconcile = async () => {
    if (closed) return;
    const locators = await referencedLocators();
    const next = new Set(locators.flatMap(locator => typeof locator.serial === 'string' ? [locator.serial] : []));
    await backend.retain?.(locators);
    if (pool !== undefined) {
      await Promise.all([...retained].filter(serial => !next.has(serial)).map(serial => pool.release(serial)));
      await Promise.allSettled([...next].map(serial => pool.retain(serial)));
    }
    retained = next;
    if (locators.length === 0) {
      await deviceWatcher?.close();
      deviceWatcher = undefined;
      return;
    }
    deviceWatcher ??= await transport.watchDevices({ onChanged: () => { void scheduleReconcile(); } });
    await backend.refresh?.(locators);
  };
  const scheduleReconcile = () => {
    pending = pending.then(reconcile, reconcile);
    return pending;
  };
  const initialize = () => {
    initialized ??= scheduleReconcile();
    return initialized;
  };
  const prepare = async () => {
    await initialize();
    await pending;
  };
  return createIdentitySourceService({
    registry,
    backends: [backend],
    isBackendEnabled: isIdentitySourceBackendEnabled,
    prepare,
    async refresh() {
      if (closed) return;
      if (initialized === undefined) await initialize();
      else await scheduleReconcile();
      await pending;
    },
    async close() {
      closed = true;
      await initialized?.catch(() => undefined);
      await pending.catch(() => undefined);
      await deviceWatcher?.close();
      await Promise.all([...retained].map(serial => pool?.release(serial)));
      await hardware.close?.();
    },
  });
}
