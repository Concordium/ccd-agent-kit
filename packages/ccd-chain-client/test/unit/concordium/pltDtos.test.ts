import { describe, expect, it } from 'vitest';
import { toPltCatalogueDto, toPltInfoDto } from '../../../src/concordium/pltDtos.js';

const supply = { value: '1000', decimals: 2, display: '10.00' };

describe('PLT public DTO adapters', () => {
  it('renames catalogue fields into the public resource shape', () => {
    expect(toPltCatalogueDto({ PLTs: [{ tokenId: 'TKN', decimals: 2, 'total supply': supply }] })).toEqual({
      PLTs: [{ tokenId: 'TKN', decimals: 2, totalSupply: supply }],
    });
  });

  it('preserves present token details', () => {
    expect(
      toPltInfoDto({
        tokenId: 'TKN',
        moduleRef: 'module',
        decimals: 2,
        'total supply': supply,
        name: 'Token',
        metadataUrl: 'https://example.com/token.json',
        governanceAccount: 'account',
        allowList: false,
        denyList: true,
        mintable: true,
        burnable: false,
        paused: false,
      }),
    ).toEqual({
      tokenId: 'TKN',
      moduleRef: 'module',
      decimals: 2,
      totalSupply: supply,
      name: 'Token',
      metadataUrl: 'https://example.com/token.json',
      governanceAccount: 'account',
      allowList: false,
      denyList: true,
      mintable: true,
      burnable: false,
      paused: false,
    });
  });

  it('omits all undefined optional token details', () => {
    expect(
      toPltInfoDto({
        tokenId: 'TKN',
        moduleRef: 'module',
        decimals: 2,
        'total supply': supply,
        name: undefined,
        metadataUrl: undefined,
        governanceAccount: undefined,
        allowList: undefined,
        denyList: undefined,
        mintable: undefined,
        burnable: undefined,
        paused: undefined,
      }),
    ).toEqual({ tokenId: 'TKN', moduleRef: 'module', decimals: 2, totalSupply: supply });
  });
});
