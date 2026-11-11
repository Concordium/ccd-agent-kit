import type { PLTCatalogueDto, PLTCatalogueItemDto, PLTInfoDto } from '@ccd-agent-kit/mcp-utils';
import type { TokenDTO, TokenInfoDTO, TokenListDTO } from './dto.js';

/** Converts a chain token catalogue entry into the MCP PLT catalogue DTO. */
export function toPltCatalogueItemDto(token: TokenDTO): PLTCatalogueItemDto {
  return {
    tokenId: token.tokenId,
    decimals: token.decimals,
    totalSupply: token['total supply'],
  };
}

/** Converts a chain token catalogue into the MCP PLT catalogue DTO. */
export function toPltCatalogueDto(list: TokenListDTO): PLTCatalogueDto {
  return { PLTs: list.PLTs.map(toPltCatalogueItemDto) };
}

/** Converts full chain token details into the MCP PLT info DTO. */
export function toPltInfoDto(info: TokenInfoDTO): PLTInfoDto {
  return {
    tokenId: info.tokenId,
    moduleRef: info.moduleRef,
    decimals: info.decimals,
    totalSupply: info['total supply'],
    ...(info.name !== undefined && { name: info.name }),
    ...(info.metadataUrl !== undefined && { metadataUrl: info.metadataUrl }),
    ...(info.governanceAccount !== undefined && { governanceAccount: info.governanceAccount }),
    ...(info.allowList !== undefined && { allowList: info.allowList }),
    ...(info.denyList !== undefined && { denyList: info.denyList }),
    ...(info.mintable !== undefined && { mintable: info.mintable }),
    ...(info.burnable !== undefined && { burnable: info.burnable }),
    ...(info.paused !== undefined && { paused: info.paused }),
  };
}
