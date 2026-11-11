import { SUBMISSION_ANNOTATIONS } from '../toolPlumbing/toolAnnotations.js';
import type { ToolDefinition } from '../toolPlumbing/toolRegistry.js';
import { completeTransactionArgsSchema } from '../transactions/internal/completeTransactionTool.js';
import { completeTransactionHandler } from './handlers.js';
import { completeAccountOpeningArgsSchema } from './completeAccountOpeningTool.js';
import { completeAccountOpeningHandler } from './handlers.js';

/** `complete_transaction` MCP tool definition. */
export const completeTransactionTool = {
  name: 'complete_transaction',
  title: 'Complete Transaction',
  description:
    'Combine/verify detached signatures, create blockItemHex unless finalize is false, and optionally submit when submit is true. Never signs.',
  annotations: SUBMISSION_ANNOTATIONS,
  inputSchema: completeTransactionArgsSchema,
  handler: completeTransactionHandler,
} satisfies ToolDefinition<typeof completeTransactionArgsSchema>;

/** `complete_account_opening` MCP tool definition. */
export const completeAccountOpeningTool = {
  name: 'complete_account_opening',
  title: 'Complete Account Opening',
  description: 'Verify flat credential signatures, finalize an account-opening block item, and optionally submit. Never signs.',
  annotations: SUBMISSION_ANNOTATIONS,
  inputSchema: completeAccountOpeningArgsSchema,
  handler: completeAccountOpeningHandler,
} satisfies ToolDefinition<typeof completeAccountOpeningArgsSchema>;

/** Submission-domain MCP tools in served order. */
export const submissionTools = [completeTransactionTool, completeAccountOpeningTool] as const;
