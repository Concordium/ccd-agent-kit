import {
  invalidMcpResourceUri,
  stringifyJsonSafe,
  type BoundMcpResourceDefinition,
  type TextResourceContent,
} from '@ccd-agent-kit/mcp-utils';
export { invalidMcpResourceUri as invalidUri } from '@ccd-agent-kit/mcp-utils';

export interface ResourceInstance {
  uri: string;
  name: string;
}

export function jsonResource(value: unknown): Omit<TextResourceContent, 'uri'> {
  return { text: stringifyJsonSafe(value), mimeType: 'application/json' };
}

/** Matches a domain-owned URI pattern and passes its captures to the resource reader. */
export function readResource(
  pattern: RegExp,
  read: (uri: string, ...segments: string[]) => ReturnType<BoundMcpResourceDefinition['read']>,
): BoundMcpResourceDefinition['read'] {
  return async (uri) => {
    const segments = pattern.exec(uri)?.slice(1);
    if (segments === undefined || segments.some((segment) => segment === undefined)) throw invalidMcpResourceUri(uri);
    return read(uri, ...segments);
  };
}
