import {
  McpServer,
  ProtocolError,
  ProtocolErrorCode,
  type McpServerFactory,
} from '@modelcontextprotocol/server';
import {
  getStaticSkill,
  listStaticSkills,
  MCP_SKILLS_CAPABILITIES,
  MCP_SKILLS_GET_METHOD,
  MCP_SKILLS_LIST_METHOD,
  registerMcpResources,
} from '@ccd-agent-kit/mcp-utils';
import type { ServerConfig } from '../config.js';
import { createResourceCatalog } from './resourcePlumbing/resourceCatalog.js';
import { CONCORDIUM_MCP_SKILLS } from './skills/catalog.js';
import { TOOL_CATALOG } from './toolPlumbing/registerTools.js';
import type { ToolDefinition } from './toolPlumbing/toolRegistry.js';
import type { NetworkClientProvider, ToolContext } from './toolPlumbing/toolTypes.js';
import { z } from 'zod';

const SERVER_NAME = 'ccd-chain-client';
const SERVER_VERSION = '0.1.0';

export interface ServerDependencies {
  config: ServerConfig;
  clients: NetworkClientProvider;
}

/**
 * Returns a factory producing a fresh `McpServer` per serving unit (one HTTP
 * request, or one stdio connection). The client and config are shared.
 */
export const createServerFactory =
  (deps: ServerDependencies): McpServerFactory =>
  async () =>
    buildServer(deps);

/**
 * Builds an `McpServer` by registering the tool registry and resources onto the server.
 */
export async function buildServer(deps: ServerDependencies): Promise<McpServer> {
  const ctx: ToolContext = { clients: deps.clients, config: deps.config };
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: MCP_SKILLS_CAPABILITIES },
  );

  registerSkillHandlers(server);

  for (const definition of TOOL_CATALOG) {
    const tool = definition as ToolDefinition<z.ZodType>;
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        ...(tool.annotations !== undefined && { annotations: tool.annotations }),
      },
      (args) => tool.handler(ctx, args),
    );
  }

  registerMcpResources(server, createResourceCatalog(ctx));

  return server;
}

function registerSkillHandlers(server: McpServer): void {
  server.server.setRequestHandler(
    MCP_SKILLS_LIST_METHOD,
    { params: z.object({ cursor: z.string().optional() }) },
    async () => listStaticSkills(CONCORDIUM_MCP_SKILLS),
  );
  server.server.setRequestHandler(MCP_SKILLS_GET_METHOD, { params: z.object({ uri: z.string() }) }, async ({ uri }) => {
    const result = getStaticSkill(uri, CONCORDIUM_MCP_SKILLS);
    if (result === undefined) {
      throw new ProtocolError(ProtocolErrorCode.InvalidParams, `No skill is served at ${uri}`);
    }
    return result;
  });
}
