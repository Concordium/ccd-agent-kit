import { buildPltArgsSchema } from '../internal/schemas.js';
import { buildPltHandler } from '../internal/handlers.js';
import { BUILD_ANNOTATIONS } from '../../toolPlumbing/toolAnnotations.js';
import type { ToolDefinition } from '../../toolPlumbing/toolRegistry.js';

/** `build_plt` MCP tool definition. */
export const buildPltTool = {
  name: 'build_plt',
  title: 'Build PLT',
  description:
    'Create an unsigned protocol-level token transaction from ordered token and lock operations. Does not sign or submit.',
  annotations: BUILD_ANNOTATIONS,
  inputSchema: buildPltArgsSchema,
  handler: buildPltHandler,
} satisfies ToolDefinition<typeof buildPltArgsSchema>;
