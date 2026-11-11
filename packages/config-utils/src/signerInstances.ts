import {
  createMcpInstanceClient,
  MCP_INSTANCE_NAMESPACES,
  type McpInstanceRegistryEntry,
} from '@ccd-agent-kit/mcp-utils';

import { getStateDir } from './paths.js';

/** Runtime lock status reported by a signer MCP process. */
export type SignerInstanceStatus = 'locked' | 'unlocked';

/** Agent-safe public status for a signer MCP process. */
export interface SignerInstanceStatusPayload {
  /** Random process-local identifier used to target control requests. */
  instanceId: string;
  /** Whether encrypted signer storage is currently locked. */
  status: SignerInstanceStatus;
  /** Config CLI command that unlocks this exact signer instance. */
  unlockCommand: string;
}

/** Safe signer status plus public process metadata. */
export type SignerInstanceRegistryEntry = McpInstanceRegistryEntry<SignerInstanceStatusPayload>;

/** Input for an authenticated signer-instance unlock request. */
export interface RequestSignerInstanceUnlockInput {
  instanceId: string;
  password: string;
}

/** Result of an authenticated signer-instance unlock request. */
export interface RequestSignerInstanceUnlockResult {
  ok: true;
  status: SignerInstanceStatus;
}

/** Input for an authenticated signer-instance lock request. */
export interface RequestSignerInstanceLockInput {
  instanceId: string;
}

/** Result of an authenticated signer-instance lock request. */
export interface RequestSignerInstanceLockResult {
  ok: true;
  status: SignerInstanceStatus;
}

const signerInstanceClient = createMcpInstanceClient<SignerInstanceStatusPayload>({
  namespace: MCP_INSTANCE_NAMESPACES.signer,
  stateDir: getStateDir,
  parseStatus: parseSignerInstanceStatus,
  instanceKind: 'Signer instance',
});

/** Lists safe statuses for running signer MCP instances. */
export function listSignerInstances(): SignerInstanceRegistryEntry[] {
  return signerInstanceClient.list();
}

/** Sends an authenticated unlock request to a running signer MCP process. */
export async function requestSignerInstanceUnlock(
  input: RequestSignerInstanceUnlockInput,
): Promise<RequestSignerInstanceUnlockResult> {
  return requestSignerInstanceStatus(input.instanceId, { password: input.password, type: 'unlock' }, 'unlocked');
}

/** Sends an authenticated lock request to a running signer MCP process. */
export async function requestSignerInstanceLock(
  input: RequestSignerInstanceLockInput,
): Promise<RequestSignerInstanceLockResult> {
  return requestSignerInstanceStatus(input.instanceId, { type: 'lock' }, 'locked');
}

async function requestSignerInstanceStatus(
  instanceId: string,
  request: Record<string, unknown>,
  fallbackStatus: SignerInstanceStatus,
): Promise<RequestSignerInstanceLockResult> {
  const response = await signerInstanceClient.request(instanceId, request);
  if (response.ok !== true) {
    const detail = typeof response.error === 'string' ? response.error : 'unknown error';
    throw new Error(`Signer instance ${String(request.type)} failed: ${detail}.`);
  }
  const status = response.status === 'locked' || response.status === 'unlocked' ? response.status : fallbackStatus;
  return { ok: true, status };
}

/** Returns the protected signer-instance registry directory. */
export function getSignerInstanceRegistryDir(): string {
  return signerInstanceClient.getRegistryDir();
}

/** Strictly parses a safe signer status and normalizes its config-owned command guidance. */
export function parseSignerInstanceStatus(raw: unknown): SignerInstanceStatusPayload | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const parsed = raw as Partial<SignerInstanceStatusPayload>;
  if (typeof parsed.instanceId !== 'string') return undefined;
  return {
    instanceId: parsed.instanceId,
    status: parsed.status === 'unlocked' ? 'unlocked' : 'locked',
    unlockCommand: `ccd-config-manager service signer unlock --instance ${parsed.instanceId}`,
  };
}
