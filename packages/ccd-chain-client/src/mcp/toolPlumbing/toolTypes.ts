import type { ResolvedNetwork } from '@ccd-agent-kit/config-utils';
import type { ToolResultBigIntSafe } from '@ccd-agent-kit/mcp-utils';
import type { ConcordiumQueryClient } from '../../concordium/client.js';
import type { ServerConfig } from '../../config.js';

export type { ContentBlock, ResourceLinkContent, TextContent } from '@ccd-agent-kit/mcp-utils';

export interface NetworkClientProvider {
  /** Acquires by current registry selector for tools, or by immutable resolved snapshot for resources. */
  getClient(network?: string | ResolvedNetwork): { client: ConcordiumQueryClient; networkName: string };
}

/** Dependencies shared by every tool handler. */
export interface ToolContext {
  clients: NetworkClientProvider;
  config: ServerConfig;
}

/** Matches the SDK's loose `CallToolResult` shape (index-signature permitting). */
export type ToolResult = ToolResultBigIntSafe;

export type ToolHandler<Args> = (ctx: ToolContext, args: Args) => Promise<ToolResult>;

/** MCP tool annotations surfaced to hosts for rendering tool UIs. */
export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
  destructiveHint?: boolean;
}
