import { describe, expect, it, vi } from 'vitest';

import { getCis2TokenBalanceHandler } from '../../../../src/mcp/tokens/handlers.js';
import { FakeConcordiumClient, makeContext } from '../../../helpers/fakes.js';

const ADDRESS = '32dZpZpu929J81XPFPbBxhwdig3v18U8KnBTXK3vrwdhUAk1Bp';

const resolvers = vi.hoisted(() => ({
  account: vi.fn(() => ADDRESS),
  contract: vi.fn(() => ({ index: 7n, subindex: 2n })),
}));

vi.mock('../../../../src/mcp/accounts/accountLabels.js', () => ({ resolveAccountInput: resolvers.account }));
vi.mock('../../../../src/mcp/contracts/contractInstanceLabels.js', () => ({
  resolveContractInstanceInput: resolvers.contract,
}));

describe('getCis2TokenBalanceHandler', () => {
  it('forwards the exact resolved contract, account, and token arguments', async () => {
    const getCis2TokenBalance = vi.fn().mockResolvedValue({ balance: '999' });
    const client = new FakeConcordiumClient();
    client.getCis2TokenBalance = getCis2TokenBalance;

    await getCis2TokenBalanceHandler(makeContext(client, { network: 'testnet' }), {
      contract: 'tokenContract',
      tokenId: 'token-x',
      address: 'accountLabel',
      network: 'testnet',
    });

    expect(resolvers.contract).toHaveBeenCalledWith('tokenContract', 'testnet');
    expect(resolvers.account).toHaveBeenCalledWith('accountLabel', 'testnet');
    expect(getCis2TokenBalance).toHaveBeenCalledWith({ index: 7n, subindex: 2n }, 'token-x', ADDRESS);
  });
});
