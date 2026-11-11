import { buildRegisterDataArgsSchema } from '../internal/schemas.js';
import { buildRegisterDataHandler } from '../internal/handlers.js';
import { BUILD_ANNOTATIONS } from '../../toolPlumbing/toolAnnotations.js';
import type { ToolDefinition } from '../../toolPlumbing/toolRegistry.js';

/** `build_register_data` MCP tool definition. */
export const buildRegisterDataTool = {
  name: 'build_register_data',
  title: 'Build Register Data',
  description: 'Create an unsigned register-data transaction for signing. Does not sign or submit.',
  annotations: BUILD_ANNOTATIONS,
  inputSchema: buildRegisterDataArgsSchema,
  handler: buildRegisterDataHandler,
} satisfies ToolDefinition<typeof buildRegisterDataArgsSchema>;
