import type { TextToolResultBigIntSafe } from '@ccd-agent-kit/mcp-utils';

export type SignerToolResult = TextToolResultBigIntSafe & {
  structuredContent?: Record<string, unknown>;
};

export type SignerToolHandler<Args> = (args: Args) => Promise<SignerToolResult>;
