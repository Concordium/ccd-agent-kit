import { describe, expect, it } from 'vitest';
import { submissionTools } from '../../../../src/mcp/submissions/tools.js';
import { transactionTools } from '../../../../src/mcp/transactions/tools.js';

describe('submission tools', () => {
  it('owns explicit transaction completion and submission', () => {
    expect(submissionTools.map((tool) => tool.name)).toEqual(['complete_transaction', 'complete_account_opening']);
    expect(transactionTools.map((tool) => tool.name)).not.toContain('complete_transaction');
    expect(transactionTools.map((tool) => tool.name)).not.toContain('complete_account_opening');
  });

  it('marks completion tools as destructive, open-world, and non-idempotent', () => {
    for (const tool of submissionTools) {
      expect(tool.annotations).toEqual({
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      });
    }
  });
});
