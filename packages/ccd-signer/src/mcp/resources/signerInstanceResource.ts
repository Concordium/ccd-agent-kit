import { jsonResourceContent, type TextResourceContent } from '@ccd-agent-kit/mcp-utils';

import type { SignerInstanceStatusPayload } from '@ccd-agent-kit/config-utils';

import { getCurrentSignerInstanceStatus } from '../../core/instance/signerInstance.js';

/** Resource metadata for the current signer MCP instance. */
export const signerInstanceResource = {
  name: 'ccd://signer/instance',
  uri: 'ccd://signer/instance',
  title: 'Concordium Signer Instance',
  description: 'Agent-safe status for this signer MCP process, including unlock guidance when needed.',
  mimeType: 'application/json',
} as const;

/** JSON payload exposed by the signer instance resource. */
export type SignerInstanceResourceContent = SignerInstanceStatusPayload;

/** Builds the signer instance resource payload without exposing local filesystem paths or IPC secrets. */
export function formatSignerInstanceResource(): SignerInstanceResourceContent {
  return getCurrentSignerInstanceStatus();
}

/** Reads the signer instance resource as MCP resource contents. */
export function readSignerInstanceResource(uri: string): TextResourceContent {
  return jsonResourceContent(uri, formatSignerInstanceResource());
}
