import { getCis2TokenBalanceArgsSchema, getCis2TokenBalanceHandler } from '../handlers.js';
import { READ_ANNOTATIONS } from '../../toolPlumbing/toolAnnotations.js';
import type { ToolDefinition } from '../../toolPlumbing/toolRegistry.js';

/** `get_cis2_token_balance` MCP tool definition. */
export const getCis2TokenBalanceTool = {
  name: 'get_cis2_token_balance',
  title: 'Get CIS-2 Token Balance',
  description:
    'Get a CIS-2 token balance from a contract instance in raw smallest units. Decimals come from off-chain CIS-2 metadata.',
  annotations: READ_ANNOTATIONS,
  inputSchema: getCis2TokenBalanceArgsSchema,
  handler: getCis2TokenBalanceHandler,
} satisfies ToolDefinition<typeof getCis2TokenBalanceArgsSchema>;
