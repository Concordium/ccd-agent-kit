import { verifyTransactionSignatureArgsSchema } from '../internal/verifyTransactionSignatureTool.js';
import { verifyTransactionSignatureHandler } from '../internal/handlers.js';
import { READ_ANNOTATIONS } from '../../toolPlumbing/toolAnnotations.js';
import type { ToolDefinition } from '../../toolPlumbing/toolRegistry.js';

/** `verify_transaction_signature` MCP tool definition. */
export const verifyTransactionSignatureTool = {
  name: 'verify_transaction_signature',
  title: 'Verify Transaction Signature',
  description: 'Verify detached transaction signatures against on-chain account keys. Does not sign or submit.',
  annotations: READ_ANNOTATIONS,
  inputSchema: verifyTransactionSignatureArgsSchema,
  handler: verifyTransactionSignatureHandler,
} satisfies ToolDefinition<typeof verifyTransactionSignatureArgsSchema>;
