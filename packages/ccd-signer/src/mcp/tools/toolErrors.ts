import { isMcpInvalidArgumentError, mcpTextToolErrorResult, type TextToolResultBigIntSafe } from '@ccd-agent-kit/mcp-utils';

/** Typed MCP tool errors local to the signer adapter. */
export type SignerMcpToolError =
  | { kind: 'missing-account-credentials'; account: string; network: string }
  | { kind: 'no-local-account-key'; account: string; network: string }
  | { kind: 'managed-signing-error'; message: string }
  | { kind: 'signing-failed'; message: string }
  | { kind: 'credential-deployment-signing-failed'; message: string }
  | { kind: 'list-keys-failed'; message: string };

/** User-facing MCP error messages owned by signer tool adapters. */
export const signerMcpToolMessages = {
  credentialDeploymentSigningFailed: (message: string) => `Credential deployment signing failed: ${message}`,
  listKeysFailed: (message: string) => `Failed to list signer keys: ${message}`,
  missingAccountCredentials: (account: string, network: string) =>
    `No finalized account credentials cached for '${account}' on network '${network}'.`,
  noLocalAccountKey: (account: string, network: string) =>
    `No local signer key matches finalized account credentials for '${account}' on network '${network}'.`,
  signingFailed: (message: string) => `Signing failed: ${message}`,
} as const;

/** Renders safe public MCP text for signer tool errors. */
export function renderSignerMcpToolError(error: SignerMcpToolError): string {
  switch (error.kind) {
    case 'credential-deployment-signing-failed':
      return signerMcpToolMessages.credentialDeploymentSigningFailed(sanitizeMcpErrorMessage(error.message));
    case 'list-keys-failed':
      return signerMcpToolMessages.listKeysFailed(sanitizeMcpErrorMessage(error.message));
    case 'managed-signing-error':
      return sanitizeMcpErrorMessage(error.message);
    case 'missing-account-credentials':
      return signerMcpToolMessages.missingAccountCredentials(error.account, error.network);
    case 'no-local-account-key':
      return signerMcpToolMessages.noLocalAccountKey(error.account, error.network);
    case 'signing-failed':
      return signerMcpToolMessages.signingFailed(sanitizeMcpErrorMessage(error.message));
  }
}

/** Converts a typed signer MCP tool error into the public MCP error result shape. */
export function signerMcpErrorResult<TStructured extends Record<string, unknown> = Record<string, unknown>>(
  error: SignerMcpToolError,
): TextToolResultBigIntSafe & { structuredContent?: TStructured } {
  return mcpTextToolErrorResult({ message: renderSignerMcpToolError(error) }) as TextToolResultBigIntSafe & {
    structuredContent?: TStructured;
  };
}

/** Converts unknown thrown values into text safe for public adapter renderers. */
export function messageFromUnknown(error: unknown): string {
  if (isMcpInvalidArgumentError(error)) return sanitizeMcpErrorMessage(error.message);
  return sanitizeMcpErrorMessage(error instanceof Error ? error.message : String(error));
}

function sanitizeMcpErrorMessage(message: string): string {
  return message.replace(/'\/[^']*?'/g, "'[redacted local path]'").replace(/"\/[^"]*?"/g, '"[redacted local path]"');
}
