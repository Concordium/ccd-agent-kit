import { verifyMessageSignatureArgsSchema, verifyMessageSignatureHandler } from '../handlers.js';
import { READ_ANNOTATIONS } from '../../toolPlumbing/toolAnnotations.js';
import type { ToolDefinition } from '../../toolPlumbing/toolRegistry.js';

/** `verify_message_signature` MCP tool definition. */
export const verifyMessageSignatureTool = {
  name: 'verify_message_signature',
  title: 'Verify Message Signature',
  description: 'Verify a detached message signature against on-chain account keys. Does not sign or submit.',
  annotations: READ_ANNOTATIONS,
  inputSchema: verifyMessageSignatureArgsSchema,
  handler: verifyMessageSignatureHandler,
} satisfies ToolDefinition<typeof verifyMessageSignatureArgsSchema>;
