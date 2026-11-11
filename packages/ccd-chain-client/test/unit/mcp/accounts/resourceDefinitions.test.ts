import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { resolveAccountLabel } from '@ccd-agent-kit/config-utils';
import type { AccountBalancesDTO, AccountInfoDTO, AccountStakeResourceDTO } from '../../../../src/concordium/dto.js';
import { accountResourceFamilies } from '../../../../src/mcp/accounts/resourceDefinitions.js';
import type { ToolContext } from '../../../../src/mcp/toolPlumbing/toolTypes.js';
import { domainFamily, readDomainResource } from '../../../helpers/domainResources.js';
import { FakeConcordiumClient, makeContext } from '../../../helpers/fakes.js';

const mocks = vi.hoisted(() => ({
  findLabelForAccount: vi.fn(),
  getCompleteAccountCredentials: vi.fn(),
  listAccountLabelAddresses: vi.fn(() => ['address-b', 'address-a']),
  resolveAccountLabel: vi.fn<typeof resolveAccountLabel>(),
  resolveAccountInput: vi.fn((input: string) => `resolved:${input}`),
}));

vi.mock('@ccd-agent-kit/config-utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ccd-agent-kit/config-utils')>()),
  getNetwork: vi.fn(() => ({ caip2: 'ccd:9dd9ca4d19e9393877d2c44b70f89acb' })),
  listAccountLabelAddresses: mocks.listAccountLabelAddresses,
  resolveAccountLabel: mocks.resolveAccountLabel,
}));
vi.mock('../../../../src/mcp/accounts/accountLabels.js', () => ({
  findLabelForAccount: mocks.findLabelForAccount,
  resolveAccountInput: mocks.resolveAccountInput,
}));
vi.mock('../../../../src/mcp/accountCredentialsCache.js', () => ({
  getCompleteAccountCredentials: mocks.getCompleteAccountCredentials,
}));

function read(name: string, ctx: ToolContext, parameters: Record<string, string>, network?: string) {
  return readDomainResource(accountResourceFamilies(), name, ctx, { parameters, ...(network && { network }) });
}

const ACCOUNT_INFO = {
  address: 'canonical',
  'CCD Balance': { value: '1', decimals: 6, display: '0.000001 CCD' },
  sequenceNumber: '7',
  index: '42',
  accountType: 'Baker',
  keys: { threshold: 1, credentialCount: 1, credentialIds: ['credential-0'] },
  PLTs: [],
} satisfies AccountInfoDTO;

const ACCOUNT_BALANCES = {
  address: 'canonical',
  balances: {
    CCD: {
      tokenId: 'CCD',
      decimals: 6,
      totalBalance: { value: '1', decimals: 6, display: '0.000001 CCD' },
      availableBalance: { value: '1', decimals: 6, display: '0.000001 CCD' },
      lockedBalance: { value: '0', decimals: 6, display: '0.000000 CCD' },
      releases: [],
    },
    IMT: {
      tokenId: 'IMT',
      decimals: 2,
      totalBalance: { value: '825', decimals: 2, display: '8.25' },
      availableBalance: { value: '800', decimals: 2, display: '8.00' },
      lockedBalance: { value: '25', decimals: 2, display: '0.25' },
      locks: [],
    },
  },
} satisfies AccountBalancesDTO;

const ACCOUNT_STAKE = {
  address: 'canonical',
  poolStatus: 'Validator',
  stakedAmount: { value: '2000000', decimals: 6, display: '2.000000 CCD' },
  pendingChange: { change: 'NoChange' },
  validator: {
    validatorId: '42',
    restakeEarnings: true,
    isSuspended: false,
  },
} satisfies AccountStakeResourceDTO;

describe('accountResourceFamilies', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findLabelForAccount.mockReturnValue(undefined);
    mocks.resolveAccountLabel.mockReset().mockReturnValue(undefined);
    mocks.resolveAccountInput.mockImplementation((input: string) => `resolved:${input}`);
  });

  it('routes default account indexes directly and projects a labeled summary', async () => {
    mocks.findLabelForAccount.mockReturnValue('alice');
    const client = new FakeConcordiumClient({
      accountsByIndex: { '42': ACCOUNT_INFO },
    });
    const getAccountInfoByIndex = vi.spyOn(client, 'getAccountInfoByIndex');
    const ctx = makeContext(client);

    const result = await read('account', ctx, { account: '42' });

    expect(getAccountInfoByIndex).toHaveBeenCalledWith(42n);
    expect(result).toEqual({
      address: 'canonical',
      label: 'alice',
      sequenceNumber: '7',
      index: '42',
      accountType: 'Validator',
    });
    expect(mocks.resolveAccountInput).not.toHaveBeenCalled();
    expect(mocks.resolveAccountLabel).not.toHaveBeenCalled();
    expect(mocks.findLabelForAccount).toHaveBeenCalledWith('canonical', expect.objectContaining({ name: 'mainnet' }));
  });

  it('preserves the specifically selected catalog label when the node canonicalizes an alias address', async () => {
    mocks.resolveAccountLabel.mockReturnValue({ address: 'alias-address', label: 'Selected' });
    mocks.findLabelForAccount.mockReturnValue('First');
    const client = new FakeConcordiumClient({ accounts: { 'alias-address': ACCOUNT_INFO } });
    const getAccountInfo = vi.spyOn(client, 'getAccountInfo');

    const result = await read('account', makeContext(client), { account: 'selected' }, 'mainnet');

    expect(mocks.resolveAccountLabel).toHaveBeenCalledWith('selected', '9dd9ca4d19e9393877d2c44b70f89acb');
    expect(getAccountInfo).toHaveBeenCalledWith('alias-address');
    expect(result).toMatchObject({ address: 'canonical', label: 'Selected' });
    expect(mocks.findLabelForAccount).not.toHaveBeenCalled();
  });

  it('routes a network-qualified label and enriches the canonical balance address', async () => {
    mocks.findLabelForAccount.mockReturnValue('alice');
    const client = new FakeConcordiumClient({ accountBalances: { 'resolved:alice': ACCOUNT_BALANCES } });
    const getAccountBalances = vi.spyOn(client, 'getAccountBalances');
    const ctx = makeContext(client);

    const result = await read('account-balances', ctx, { account: 'alice' }, 'testnet');

    expect(mocks.resolveAccountInput).toHaveBeenCalledWith('alice', expect.objectContaining({ name: 'testnet' }));
    expect(getAccountBalances).toHaveBeenCalledWith('resolved:alice');
    expect(result).toEqual({ address: 'canonical', label: 'alice', balances: ACCOUNT_BALANCES.balances });
  });

  it('keeps the selected canonical label on a balance returned for an alias address', async () => {
    mocks.resolveAccountLabel.mockReturnValue({ address: 'alias-address', label: 'Selected' });
    mocks.findLabelForAccount.mockReturnValue('First');
    const client = new FakeConcordiumClient({ accountBalances: { 'alias-address': ACCOUNT_BALANCES } });

    const result = await read('account-balances', makeContext(client), { account: 'selected' }, 'mainnet');

    expect(mocks.resolveAccountLabel).toHaveBeenCalledWith('selected', '9dd9ca4d19e9393877d2c44b70f89acb');
    expect(result).toEqual({ address: 'canonical', label: 'Selected', balances: ACCOUNT_BALANCES.balances });
    expect(mocks.findLabelForAccount).not.toHaveBeenCalled();
  });

  it.each([
    {
      network: undefined,
      account: '42',
      selector: '42',
      tokenId: 'CCD',
      resolvedLabel: false,
    },
    {
      network: 'testnet',
      account: 'alice',
      selector: 'resolved:alice',
      tokenId: 'CCD',
      resolvedLabel: true,
    },
    {
      network: undefined,
      account: '42',
      selector: 'canonical',
      tokenId: 'IMT',
      resolvedLabel: false,
      index: 42n,
    },
  ])('projects the $tokenId balance selected by $account', async ({ network, account, selector, tokenId, resolvedLabel, index }) => {
    mocks.findLabelForAccount.mockReturnValue('alice');
    const client = new FakeConcordiumClient({
      accountsByIndex: { '42': ACCOUNT_INFO },
      accountBalances: { canonical: ACCOUNT_BALANCES, 'resolved:alice': ACCOUNT_BALANCES },
    });
    const getAccountBalance = vi.spyOn(client, 'getAccountBalance');
    const getAccountAddressByIndex = vi.spyOn(client, 'getAccountAddressByIndex');

    const result = await read('account-token-balance', makeContext(client), { account, tokenId }, network);

    expect(getAccountBalance).toHaveBeenCalledExactlyOnceWith(selector, tokenId);
    expect(result).toMatchObject({ label: 'alice' });
    if (index === undefined) expect(getAccountAddressByIndex).not.toHaveBeenCalled();
    else expect(getAccountAddressByIndex).toHaveBeenCalledExactlyOnceWith(index);
    if (resolvedLabel) {
      expect(mocks.resolveAccountInput).toHaveBeenCalledExactlyOnceWith(
        'alice',
        expect.objectContaining({ name: 'testnet' }),
      );
    }
    else expect(mocks.resolveAccountInput).not.toHaveBeenCalled();
  });

  it.each([
    {
      network: undefined,
      account: '42',
      address: 'canonical',
      index: 42n,
    },
    {
      network: 'testnet',
      account: 'alice',
      address: 'resolved:alice',
    },
  ])('projects the next sequence number selected by $account', async ({ network, account, address, index }) => {
    mocks.findLabelForAccount.mockReturnValue('alice');
    const client = new FakeConcordiumClient({
      accountsByIndex: { '42': ACCOUNT_INFO },
      sequenceNumbers: {
        canonical: { sequenceNumber: '8', allFinal: true },
        'resolved:alice': { sequenceNumber: '8', allFinal: true },
      },
    });
    const getAccountAddressByIndex = vi.spyOn(client, 'getAccountAddressByIndex');
    const getNextAccountSequenceNumber = vi.spyOn(client, 'getNextAccountSequenceNumber');

    const result = await read('account-next-sequence-number', makeContext(client), { account }, network);

    expect(getNextAccountSequenceNumber).toHaveBeenCalledExactlyOnceWith(address);
    expect(result).toMatchObject({ label: 'alice' });
    if (index === undefined) {
      expect(mocks.resolveAccountInput).toHaveBeenCalledExactlyOnceWith(
        'alice',
        expect.objectContaining({ name: 'testnet' }),
      );
      expect(getAccountAddressByIndex).not.toHaveBeenCalled();
    } else {
      expect(getAccountAddressByIndex).toHaveBeenCalledExactlyOnceWith(index);
      expect(mocks.resolveAccountInput).not.toHaveBeenCalled();
    }
  });

  it('routes an account index to stake data and omits an unavailable account label', async () => {
    mocks.findLabelForAccount.mockReturnValue(undefined);
    const client = new FakeConcordiumClient({
      accountsByIndex: { '42': ACCOUNT_INFO },
      accountStakes: { canonical: ACCOUNT_STAKE },
    });
    const getAccountStake = vi.spyOn(client, 'getAccountStake');

    const result = await read('account-stake', makeContext(client), { account: '42' });

    expect(getAccountStake).toHaveBeenCalledWith('42');
    expect(result).toEqual(ACCOUNT_STAKE);
    expect(result).not.toHaveProperty('label');
    expect(mocks.resolveAccountInput).not.toHaveBeenCalled();
  });

  it('uses the credential cache collaborator and projects only public observation data', async () => {
    mocks.findLabelForAccount.mockReturnValue(undefined);
    mocks.resolveAccountInput.mockReturnValue('address');
    mocks.getCompleteAccountCredentials.mockResolvedValue({
      canonicalAddress: 'canonical',
      observation: {
        accountThreshold: '2',
        credentials: { '0': { threshold: '1', keys: {} } },
        sourceBlock: { hash: 'hash', height: '3', time: 'time' },
      },
      cacheMetadata: 'omitted',
    });
    const queryClient = new FakeConcordiumClient();
    const ctx = makeContext(queryClient);

    const result = await read('account-credentials', ctx, { account: 'alice' });

    expect(mocks.getCompleteAccountCredentials).toHaveBeenCalledWith(
      queryClient,
      expect.objectContaining({ name: 'mainnet' }),
      'address',
    );
    expect(result).toEqual({
      address: 'canonical',
      accountThreshold: '2',
      credentials: { '0': { threshold: '1', keys: {} } },
      sourceBlock: { hash: 'hash', height: '3', time: 'time' },
    });
  });

  it('lists sorted resources from configured account labels only', async () => {
    mocks.getCompleteAccountCredentials.mockResolvedValue({ canonicalAddress: 'cached-only' });
    const ctx = makeContext(new FakeConcordiumClient());
    const listed = await domainFamily(accountResourceFamilies(), 'account').listDefault?.(ctx);

    expect(listed?.map(({ uri }) => uri)).toEqual([
      'ccd://account/address-a',
      'ccd://account/address-a/balances',
      'ccd://account/address-a/stake',
      'ccd://account/address-a/credentials',
      'ccd://account/address-b',
      'ccd://account/address-b/balances',
      'ccd://account/address-b/stake',
      'ccd://account/address-b/credentials',
    ]);
    expect(listed?.some(({ uri }) => uri.includes('cached-only'))).toBe(false);
    expect(mocks.getCompleteAccountCredentials).not.toHaveBeenCalled();
  });

});
