import { buildConfigureDelegationArgsSchema } from '../internal/schemas.js';
import { buildConfigureDelegationHandler } from '../internal/handlers.js';
import { BUILD_ANNOTATIONS } from '../../toolPlumbing/toolAnnotations.js';
import type { ToolDefinition } from '../../toolPlumbing/toolRegistry.js';

/** `build_configure_delegation` MCP tool definition. */
export const buildConfigureDelegationTool = {
  name: 'build_configure_delegation',
  title: 'Build Configure Delegation',
  description: 'Create an unsigned delegation configuration transaction for signing. Does not sign or submit.',
  annotations: BUILD_ANNOTATIONS,
  inputSchema: buildConfigureDelegationArgsSchema,
  handler: buildConfigureDelegationHandler,
} satisfies ToolDefinition<typeof buildConfigureDelegationArgsSchema>;
