import { jsonResourceContent, type TextResourceContent } from '@ccd-agent-kit/mcp-utils';

import { listSignerKeys, type ListedSignerKeys } from '../../core/keys/listSignerKeys.js';

/** Resource metadata for the signer public-key inventory. */
export const keysResource = {
  name: 'ccd://keys',
  uri: 'ccd://keys',
  title: 'Concordium Signer Keys',
  description: 'Public signing keys available to this signer, including optional local labels.',
  mimeType: 'application/json',
} as const;

/** JSON payload exposed by the signer keys resource. */
export type KeysResourceContent = ListedSignerKeys;

/** Builds the signer keys resource payload. */
export function formatKeysResource(): KeysResourceContent {
  return listSignerKeys();
}

/** Reads the signer keys resource as MCP resource contents. */
export function readKeysResource(uri: string): TextResourceContent {
  return jsonResourceContent(uri, formatKeysResource());
}
