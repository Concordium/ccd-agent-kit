import {
  TokenId,
  Transaction,
  createTokenOperationWithId,
  createTokenUpdatePayload,
  type Operation,
  type TokenOperation,
} from '@concordium/web-sdk';
import type { BuildTransactionResultDto, McpJsonValue } from '@ccd-agent-kit/mcp-utils';
import type { ConcordiumQueryClient } from '../../../concordium/client.js';
import { resolveProtocolCapabilities, type ChainCapability } from '../../../concordium/protocol.js';
import { resolveAccountInput, sameAccount } from '../../accounts/accountLabels.js';
import type { ToolContext } from '../../toolPlumbing/toolTypes.js';
import type { BuildPltArgs } from './schemas.js';
import {
  buildTransactionWithSponsorship,
  resolveBuildContext,
  resolveBuildMetadata,
  type SponsorableArgs,
} from './buildContext.js';
import {
  PltTokenContext,
  buildTokenOperation,
  invalidArgument,
  type BuildPltOperation,
  type TokenUpdateOperation,
} from './pltTokenOperations.js';
import { PltLockContext, type LockOperation } from './pltLockOperations.js';

/** Narrows a PLT operation to the lock family; the `lock_` prefix is the schema-wide discriminator for protocol version 11+ lock operations. */
function isLockOperation(operation: BuildPltOperation): operation is LockOperation {
  return operation.type.startsWith('lock_');
}

/** Identifies the one token operation that protocol version 10 permits without sender/governance-account equality. */
function isTransferOperation(operation: BuildPltOperation): boolean {
  return operation.type === 'transfer';
}

/** Reads the `tokenId` shared by token operations; lock operations omit it, so callers must handle `undefined`. */
function resolveTokenOperationTokenId(operation: BuildPltOperation): string | undefined {
  return 'tokenId' in operation ? operation.tokenId : undefined;
}

function unsupportedChainCapability(
  capability: ChainCapability,
  network: string,
  message: string,
): { kind: 'chain-capability'; capability: ChainCapability; network: string; message: string } {
  return { kind: 'chain-capability', capability, network, message };
}

/** Maps a lock operation to the chain capability that must exist before protocol version 10 can reject it explicitly. */
function lockOperationCapability(operation: LockOperation): ChainCapability {
  switch (operation.type) {
    case 'lock_create':
      return 'plt.lock.create';
    case 'lock_fund':
      return 'plt.lock.fund';
    case 'lock_send':
      return 'plt.lock.send';
    case 'lock_cancel':
      return 'plt.lock.cancel';
    case 'lock_release':
      return 'plt.lock.release';
  }
}

/**
 * Builds token and lock operations for one protocol version 11+ unscoped `tokenUpdate` payload.
 *
 * Operations are emitted in input order, and `PltLockContext` advances its creation counter and `lockRef` map as
 * lock creates are encountered, so later operations can reference earlier locks in the same build. Token info lookups
 * are shared through one `PltTokenContext`, and each non-lock operation must carry a `tokenId` before construction.
 */
async function buildUnscopedTokenUpdateOperations(
  client: ConcordiumQueryClient,
  sender: string,
  sequenceNumber: string,
  operations: BuildPltOperation[],
): Promise<{ operations: Operation[]; payloadSummary: McpJsonValue[] }> {
  const tokens = new PltTokenContext(client);
  const locks = new PltLockContext(client, sender, sequenceNumber, tokens);
  const builtOperations: Operation[] = [];
  const payloadSummary: McpJsonValue[] = [];

  for (const operation of operations) {
    if (isLockOperation(operation)) {
      const built = await locks.buildOperation(operation);
      builtOperations.push(built.operation);
      payloadSummary.push(built.summary);
      continue;
    }

    const built = await buildTokenOperation(tokens, operation);
    builtOperations.push(createTokenOperationWithId(TokenId.fromString(built.tokenId), built.operation));
    payloadSummary.push(built.summary);
  }

  return { operations: builtOperations, payloadSummary };
}

async function buildTokenUpdateTransaction(
  ctx: ToolContext,
  client: ConcordiumQueryClient,
  args: SponsorableArgs,
  network: string,
  operations: BuildPltOperation[],
): Promise<BuildTransactionResultDto> {
  const built = await buildTokenUpdateOperations(client, args.sender, network, operations);
  const payload = createTokenUpdatePayload({ tokenId: TokenId.fromString(built.tokenId), operations: built.operations });
  const transaction = await buildTransactionWithSponsorship(
    args,
    Transaction.tokenUpdate(payload),
    await resolveBuildMetadata(ctx, args),
  );
  return {
    transactionType: 'tokenUpdate',
    payload: { operations: built.payloadSummary },
    ...transaction,
  };
}

async function buildUnscopedTokenUpdateTransaction(
  ctx: ToolContext,
  client: ConcordiumQueryClient,
  args: SponsorableArgs,
  operations: BuildPltOperation[],
): Promise<BuildTransactionResultDto> {
  const transactionMetadata = await resolveBuildMetadata(ctx, args);
  const built = await buildUnscopedTokenUpdateOperations(
    client,
    args.sender,
    transactionMetadata.sequenceNumber,
    operations,
  );
  const payload = createTokenUpdatePayload({ operations: built.operations });
  const transaction = await buildTransactionWithSponsorship(args, Transaction.tokenUpdate(payload), transactionMetadata);
  return {
    transactionType: 'tokenUpdate',
    payload: { operations: built.payloadSummary },
    ...transaction,
  };
}

/**
 * Builds the protocol version 10 `tokenUpdate` operation list.
 *
 * Batch-shape validation runs before any token lookup: unsupported lock operations are rejected with their
 * capability, and all operations must resolve to exactly one token id, so a multi-token batch fails before a token
 * lookup could mask the single-token restriction. Non-transfer operations additionally require the sender to match
 * the token governance account, resolved from the shared per-build token context.
 */
async function buildTokenUpdateOperations(
  client: ConcordiumQueryClient,
  sender: string,
  network: string,
  operations: BuildPltOperation[],
): Promise<{ tokenId: string; operations: TokenOperation[]; payloadSummary: McpJsonValue[] }> {
  const unsupportedLockOperation = operations.find(isLockOperation);
  if (unsupportedLockOperation !== undefined) {
    throw unsupportedChainCapability(
      lockOperationCapability(unsupportedLockOperation),
      network,
      `PLT lock operations are not available on ${network}.`,
    );
  }
  const tokenUpdateOperations = operations.filter(
    (operation): operation is TokenUpdateOperation => !isLockOperation(operation),
  );
  const tokenIds = new Set<string>();
  for (const operation of tokenUpdateOperations) {
    tokenIds.add(resolveTokenOperationTokenId(operation)!);
  }

  if (tokenIds.size !== 1) {
    throw invalidArgument('Protocol version 10 PLT transactions may only target a single token.');
  }

  const tokenId = tokenIds.values().next().value!;

  const tokens = new PltTokenContext(client);
  const builtOperations: TokenOperation[] = [];
  const payloadSummary: McpJsonValue[] = [];

  for (const operation of tokenUpdateOperations) {
    const governanceAccount = isTransferOperation(operation)
      ? undefined
      : (await tokens.getTokenInfo(tokenId)).governanceAccount;
    if (
      !isTransferOperation(operation) &&
      (governanceAccount === undefined || !sameAccount(governanceAccount, sender))
    ) {
      throw invalidArgument(
        `Protocol version 10 requires sender ${sender} to match governance account ${governanceAccount ?? 'undefined'} for '${operation.type}' on token ${tokenId}.`,
      );
    }
    const built = await buildTokenOperation(tokens, operation);
    builtOperations.push(built.operation);
    payloadSummary.push(built.summary);
  }

  return { tokenId, operations: builtOperations, payloadSummary };
}

/**
 * Resolves account labels to canonical addresses before protocol selection.
 *
 * Only address-bearing fields are rewritten; amounts, memos, roles, and flags pass through untouched. Recipients
 * keep the `any` sentinel because it is not an account label, and lock grants resolve their nested account.
 */
function normalizePltOperation(operation: BuildPltOperation, network: string | undefined): BuildPltOperation {
  switch (operation.type) {
    case 'transfer':
      return { ...operation, toAddress: resolveAccountInput(operation.toAddress, network) };
    case 'add_allow_list':
    case 'remove_allow_list':
    case 'add_deny_list':
    case 'remove_deny_list':
      return { ...operation, target: resolveAccountInput(operation.target, network) };
    case 'assign_admin_roles':
    case 'revoke_admin_roles':
      return { ...operation, account: resolveAccountInput(operation.account, network) };
    case 'lock_create':
      return {
        ...operation,
        recipients:
          operation.recipients === 'any'
            ? ('any' as const)
            : operation.recipients.map((recipient) => resolveAccountInput(recipient, network)),
        grants: operation.grants.map((grant) => ({
          ...grant,
          account: resolveAccountInput(grant.account, network),
        })),
      };
    case 'lock_send':
      return {
        ...operation,
        sourceAddress: resolveAccountInput(operation.sourceAddress, network),
        toAddress: resolveAccountInput(operation.toAddress, network),
      };
    case 'lock_release':
      return { ...operation, sourceAddress: resolveAccountInput(operation.sourceAddress, network) };
    case 'mint':
    case 'burn':
    case 'pause':
    case 'unpause':
    case 'update_metadata':
    case 'lock_fund':
    case 'lock_cancel':
      return operation;
  }
}

/**
 * Builds a sign-ready PLT transaction, selecting the protocol version 10 scoped or version 11+ unscoped `tokenUpdate`
 * payload path from network capabilities. Account labels are normalized once up front so both paths see canonical
 * addresses, and only the selected path resolves transaction metadata.
 */
export async function buildPlt(ctx: ToolContext, args: BuildPltArgs): Promise<BuildTransactionResultDto> {
  const { network, clientCtx, sponsorshipArgs } = resolveBuildContext(ctx, args);
  const normalizedOperations = args.operations.map((operation) => normalizePltOperation(operation, network));
  const client = clientCtx.clients.getClient().client;
  const capabilities = await resolveProtocolCapabilities(client);

  if (capabilities.pltWriteMode === 'unscoped') {
    return buildUnscopedTokenUpdateTransaction(clientCtx, client, sponsorshipArgs, normalizedOperations);
  }

  return buildTokenUpdateTransaction(clientCtx, client, sponsorshipArgs, network, normalizedOperations);
}
