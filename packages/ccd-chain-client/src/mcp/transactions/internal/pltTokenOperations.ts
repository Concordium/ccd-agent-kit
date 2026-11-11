import {
  CborAccountAddress,
  CborMemo,
  TokenAdminRole,
  TokenAmount,
  TokenOperationType,
  type TokenAddAllowListOperation,
  type TokenAddDenyListOperation,
  type TokenAssignAdminRolesOperation,
  type TokenBurnOperation,
  type TokenMintOperation,
  type TokenOperation,
  type TokenPauseOperation,
  type TokenRemoveAllowListOperation,
  type TokenRemoveDenyListOperation,
  type TokenRevokeAdminRolesOperation,
  type TokenTransferOperation,
  type TokenUnpauseOperation,
  type TokenUpdateMetadataOperation,
} from '@concordium/web-sdk';
import type { McpJsonObject, McpJsonValue } from '@ccd-agent-kit/mcp-utils';
import type { TokenInfoDTO } from '../../../concordium/dto.js';
import type { BuildPltArgs } from './schemas.js';

/** One accepted `build_plt` operation before account-label resolution; the shared vocabulary for token and lock operations. */
export type BuildPltOperation = BuildPltArgs['operations'][number];

/** PLT token operations that compile into a scoped or unscoped `tokenUpdate` payload. */
export type TokenUpdateOperation = Exclude<BuildPltOperation, { type: `lock_${string}` }>;

interface TokenInfoReader {
  getTokenInfo(tokenId: string): Promise<TokenInfoDTO>;
}

/** Request-local token-info cache for one build; in-flight `getTokenInfo` promises are shared only within that build. */
export class PltTokenContext {
  private readonly tokenInfos = new Map<string, Promise<TokenInfoDTO>>();

  constructor(private readonly client: TokenInfoReader) {}

  /** Returns the in-flight token lookup cached for this build, starting it on first use. */
  getTokenInfo(tokenId: string): Promise<TokenInfoDTO> {
    const cached = this.tokenInfos.get(tokenId);
    if (cached !== undefined) return cached;
    const loaded = this.client.getTokenInfo(tokenId);
    this.tokenInfos.set(tokenId, loaded);
    return loaded;
  }

  /** Converts raw smallest-unit input with the token's own decimals and builds the matching display summary. */
  async resolveAmount(
    tokenId: string,
    amountUnits: string,
  ): Promise<{
    decimals: number;
    amount: TokenAmount.Type;
    summary: { value: string; decimals: number; display: string };
  }> {
    const token = await this.getTokenInfo(tokenId);
    const decimals = token.decimals;
    const amount = TokenAmount.create(BigInt(amountUnits), decimals);
    return {
      decimals,
      amount,
      summary: { value: amountUnits, decimals, display: amount.toString() },
    };
  }
}

/**
 * Resolves the optional PLT memo shared by token and lock operations.
 *
 * `memoText` and `memoJson` are mutually exclusive at the schema boundary; text wins here so the helper stays total
 * for callers that pass raw input. Returning `undefined` keeps memo fields absent from payloads instead of encoding
 * an empty memo.
 */
export function resolvePltMemo(args: {
  memoText: string | undefined;
  memoJson: McpJsonValue | undefined;
}): CborMemo.Type | undefined {
  if (args.memoText !== undefined) return CborMemo.fromString(args.memoText);
  if (args.memoJson !== undefined) return CborMemo.fromAny(args.memoJson);
  return undefined;
}

/** Builds the shared `invalid-argument` tool-error shape used by the PLT builder paths. */
export function invalidArgument(message: string): { kind: 'invalid-argument'; message: string } {
  return { kind: 'invalid-argument', message };
}

function buildTokenSummary(type: string, tokenId: string, details: McpJsonObject): McpJsonObject {
  return { type, tokenId, ...details };
}

type SupplyOperation = Extract<TokenUpdateOperation, { type: 'mint' | 'burn' }>;

function buildSupplyOperation(
  operation: SupplyOperation,
  amount: TokenAmount.Type,
  summary: { value: string; decimals: number; display: string },
): { tokenId: string; operation: TokenOperation; summary: McpJsonObject } {
  let tokenOperation: TokenMintOperation | TokenBurnOperation;
  switch (operation.type) {
    case 'mint':
      tokenOperation = { [TokenOperationType.Mint]: { amount } };
      break;
    case 'burn':
      tokenOperation = { [TokenOperationType.Burn]: { amount } };
      break;
  }
  return {
    tokenId: operation.tokenId,
    operation: tokenOperation,
    summary: buildTokenSummary(operation.type, operation.tokenId, { amount: summary }),
  };
}

type AccessListOperation = Extract<
  TokenUpdateOperation,
  { type: 'add_allow_list' | 'remove_allow_list' | 'add_deny_list' | 'remove_deny_list' }
>;

function buildAccessListOperation(operation: AccessListOperation): {
  tokenId: string;
  operation: TokenOperation;
  summary: McpJsonObject;
} {
  const target = CborAccountAddress.fromBase58(operation.target);
  let tokenOperation:
    | TokenAddAllowListOperation
    | TokenRemoveAllowListOperation
    | TokenAddDenyListOperation
    | TokenRemoveDenyListOperation;
  switch (operation.type) {
    case 'add_allow_list':
      tokenOperation = { [TokenOperationType.AddAllowList]: { target } };
      break;
    case 'remove_allow_list':
      tokenOperation = { [TokenOperationType.RemoveAllowList]: { target } };
      break;
    case 'add_deny_list':
      tokenOperation = { [TokenOperationType.AddDenyList]: { target } };
      break;
    case 'remove_deny_list':
      tokenOperation = { [TokenOperationType.RemoveDenyList]: { target } };
      break;
  }
  return {
    tokenId: operation.tokenId,
    operation: tokenOperation,
    summary: buildTokenSummary(operation.type, operation.tokenId, { target: operation.target }),
  };
}

type AvailabilityOperation = Extract<TokenUpdateOperation, { type: 'pause' | 'unpause' }>;

function buildAvailabilityOperation(operation: AvailabilityOperation): {
  tokenId: string;
  operation: TokenOperation;
  summary: McpJsonObject;
} {
  let tokenOperation: TokenPauseOperation | TokenUnpauseOperation;
  switch (operation.type) {
    case 'pause':
      tokenOperation = { [TokenOperationType.Pause]: {} };
      break;
    case 'unpause':
      tokenOperation = { [TokenOperationType.Unpause]: {} };
      break;
  }
  return {
    tokenId: operation.tokenId,
    operation: tokenOperation,
    summary: buildTokenSummary(operation.type, operation.tokenId, {}),
  };
}

/**
 * Builds one token operation plus its user-facing summary.
 *
 * Amounts are converted with the token's own decimals, so a single build can mix tokens that use different
 * decimals; the per-token info lookup is memoized by `PltTokenContext`. Memo-bearing operations only include the
 * memo field when a memo resolved. The returned `summary` mirrors the accepted input fields rather than the wire
 * format so tool responses stay human-reviewable.
 */
export async function buildTokenOperation(
  tokens: PltTokenContext,
  operation: TokenUpdateOperation,
): Promise<{ tokenId: string; operation: TokenOperation; summary: McpJsonObject }> {
  const amountInfo =
    'amountUnits' in operation ? await tokens.resolveAmount(operation.tokenId, operation.amountUnits) : undefined;
  switch (operation.type) {
    case 'transfer': {
      const memo = resolvePltMemo({ memoText: operation.memoText, memoJson: operation.memoJson });
      const tokenOperation: TokenTransferOperation = {
        [TokenOperationType.Transfer]: {
          amount: amountInfo!.amount,
          recipient: CborAccountAddress.fromBase58(operation.toAddress),
          ...(memo !== undefined ? { memo } : {}),
        },
      };
      return {
        tokenId: operation.tokenId,
        operation: tokenOperation,
        summary: buildTokenSummary(operation.type, operation.tokenId, {
          toAddress: operation.toAddress,
          amount: amountInfo!.summary,
          ...(operation.memoText !== undefined && { memoText: operation.memoText }),
          ...(operation.memoJson !== undefined && { memoJson: operation.memoJson }),
        }),
      };
    }
    case 'mint':
    case 'burn': {
      return buildSupplyOperation(operation, amountInfo!.amount, amountInfo!.summary);
    }
    case 'add_allow_list':
    case 'remove_allow_list':
    case 'add_deny_list':
    case 'remove_deny_list':
      return buildAccessListOperation(operation);
    case 'pause':
    case 'unpause':
      return buildAvailabilityOperation(operation);
    case 'update_metadata': {
      const tokenOperation: TokenUpdateMetadataOperation = {
        [TokenOperationType.UpdateMetadata]: { url: operation.metadataUrl },
      };
      return {
        tokenId: operation.tokenId,
        operation: tokenOperation,
        summary: buildTokenSummary(operation.type, operation.tokenId, {
          metadataUrl: operation.metadataUrl,
        }),
      };
    }
    case 'assign_admin_roles':
    case 'revoke_admin_roles': {
      const details = {
        account: CborAccountAddress.fromBase58(operation.account),
        roles: operation.roles.map((role) => role as TokenAdminRole),
      };
      let tokenOperation: TokenAssignAdminRolesOperation | TokenRevokeAdminRolesOperation;
      switch (operation.type) {
        case 'assign_admin_roles':
          tokenOperation = { [TokenOperationType.AssignAdminRoles]: details };
          break;
        case 'revoke_admin_roles':
          tokenOperation = { [TokenOperationType.RevokeAdminRoles]: details };
          break;
      }
      return {
        tokenId: operation.tokenId,
        operation: tokenOperation,
        summary: buildTokenSummary(operation.type, operation.tokenId, {
          account: operation.account,
          roles: operation.roles,
        }),
      };
    }
  }
}
