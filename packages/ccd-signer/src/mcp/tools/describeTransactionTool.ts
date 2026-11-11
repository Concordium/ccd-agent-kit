import { jsonTextContent, toJsonSafe, type TextContent, type TextToolResultBigIntSafe } from '@ccd-agent-kit/mcp-utils';
import { resolveNetwork } from '@ccd-agent-kit/config-utils';
import { z } from 'zod';
import { caip2Reference } from '../../core/config/grpc.js';
import { parseTransaction } from '../../core/parser/parseTransaction.js';
import { annotateParsedTransactionAccounts } from '../annotateParsedTransaction.js';

/** Transaction bytes and optional network context used to enrich decoded account addresses with local names. */
export interface DescribeTransactionToolArguments {
  /** The serialized Concordium transaction hex input. */
  transactionHex: string;
  /** Optional network name. When omitted, uses the default network. */
  network?: string;
}

/** JSON text content block for decoded transaction review output. */
export type DescribeTransactionToolContent = TextContent;

/** Decode result paired with structured JSON so agents do not need to parse text. */
export type DescribeTransactionToolResult = TextToolResultBigIntSafe & {
  structuredContent: Record<string, unknown>;
};

/** Stable MCP tool name for decoding transaction and block-item handoff hex. */
export const describeTransactionTool = {
  name: 'describe_transaction',
} as const;

/** Decodes transaction hex without signing, submitting, or querying private key material. */
export async function executeDescribeTransactionTool(
  arguments_: DescribeTransactionToolArguments,
): Promise<DescribeTransactionToolResult> {
  const network = resolveNetwork(arguments_.network);
  const parsed = parseTransaction(arguments_.transactionHex, { format: 'hex' });
  const structuredContent = z.record(z.string(), z.unknown()).parse(toJsonSafe(annotateParsedTransactionAccounts(parsed, {
    caip2Ref: caip2Reference(network.config.caip2),
  })));

  return {
    content: [jsonTextContent(structuredContent)],
    structuredContent,
  };
}
