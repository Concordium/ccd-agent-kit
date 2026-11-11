import { simulateContractArgsSchema, simulateContractHandler } from '../handlers.js';
import { READ_ANNOTATIONS } from '../../toolPlumbing/toolAnnotations.js';
import type { ToolDefinition } from '../../toolPlumbing/toolRegistry.js';

/** `simulate_contract` MCP tool definition. */
export const simulateContractTool = {
  name: 'simulate_contract',
  title: 'Simulate Contract',
  description:
    'Simulate a contract receive call without changing chain state, returning result, energy, return value, and events.',
  annotations: READ_ANNOTATIONS,
  inputSchema: simulateContractArgsSchema,
  handler: simulateContractHandler,
} satisfies ToolDefinition<typeof simulateContractArgsSchema>;
