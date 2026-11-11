import { jsonTextToolResult, type TextToolResultBigIntSafe } from '@ccd-agent-kit/mcp-utils';
import type { CredentialSignature } from '@concordium/web-sdk';

import {
  createManagedCredentialDeploymentSigningBackend,
  CredentialDeploymentSigningError,
  signCredentialDeployment,
} from '../../core/sign/signCredentialDeployment.js';
import { messageFromUnknown, signerMcpErrorResult } from './toolErrors.js';
import type { YubiKeyService } from '@ccd-agent-kit/piv-utils';

/** Credential deployment handoff plus controls for selecting available credential keys. */
export interface SignCredentialToolArguments {
  /** Signer handoff hex: targetContext || unsignedCredentialDeployment. */
  credDeploymentHex: string;
  /** Existing credential deployment signatures keyed by credential key index. */
  signatures?: CredentialSignature;
  /** Exact credential key indexes to sign, such as ["0", "1"]. */
  keys?: string[];
  /** Maximum number of missing credential key signatures to create. Defaults to 1. */
  maxSignatures?: number;
  /** Optional network name. When omitted, uses the default network. */
  network?: string;
}

/** Stable MCP tool name for credential deployment handoff signing. */
export const signCredentialDeploymentTool = {
  name: 'sign_credential',
} as const;

/**
 * Signs the exact credential deployment preimage without submitting it to a node.
 *
 * @param args - Tool arguments.
 * @param yubiKeyService - Optional process-shared YubiKey service.
 */
export async function executeSignCredentialDeploymentTool(
  args: SignCredentialToolArguments,
  yubiKeyService?: YubiKeyService,
): Promise<TextToolResultBigIntSafe & { structuredContent?: Record<string, unknown> }> {
  try {
    const result = await signCredentialDeployment({
      backend: createManagedCredentialDeploymentSigningBackend(args.network, yubiKeyService),
      keys: args.keys,
      maxSignatures: args.maxSignatures,
      signatures: args.signatures,
      credDeploymentHex: args.credDeploymentHex,
    });
    return jsonTextToolResult(result) as TextToolResultBigIntSafe & { structuredContent: Record<string, unknown> };
  } catch (error) {
    if (error instanceof CredentialDeploymentSigningError) {
      return signerMcpErrorResult({ kind: 'managed-signing-error', message: error.message });
    }
    return signerMcpErrorResult({ kind: 'credential-deployment-signing-failed', message: messageFromUnknown(error) });
  }
}
