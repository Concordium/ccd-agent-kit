import {
  createMcpInstanceControl,
  createMcpInstanceId,
  MCP_INSTANCE_NAMESPACES,
} from '@ccd-agent-kit/mcp-utils';
import {
  getStateDir,
  isEncryptedFileStorageConfigured,
  parseSignerInstanceStatus,
  type SignerInstanceRegistryEntry,
  type SignerInstanceStatus,
  type SignerInstanceStatusPayload,
} from '@ccd-agent-kit/config-utils';

import { listSignerModules } from '../modules/registry.js';

/** Signer-owned process registration and authenticated runtime request options. */
export interface StartSignerInstanceControlOptions {
  /** Reloads inventory/readiness after an authenticated CLI mutation notification. */
  refreshInventory?: () => Promise<void>;
  /** Network selected by the signer process when known. */
  network?: string;
  /** Initial lock status for this process. */
  status?: SignerInstanceStatus;
  /** Publishes an actual lock-state or runtime inventory change. */
  notifyChanged?: () => void;
}

/** Private local control-server lifecycle; socket paths must not be projected through MCP. */
export interface SignerInstanceControlServer {
  instance: SignerInstanceRegistryEntry;
  socketPath: string;
  close: () => Promise<void>;
}

let currentInstance: SignerInstanceStatusPayload | undefined;

const instanceControl = createMcpInstanceControl<SignerInstanceStatusPayload>({
  namespace: MCP_INSTANCE_NAMESPACES.signer,
  stateDir: getStateDir,
  getStatus: getCurrentSignerInstanceStatus,
  parseStatus: parseSignerInstanceStatus,
  instanceKind: 'Signer instance',
});

/** Returns the agent-safe current signer instance status. */
export function getCurrentSignerInstanceStatus(): SignerInstanceStatusPayload {
  currentInstance ??= createSignerInstanceStatus();
  return currentInstance;
}

/** Starts the local authenticated control socket for this signer MCP process. */
export async function startSignerInstanceControlServer(
  options: StartSignerInstanceControlOptions = {},
): Promise<SignerInstanceControlServer> {
  setInitialStatus(options.status);
  const control = await instanceControl.start({
    network: options.network,
    handleRequest: async (request) => await handleControlRequest(
      request,
      options.refreshInventory,
      options.notifyChanged,
    ),
  });
  return control;
}

/** Formats the safe startup hint printed to stderr before MCP stdio begins. */
export function formatSignerInstanceStartupHint(instance: SignerInstanceStatusPayload): string[] {
  return [
    'ccd-signer MCP ready',
    `instance: ${instance.instanceId}`,
    `encrypted storage: ${instance.status}`,
    `unlock: ${instance.unlockCommand}`,
  ];
}

function createSignerInstanceStatus(): SignerInstanceStatusPayload {
  const instanceId = createMcpInstanceId();
  return {
    instanceId,
    status: isEncryptedFileStorageConfigured() ? 'locked' : 'unlocked',
    unlockCommand: `ccd-config-manager service signer unlock --instance ${instanceId}`,
  };
}

function setInitialStatus(status: SignerInstanceStatus | undefined): void {
  if (status !== undefined) getCurrentSignerInstanceStatus().status = status;
}

async function handleControlRequest(
  request: Record<string, unknown>,
  refreshInventory?: () => Promise<void>,
  notifyChanged?: () => void,
): Promise<Record<string, unknown>> {
  if (request.type === 'inventory-refresh') {
    if (refreshInventory === undefined) return { ok: false, error: 'unsupported-request' };
    try {
      await refreshInventory();
      return { ok: true };
    } catch {
      return { ok: false, error: 'refresh-failed' };
    }
  }
  for (const module of listSignerModules()) {
    const response = await module.handleControlRequest?.({ request });
    if (response === undefined) continue;
    if (response.ok === true && (response.status === 'locked' || response.status === 'unlocked')) {
      if (getCurrentSignerInstanceStatus().status !== response.status) {
        updateCurrentInstanceStatus(response.status);
        notifyChanged?.();
      }
    }
    return response;
  }
  return { ok: false, error: 'unsupported-request' };
}

function updateCurrentInstanceStatus(nextStatus: SignerInstanceStatus): void {
  getCurrentSignerInstanceStatus().status = nextStatus;
  instanceControl.updateRegistration();
}
