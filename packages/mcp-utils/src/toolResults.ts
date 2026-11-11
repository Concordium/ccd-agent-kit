import { stringifyJsonSafe, toJsonSafe } from './json.js';

/** Text content for MCP tool responses. */
export type TextContent = {
  type: 'text';
  text: string;
};

/** Builds a text content block containing pretty JSON. */
export function jsonTextContent(value: unknown): TextContent {
  return { type: 'text', text: stringifyJsonSafe(value) };
}

/** Resource link content for MCP tool responses. */
export type ResourceLinkContent = {
  type: 'resource_link';
  uri: string;
  name: string;
};

/** Content block union (text or resource_link). */
export type ContentBlock = TextContent | ResourceLinkContent;

/** Tool result with structuredContent that is guaranteed bigint-free. */
export interface ToolResultBigIntSafe {
  content: ContentBlock[];
  structuredContent?: unknown;
  isError?: boolean;
  [key: string]: unknown;
}

/** Tool result for MCP tools that only return text content blocks. */
export interface TextToolResultBigIntSafe {
  content: TextContent[];
  structuredContent?: unknown;
  isError?: boolean;
  [key: string]: unknown;
}

/** Builds a text-only MCP tool result with JSON-safe structured content. */
export function jsonTextToolResult(value: unknown): TextToolResultBigIntSafe {
  const text = stringifyJsonSafe(value);
  return {
    content: [{ type: 'text', text }],
    structuredContent: JSON.parse(text),
  };
}

/** Builds a text-only MCP tool error result from already-public error text. */
export function mcpTextToolErrorResult<TStructured = unknown>(input: {
  message: string;
  structuredContent?: TStructured;
}): TextToolResultBigIntSafe {
  return {
    content: [{ type: 'text', text: input.message }],
    isError: true,
    ...(input.structuredContent === undefined ? {} : { structuredContent: toJsonSafe(input.structuredContent) }),
  };
}

/** JSON resource content block used by MCP resource readers. */
export interface JsonResourceContent {
  uri: string;
  mimeType: 'application/json';
  text: string;
}

/** Builds JSON resource content with bigint-safe pretty JSON text. */
export function jsonResourceContent(uri: string, value: unknown): JsonResourceContent {
  return {
    uri,
    mimeType: 'application/json',
    text: stringifyJsonSafe(value),
  };
}
