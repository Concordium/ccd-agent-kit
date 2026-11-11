import { buildUpdateCredentialKeysArgsSchema } from '../internal/schemas.js';
import { buildUpdateCredentialKeysHandler } from '../internal/handlers.js';
import { CACHE_REFRESH_ANNOTATIONS } from '../../toolPlumbing/toolAnnotations.js';
import type { ToolDefinition } from '../../toolPlumbing/toolRegistry.js';

/** `build_update_credential_keys` MCP tool definition. */
export const buildUpdateCredentialKeysTool = {
  name: 'build_update_credential_keys',
  title: 'Build Update Credential Keys',
  description:
    'Create an unsigned transaction that replaces the complete public-key set for one existing account credential after refreshing finalized sender credentials. Does not sign, submit, or wait for finalization; refresh account credentials again after finalized success.',
  annotations: CACHE_REFRESH_ANNOTATIONS,
  inputSchema: buildUpdateCredentialKeysArgsSchema,
  handler: buildUpdateCredentialKeysHandler,
} satisfies ToolDefinition<typeof buildUpdateCredentialKeysArgsSchema>;
