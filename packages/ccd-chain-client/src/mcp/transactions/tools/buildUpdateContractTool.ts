import { buildUpdateContractArgsSchema } from '../internal/schemas.js';
import { buildUpdateContractHandler } from '../internal/handlers.js';
import { BUILD_ANNOTATIONS } from '../../toolPlumbing/toolAnnotations.js';
import type { ToolDefinition } from '../../toolPlumbing/toolRegistry.js';

/** `build_update_contract` MCP tool definition. */
export const buildUpdateContractTool = {
  name: 'build_update_contract',
  title: 'Build Update Contract',
  description: 'Create an unsigned contract update transaction for signing. Does not sign or submit.',
  annotations: BUILD_ANNOTATIONS,
  inputSchema: buildUpdateContractArgsSchema,
  handler: buildUpdateContractHandler,
} satisfies ToolDefinition<typeof buildUpdateContractArgsSchema>;
