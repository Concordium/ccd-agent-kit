import {
  createMcpInstanceControl,
  createMcpInstanceId,
  MCP_INSTANCE_NAMESPACES,
  type McpInstanceControlServer,
} from '@ccd-agent-kit/mcp-utils';
import { getStateDir } from '@ccd-agent-kit/config-utils';

/** Agent-safe public status for one identity-manager MCP process. */
export interface IdentityManagerInstanceStatus {
  instanceId: string;
}

/** Options for identity-manager authenticated runtime control. */
export interface StartIdentityManagerInstanceControlOptions {
  /** Reconciles configured identity sources with available hardware. */
  refreshSources: () => Promise<void>;
}

/** Protected local identity-manager control-server lifecycle. */
export type IdentityManagerInstanceControlServer = McpInstanceControlServer<IdentityManagerInstanceStatus>;

const status: IdentityManagerInstanceStatus = { instanceId: createMcpInstanceId() };

const instanceControl = createMcpInstanceControl<IdentityManagerInstanceStatus>({
  namespace: MCP_INSTANCE_NAMESPACES.idManager,
  stateDir: getStateDir,
  getStatus: () => status,
  parseStatus(raw) {
    if (typeof raw !== 'object' || raw === null) return undefined;
    const instanceId = (raw as { instanceId?: unknown }).instanceId;
    return typeof instanceId === 'string' && instanceId.length > 0 ? { instanceId } : undefined;
  },
  instanceKind: 'Identity-manager instance',
});

/** Starts the authenticated local control socket for an identity-manager MCP process. */
export async function startIdentityManagerInstanceControlServer(
  options: StartIdentityManagerInstanceControlOptions,
): Promise<IdentityManagerInstanceControlServer> {
  const control: McpInstanceControlServer<IdentityManagerInstanceStatus> = await instanceControl.start({
    handleRequest: async request => {
      if (request.type !== 'sources-refresh') return { ok: false, error: 'unsupported-request' };
      try {
        await options.refreshSources();
        return { ok: true };
      } catch {
        return { ok: false, error: 'refresh-failed' };
      }
    },
  });
  return control;
}
