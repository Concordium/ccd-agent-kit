import { syncAccountCredentialsArgsSchema, syncAccountCredentialsHandler } from '../handlers.js';
import { CACHE_REFRESH_ANNOTATIONS } from '../../toolPlumbing/toolAnnotations.js';
import type { ToolDefinition } from '../../toolPlumbing/toolRegistry.js';

/** `sync_account_credentials` MCP tool definition. */
export const syncAccountCredentialsTool = {
  name: 'sync_account_credentials',
  title: 'Sync Account Credentials',
  description:
    'Fetch finalized on-chain credential keys for an account and store them locally so signer tools can detect accounts they can sign for.',
  annotations: CACHE_REFRESH_ANNOTATIONS,
  inputSchema: syncAccountCredentialsArgsSchema,
  handler: syncAccountCredentialsHandler,
} satisfies ToolDefinition<typeof syncAccountCredentialsArgsSchema>;
