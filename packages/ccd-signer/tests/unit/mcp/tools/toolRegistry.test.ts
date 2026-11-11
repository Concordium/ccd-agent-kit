import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createSignerToolRegistry } from '../../../../src/mcp/tools/toolRegistry.js';

describe('createSignerToolRegistry', () => {
  it('lists registered tools in insertion order', () => {
    const registry = createSignerToolRegistry();
    const firstSchema = z.object({ value: z.string() });
    const secondSchema = z.object({ count: z.number() });

    registry.register({
      name: 'first',
      description: 'First tool',
      inputSchema: firstSchema,
      handler: async () => ({ content: [{ type: 'text', text: '{}' }], structuredContent: {} }),
    });
    registry.register({
      name: 'second',
      description: 'Second tool',
      inputSchema: secondSchema,
      handler: async () => ({ content: [{ type: 'text', text: '{}' }], structuredContent: {} }),
    });

    expect(registry.list().map((tool) => tool.name)).toEqual(['first', 'second']);
    expect(registry.get('first')?.description).toBe('First tool');
    expect(registry.get('missing')).toBeUndefined();
  });

  it('rejects duplicate tool names', () => {
    const registry = createSignerToolRegistry();
    const schema = z.object({});
    const definition = {
      name: 'duplicate',
      description: 'Duplicate tool',
      inputSchema: schema,
      handler: async () => ({
        content: [{ type: 'text' as const, text: '{}' }],
        structuredContent: {},
      }),
    };

    registry.register(definition);

    expect(() => registry.register(definition)).toThrow('Tool already registered: duplicate');
  });
});
