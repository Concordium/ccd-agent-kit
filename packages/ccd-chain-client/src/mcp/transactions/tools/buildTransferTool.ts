import { buildTransferArgsSchema } from '../internal/schemas.js';
import { buildTransferHandler } from '../internal/handlers.js';
import { BUILD_ANNOTATIONS } from '../../toolPlumbing/toolAnnotations.js';
import type { ToolDefinition } from '../../toolPlumbing/toolRegistry.js';

/** `build_transfer` MCP tool definition. */
export const buildTransferTool = {
  name: 'build_transfer',
  title: 'Build Transfer',
  description: 'Create an unsigned CCD transfer transaction for signing. Does not sign or submit.',
  annotations: BUILD_ANNOTATIONS,
  inputSchema: buildTransferArgsSchema,
  handler: buildTransferHandler,
} satisfies ToolDefinition<typeof buildTransferArgsSchema>;
