import { describe, expect, it, vi } from 'vitest';

const dependencies = vi.hoisted(() => ({
  createResourceCatalog: vi.fn(() => []),
  mcpServer: vi.fn(function (this: Record<string, unknown>, identity: unknown) {
    this.identity = identity;
    this.registerTool = vi.fn();
    this.server = { setRequestHandler: vi.fn() };
  }),
  registerMcpResources: vi.fn(),
}));

vi.mock('@modelcontextprotocol/server', () => ({
  McpServer: dependencies.mcpServer,
  ProtocolError: class ProtocolError extends Error {},
  ProtocolErrorCode: { InvalidParams: -32602 },
}));
vi.mock('@ccd-agent-kit/mcp-utils', () => ({
  getStaticSkill: vi.fn(),
  listStaticSkills: vi.fn(),
  MCP_SKILLS_CAPABILITIES: {},
  MCP_SKILLS_GET_METHOD: 'skills/get',
  MCP_SKILLS_LIST_METHOD: 'skills/list',
  registerMcpResources: dependencies.registerMcpResources,
}));
vi.mock('../../../src/mcp/resourcePlumbing/resourceCatalog.js', () => ({
  createResourceCatalog: dependencies.createResourceCatalog,
}));
vi.mock('../../../src/mcp/skills/catalog.js', () => ({ CONCORDIUM_MCP_SKILLS: [] }));
vi.mock('../../../src/mcp/toolPlumbing/registerTools.js', () => ({ TOOL_CATALOG: [] }));

import { createServerFactory } from '../../../src/mcp/server.js';

describe('chain client MCP server identity', () => {
  it('uses the chain-client package name when building a server', async () => {
    const factory = createServerFactory({ clients: {} as never, config: {} as never });

    const server = await factory({} as never);

    expect(dependencies.mcpServer).toHaveBeenCalledWith(
      { name: 'ccd-chain-client', version: '0.1.0' },
      { capabilities: {} },
    );
    expect(server).toBe(dependencies.mcpServer.mock.instances[0]);
  });
});
