import type { AccountLabelScopeMatch, resolveNetwork } from '@ccd-agent-kit/config-utils';
import { caip2Reference } from '@ccd-agent-kit/sdk-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { findLabelForAccount, resolveAccountInput, sameAccount } from '../../../../src/mcp/accounts/accountLabels.js';

const mocks = vi.hoisted(() => ({
  findAccountLabelForAddress: vi.fn(),
  findAccountLabelScopes: vi.fn(),
  resolveAccountLabel: vi.fn(),
  resolveNetwork: vi.fn<typeof resolveNetwork>(),
}));

vi.mock('@ccd-agent-kit/config-utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ccd-agent-kit/config-utils')>()),
  findAccountLabelForAddress: mocks.findAccountLabelForAddress,
  findAccountLabelScopes: mocks.findAccountLabelScopes,
  resolveAccountLabel: mocks.resolveAccountLabel,
  resolveNetwork: mocks.resolveNetwork,
}));

const ADDRESS = '32dZpZpu929J81XPFPbBxhwdig3v18U8KnBTXK3vrwdhUAk1Bp';
const NETWORK_REFS = {
  devnet: caip2Reference(`ccd:${'11'.repeat(16)}`),
  mainnet: caip2Reference('ccd:9dd9ca4d19e9393877d2c44b70f89acb'),
  testnet: caip2Reference('ccd:4221332d34e1694168c2a0c0b3fd0f27'),
} as const;

describe('accountLabels', () => {
  beforeEach(() => {
    mocks.findAccountLabelForAddress.mockReset();
    mocks.findAccountLabelScopes.mockReset();
    mocks.resolveAccountLabel.mockReset();
    mocks.resolveNetwork.mockReset().mockImplementation((network) => ({
      name: network ?? 'mainnet',
      config: {
        caip2: `ccd:${NETWORK_REFS.mainnet}`,
        genesisHash: NETWORK_REFS.mainnet.padEnd(64, '0'),
        grpc: { host: 'node.example', port: 20000, ssl: true },
      },
    }));
  });

  it('passes valid addresses through without consulting labels', () => {
    expect(resolveAccountInput(ADDRESS, 'mainnet')).toBe(ADDRESS);
    expect(mocks.resolveAccountLabel).not.toHaveBeenCalled();
  });

  it('resolves local labels and reports sorted unique alternate networks', () => {
    mocks.resolveAccountLabel.mockReturnValueOnce({ address: ADDRESS, label: 'alice' }).mockReturnValueOnce(undefined);
    expect(resolveAccountInput('alice', 'mainnet')).toBe(ADDRESS);

    mocks.findAccountLabelScopes.mockReturnValue([
      scopeMatch('testnet'), scopeMatch('devnet'), scopeMatch('mainnet'),
    ]);
    expect(() => resolveAccountInput('elsewhere', 'mainnet')).toThrow(expect.objectContaining({
      kind: 'invalid-argument', message: expect.stringContaining('devnet and testnet'),
    }));

    mocks.findAccountLabelScopes.mockReturnValue([scopeMatch('testnet')]);
    expect(() => resolveAccountInput('one-other-network', 'mainnet')).toThrow(expect.objectContaining({
      message: expect.stringContaining('It exists for testnet.'),
    }));
  });

  it('trims a bare account label before owner lookup', () => {
    mocks.resolveAccountLabel.mockReturnValue({ address: ADDRESS, label: 'alice' });

    expect(resolveAccountInput(' alice ', 'mainnet')).toBe(ADDRESS);
    expect(mocks.resolveAccountLabel).toHaveBeenCalledWith('alice', '9dd9ca4d19e9393877d2c44b70f89acb');
  });

  it('delegates reverse lookup and safely compares invalid addresses', () => {
    mocks.findAccountLabelForAddress.mockReturnValue('alice');
    expect(findLabelForAccount(ADDRESS, 'mainnet')).toBe('alice');
    expect(sameAccount(ADDRESS, ADDRESS)).toBe(true);
    expect(sameAccount('not-an-address', ADDRESS)).toBe(false);
  });
});

function scopeMatch(network: keyof typeof NETWORK_REFS): AccountLabelScopeMatch {
  return {
    scope: 'network', network, caip2Ref: NETWORK_REFS[network],
    label: 'elsewhere', address: ADDRESS,
  };
}
