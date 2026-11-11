import type { z } from 'zod';
import type { SignerToolHandler } from './toolTypes.js';

export interface SignerToolDefinition<Args extends z.ZodType> {
  name: string;
  description: string;
  inputSchema: Args;
  outputSchema?: z.ZodType;
  handler: SignerToolHandler<z.infer<Args>>;
}

export interface SignerToolRegistry {
  register<Args extends z.ZodType>(definition: SignerToolDefinition<Args>): void;
  list(): Array<SignerToolDefinition<z.ZodType>>;
  get(name: string): SignerToolDefinition<z.ZodType> | undefined;
}

/** Creates a signer MCP tool registry that rejects duplicate tool names. */
export function createSignerToolRegistry(): SignerToolRegistry {
  const tools = new Map<string, SignerToolDefinition<z.ZodType>>();
  return {
    register<Args extends z.ZodType>(definition: SignerToolDefinition<Args>): void {
      if (tools.has(definition.name)) {
        throw new Error(`Tool already registered: ${definition.name}`);
      }
      tools.set(definition.name, definition as SignerToolDefinition<z.ZodType>);
    },
    list(): Array<SignerToolDefinition<z.ZodType>> {
      return [...tools.values()];
    },
    get(name: string): SignerToolDefinition<z.ZodType> | undefined {
      return tools.get(name);
    },
  };
}
