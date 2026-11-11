import { createServer, type Server } from 'node:http';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, type McpHandlerRequestOptions, type McpServerFactory } from '@modelcontextprotocol/server';
import type { ServerConfig } from '../../config.js';

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, MCP-Protocol-Version, Accept, Mcp-Method, Mcp-Name',
};

/**
 * Starts the server over stateless Streamable HTTP. The current protocol has
 * no sessions: every request is self-contained (the SDK negotiates the era
 * from the request itself), so there is no session map, no session-id header
 * and no DELETE lifecycle. Resolves with the bound `http.Server` (useful for
 * tests and shutdown).
 */
export const startHttp = async (config: ServerConfig, serverFactory: McpServerFactory): Promise<Server> => {
  const path = config.http?.path ?? '/mcp';
  const port = config.http?.port ?? 3000;

  const handler = createMcpHandler(serverFactory, {
    legacy: 'stateless',
    onerror: (err) => console.error('ccd-chain-client-mcp: request handling failed', err),
  });

  const withCors = async (request: Request, options?: McpHandlerRequestOptions): Promise<Response> => {
    const response = await handler.fetch(request, options);
    const headers = new Headers(response.headers);
    for (const [name, value] of Object.entries(CORS_HEADERS)) headers.set(name, value);
    return new Response(response.body, { status: response.status, headers });
  };

  const nodeHandler = toNodeHandler({ ...handler, fetch: withCors });

  const httpServer = createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS_HEADERS);
      res.end();
      return;
    }

    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== path) {
      res.writeHead(404, CORS_HEADERS);
      res.end();
      return;
    }

    await nodeHandler(req as unknown as Parameters<typeof nodeHandler>[0], res);
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, () => {
      httpServer.removeListener('error', reject);
      resolve();
    });
  });

  console.error(`ccd-chain-client-mcp: Streamable HTTP on http://localhost:${port}${path}`);
  return httpServer;
};
