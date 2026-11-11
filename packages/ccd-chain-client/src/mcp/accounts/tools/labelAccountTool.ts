import { labelAccountArgsSchema, labelAccountHandler } from '../handlers.js';
import type { ToolDefinition } from '../../toolPlumbing/toolRegistry.js';

/** `label_account` MCP tool definition for scoped soft account metadata. */
export const labelAccountTool = {
  name: 'label_account',
  title: 'Label Account',
  description: 'Provide label to set a soft account label or remove: true to remove it without changing an operator-protected label.',
  annotations: { openWorldHint: false, idempotentHint: true },
  inputSchema: labelAccountArgsSchema,
  handler: labelAccountHandler,
} satisfies ToolDefinition<typeof labelAccountArgsSchema>;
