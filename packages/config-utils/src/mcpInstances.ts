import {
  createMcpInstanceClient,
  MCP_INSTANCE_NAMESPACES,
  type McpInstanceRegistryEntry,
} from '@ccd-agent-kit/mcp-utils';

import { getStateDir } from './paths.js';

interface ConfigRefreshInstanceStatus {
  instanceId: string;
}

/** Safe public status and process metadata for a running identity-manager instance. */
export type IdentityManagerInstanceRegistryEntry = McpInstanceRegistryEntry<{ instanceId: string }>;

const signerInstanceClient = createMcpInstanceClient<ConfigRefreshInstanceStatus>({
  namespace: MCP_INSTANCE_NAMESPACES.signer,
  stateDir: getStateDir,
  parseStatus: parseConfigRefreshInstanceStatus,
  instanceKind: 'Signer instance',
});

const idManagerInstanceClient = createMcpInstanceClient<ConfigRefreshInstanceStatus>({
  namespace: MCP_INSTANCE_NAMESPACES.idManager,
  stateDir: getStateDir,
  parseStatus: parseConfigRefreshInstanceStatus,
  instanceKind: 'Identity manager instance',
});

/** MCP runtime domains whose cached config can be refreshed after a mutation. */
export type McpConfigRefreshTarget = 'signer' | 'idManager';

/** Best-effort notifies the requested MCP runtime domains that their config changed. */
export async function notifyMcpInstancesConfigChanged(
  targets: readonly McpConfigRefreshTarget[],
): Promise<void> {
  const requested = new Set(targets);
  await Promise.allSettled([
    ...(requested.has('signer')
      ? [signerInstanceClient.notifyAll({ type: 'inventory-refresh' })]
      : []),
    ...(requested.has('idManager')
      ? [idManagerInstanceClient.notifyAll({ type: 'sources-refresh' })]
      : []),
  ]);
}

/** Lists running identity-manager instances without exposing local paths, tokens, or private material. */
export function listIdentityManagerInstances(): IdentityManagerInstanceRegistryEntry[] {
  return idManagerInstanceClient.list();
}

function parseConfigRefreshInstanceStatus(raw: unknown): ConfigRefreshInstanceStatus | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const { instanceId } = raw as Partial<ConfigRefreshInstanceStatus>;
  return typeof instanceId === 'string' ? { instanceId } : undefined;
}
