import type { AccountCredentialRefreshError } from '@ccd-agent-kit/config-utils';

const REFRESH_ERROR_MESSAGES: Record<AccountCredentialRefreshError['kind'], string> = {
  node: 'Account credential refresh failed at the node.',
  not_found: 'Account was not found.',
  network: 'Account credential refresh failed over the network.',
  unknown: 'Account credential refresh failed.',
};

/** Classifies a local MCP account-credential refresh failure for persisted cache metadata. */
export function accountCredentialRefreshErrorFromUnknown(error: unknown): AccountCredentialRefreshError {
  const candidate = error as { kind?: unknown } | undefined;
  const kind =
    candidate?.kind === 'invalid-argument'
      ? 'not_found'
      : candidate?.kind === 'node' || candidate?.kind === 'not_found' || candidate?.kind === 'network'
        ? candidate.kind
        : 'unknown';
  return {
    attempted: new Date().toISOString(),
    kind,
    message: REFRESH_ERROR_MESSAGES[kind],
  };
}
