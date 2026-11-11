import { jsonTextToolResult, mcpTextToolErrorResult } from '@ccd-agent-kit/mcp-utils';
import type { ConcordiumClientError } from '../../concordium/client.js';
import type { ToolContext, ToolHandler, ToolResult } from './toolTypes.js';

const UNKNOWN_TOOL_ERROR_MESSAGE = 'Tool operation failed.';

function publicClientError(err: unknown): ConcordiumClientError | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const candidate = err as Partial<ConcordiumClientError>;
  if (typeof candidate.message !== 'string') return undefined;

  switch (candidate.kind) {
    case 'node':
      if (candidate.code !== undefined && typeof candidate.code !== 'number') return undefined;
      return {
        kind: candidate.kind,
        message: candidate.message,
        ...(candidate.code === undefined ? {} : { code: candidate.code }),
      };
    case 'invalid-argument':
      return { kind: candidate.kind, message: candidate.message };
    case 'chain-capability':
      if (typeof candidate.capability !== 'string' || typeof candidate.network !== 'string') return undefined;
      return {
        kind: candidate.kind,
        message: candidate.message,
        capability: candidate.capability,
        network: candidate.network,
      };
    default:
      return undefined;
  }
}

/** Builds a handled error result by projecting structured producer errors and hiding unknown failures. */
export function toolError(err: unknown): ToolResult {
  const error = publicClientError(err);
  return mcpTextToolErrorResult({
    message: error?.message ?? UNKNOWN_TOOL_ERROR_MESSAGE,
    structuredContent: error === undefined ? undefined : { error },
  }) as ToolResult;
}

/** Wraps an operation in a handler that renders JSON success or a handled MCP error. */
export function jsonTool<Args, T>(run: (ctx: ToolContext, args: Args) => Promise<T>): ToolHandler<Args> {
  return async (ctx, args) => {
    try {
      return jsonTextToolResult(await run(ctx, args));
    } catch (err) {
      return toolError(err);
    }
  };
}
