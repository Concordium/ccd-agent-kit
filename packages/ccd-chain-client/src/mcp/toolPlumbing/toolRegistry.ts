import type { z } from 'zod';
import type { ToolAnnotations, ToolHandler } from './toolTypes.js';

/** Declarative MCP tool registration consumed by the server assembly. */
export interface ToolDefinition<Args extends z.ZodType> {
  name: string;
  title: string;
  description: string;
  annotations?: ToolAnnotations;
  inputSchema: Args;
  handler: ToolHandler<z.infer<Args>>;
}
