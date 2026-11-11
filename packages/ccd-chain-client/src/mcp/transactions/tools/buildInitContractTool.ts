import { buildInitContractArgsSchema } from '../internal/schemas.js';
import { buildInitContractHandler } from '../internal/handlers.js';
import { BUILD_ANNOTATIONS } from '../../toolPlumbing/toolAnnotations.js';
import type { ToolDefinition } from '../../toolPlumbing/toolRegistry.js';

/** `build_init_contract` MCP tool definition. */
export const buildInitContractTool = {
  name: 'build_init_contract',
  title: 'Build Init Contract',
  description: 'Create an unsigned contract initialization transaction for signing. Does not sign or submit.',
  annotations: BUILD_ANNOTATIONS,
  inputSchema: buildInitContractArgsSchema,
  handler: buildInitContractHandler,
} satisfies ToolDefinition<typeof buildInitContractArgsSchema>;
