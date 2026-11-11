import { buildConfigureBakerArgsSchema } from '../internal/schemas.js';
import { buildConfigureBakerHandler } from '../internal/handlers.js';
import { BUILD_ANNOTATIONS } from '../../toolPlumbing/toolAnnotations.js';
import type { ToolDefinition } from '../../toolPlumbing/toolRegistry.js';

/** `build_configure_baker` MCP tool definition. */
export const buildConfigureBakerTool = {
  name: 'build_configure_baker',
  title: 'Build Configure Baker',
  description: 'Create an unsigned validator configuration transaction for signing. Does not sign or submit.',
  annotations: BUILD_ANNOTATIONS,
  inputSchema: buildConfigureBakerArgsSchema,
  handler: buildConfigureBakerHandler,
} satisfies ToolDefinition<typeof buildConfigureBakerArgsSchema>;
