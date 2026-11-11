import { describe, expect, it, vi } from 'vitest';
import { pltResourceFamilies } from '../../../../src/mcp/tokens/resourceDefinitions.js';
import { domainFamily, readDomainResource } from '../../../helpers/domainResources.js';
import { FakeConcordiumClient, makeContext } from '../../../helpers/fakes.js';

describe('PLT resource definitions', () => {
  it('reads the default-network catalogue with public token balance fields', async () => {
    const totalSupply = { value: '12345', decimals: 2, display: '123.45' };
    const client = new FakeConcordiumClient({
      tokenList: { PLTs: [{ tokenId: 'Euro', decimals: 2, 'total supply': totalSupply }] },
    });
    const getTokenList = vi.spyOn(client, 'getTokenList');

    await expect(readDomainResource(pltResourceFamilies(), 'plt-catalogue', makeContext(client))).resolves.toEqual({
      PLTs: [{ tokenId: 'Euro', decimals: 2, totalSupply }],
    });
    expect(getTokenList).toHaveBeenCalledOnce();
  });

  it('routes a network and token id and applies the public token projection', async () => {
    const client = new FakeConcordiumClient({
      tokenInfos: {
        Stream: {
          tokenId: 'Stream',
          decimals: 6,
          moduleRef: 'module-ref',
          name: 'Stream',
          metadataUrl: 'https://example.com',
          governanceAccount: 'governance',
          allowList: false,
          denyList: false,
          mintable: true,
          burnable: true,
          paused: false,
          'total supply': { value: '1000000', decimals: 6, display: '1.000000' },
        },
      },
    });
    const getTokenInfo = vi.spyOn(client, 'getTokenInfo');

    const body = await readDomainResource(pltResourceFamilies(), 'plt', makeContext(client), {
      network: 'testnet', parameters: { tokenId: 'Stream' },
    }) as Record<string, unknown>;

    expect(body).toMatchObject({ tokenId: 'Stream', totalSupply: { value: '1000000' } });
    expect(body).not.toHaveProperty('total supply');
    expect(getTokenInfo).toHaveBeenCalledExactlyOnceWith('Stream');
  });

  it('lists token ids without fetching token details', async () => {
    const client = new FakeConcordiumClient({ tokenIds: ['StreamA', 'StreamB'] });

    await expect(domainFamily(pltResourceFamilies(), 'plt').listDefault?.(makeContext(client))).resolves.toEqual([
      { uri: 'ccd://plt/StreamA', name: 'Concordium PLT StreamA' },
      { uri: 'ccd://plt/StreamB', name: 'Concordium PLT StreamB' },
    ]);
    expect(client.calls.getTokenIds).toBe(1);
    expect(client.calls.getTokenInfo ?? 0).toBe(0);
  });
});
