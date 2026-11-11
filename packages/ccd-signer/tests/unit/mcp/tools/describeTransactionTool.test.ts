import { beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveNetwork } from '@ccd-agent-kit/config-utils';
import type { ParsedTransaction } from '../../../../src/core/model/parsedTransaction.js';
import { parseTransaction } from '../../../../src/core/parser/parseTransaction.js';
import { annotateParsedTransactionAccounts } from '../../../../src/mcp/annotateParsedTransaction.js';
import { executeDescribeTransactionTool } from '../../../../src/mcp/tools/describeTransactionTool.js';

vi.mock('@ccd-agent-kit/config-utils', () => ({ resolveNetwork: vi.fn() }));
vi.mock('../../../../src/core/parser/parseTransaction.js', () => ({ parseTransaction: vi.fn() }));
vi.mock('../../../../src/mcp/annotateParsedTransaction.js', () => ({ annotateParsedTransactionAccounts: vi.fn() }));

const parsedTransaction = {
  kind: 'accountTransaction', version: 0, payloadType: 'transfer',
  payloadSummary: { kind: 'transfer', amount: '1', toAddress: 'recipient' },
  header: { sender: 'sender', nonce: 1n, expiry: 42, energy: 2n },
  signatureState: { senderSignatureCount: 0, sponsorSignatureCount: 0 },
} satisfies ParsedTransaction;

describe('executeDescribeTransactionTool', () => {
  beforeEach(() => {
    vi.mocked(resolveNetwork).mockReset().mockReturnValue({
      config: { caip2: `ccd:${'11'.repeat(16)}`, genesisHash: '00'.repeat(32), grpc: { host: 'node', port: 20000, ssl: true } },
      name: 'selected',
    });
    vi.mocked(parseTransaction).mockReset().mockReturnValue(parsedTransaction);
    vi.mocked(annotateParsedTransactionAccounts).mockReset().mockReturnValue({ kind: 'projected', nonce: 1n });
  });

  it('forwards transaction and network context and returns the projected JSON result', async () => {
    const result = await executeDescribeTransactionTool({ transactionHex: 'aabb', network: 'selected' });

    expect(resolveNetwork).toHaveBeenCalledWith('selected');
    expect(parseTransaction).toHaveBeenCalledWith('aabb', { format: 'hex' });
    expect(annotateParsedTransactionAccounts).toHaveBeenCalledWith(
      parsedTransaction,
      { caip2Ref: '11'.repeat(16) },
    );
    expect(result).toEqual({
      content: [{ type: 'text', text: JSON.stringify({ kind: 'projected', nonce: '1' }, null, 2) }],
      structuredContent: { kind: 'projected', nonce: '1' },
    });
  });
});
