import { serveStdio } from '@modelcontextprotocol/server/stdio';
import type { McpServerFactory } from '@modelcontextprotocol/server';

/** Starts the server over stdio (MCP `stdio` transport). */
export const startStdio = async (serverFactory: McpServerFactory): Promise<{ close: () => Promise<void> }> =>
  serveStdio(serverFactory, {
    onerror: (err) => console.error('ccd-chain-client-mcp: stdio error', err),
  });
