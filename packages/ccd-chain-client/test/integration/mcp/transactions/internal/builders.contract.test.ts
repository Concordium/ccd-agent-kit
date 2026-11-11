import { describe, expect, it } from 'vitest';
import { buildUpdateContract } from '../../../../../src/mcp/transactions/internal/builders.js';
import { installContractInstanceLabelsFixture } from '../../../../helpers/accountLabels.js';
import { MAINNET_REF, SENDER, ctx } from '../../../../mcp/transactions/internal/builders.fixtures.js';

describe('contract builder integration', () => {
  it('resolves a configured contract instance label into the canonical payload address', async () => {
    const restore = installContractInstanceLabelsFixture(MAINNET_REF, {
      updater: { index: '12', subindex: '0' },
    });
    try {
      const result = await buildUpdateContract(ctx, {
        sender: SENDER,
        contract: 'updater',
        receiveName: 'demo.receive',
      });

      expect(result.transactionHex).toMatch(/^[0-9a-f]+$/);
      expect(result.payload).toMatchObject({ contract: { index: '12', subindex: '0', address: '12,0' } });
    } finally {
      restore();
    }
  });
});
