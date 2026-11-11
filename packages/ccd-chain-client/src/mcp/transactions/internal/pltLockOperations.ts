import {
  CborAccountAddress,
  CborEpoch,
  LockConfig,
  LockId,
  LockMetadata,
  OperationType,
  TokenId,
  type CborMemo,
  type Operation,
} from '@concordium/web-sdk';
import type { McpJsonObject } from '@ccd-agent-kit/mcp-utils';
import { invalidArgument, resolvePltMemo, type BuildPltOperation, type PltTokenContext } from './pltTokenOperations.js';

/** Protocol version 11+ PLT lock operations, which compile only into an unscoped `tokenUpdate` payload. */
export type LockOperation = Extract<
  BuildPltOperation,
  { type: 'lock_create' | 'lock_fund' | 'lock_send' | 'lock_cancel' | 'lock_release' }
>;

interface AccountIndexReader {
  getAccountInfo(address: string): Promise<{ index: string }>;
}

function buildLockCreateOperation(args: {
  recipients: 'any' | string[];
  lockExpiryUnixSeconds: string;
  grants: Array<{ account: string; capabilities: Array<'fund' | 'release' | 'send' | 'cancel'> }>;
  tokenIds: string[];
  keepAlive?: boolean;
  controllerMemo?: CborMemo.Type;
  metadataJson?: McpJsonObject;
}): Operation {
  const recipients =
    args.recipients === 'any'
      ? ('any' as const)
      : args.recipients.map((recipient) => CborAccountAddress.fromBase58(recipient));
  return {
    [OperationType.LockCreate]: LockConfig.simpleV0(
      recipients,
      CborEpoch.fromEpochSeconds(BigInt(args.lockExpiryUnixSeconds)),
      args.grants.map((grant) => ({
        account: CborAccountAddress.fromBase58(grant.account),
        roles: grant.capabilities.map((capability) => {
          switch (capability) {
            case 'fund':
              return LockConfig.SimpleV0Capability.Fund;
            case 'release':
              return LockConfig.SimpleV0Capability.Release;
            case 'send':
              return LockConfig.SimpleV0Capability.Send;
            case 'cancel':
              return LockConfig.SimpleV0Capability.Cancel;
          }
        }),
      })),
      args.tokenIds.map((tokenId) => TokenId.fromString(tokenId)),
      args.keepAlive,
      args.controllerMemo,
      args.metadataJson === undefined ? undefined : LockMetadata.encode(args.metadataJson),
    ),
  };
}

/** Resolves the exactly-one-of `lockId`/`lockRef` contract; `lockRef` must have been created earlier in the same build. */
function resolveLockIdReference(
  operation: { lockId: string | undefined; lockRef: string | undefined },
  lockRefs: Map<string, string>,
): string {
  if (operation.lockId !== undefined) return operation.lockId;
  if (operation.lockRef !== undefined) {
    const resolved = lockRefs.get(operation.lockRef);
    if (resolved === undefined) {
      throw invalidArgument(`Unknown lockRef '${operation.lockRef}'.`);
    }
    return resolved;
  }
  throw invalidArgument('Provide exactly one of lockId or lockRef.');
}

type ExistingLockOperation = Exclude<LockOperation, { type: 'lock_create' }>;

async function buildLockOperation(
  tokens: PltTokenContext,
  operation: ExistingLockOperation,
  lockRefs: Map<string, string>,
): Promise<{ operation: Operation; summary: McpJsonObject }> {
  const memo = resolvePltMemo({ memoText: operation.memoText, memoJson: operation.memoJson });
  const lockId = resolveLockIdReference({ lockId: operation.lockId, lockRef: operation.lockRef }, lockRefs);
  const referenceSummary = {
    ...(operation.lockRef !== undefined ? { lockRef: operation.lockRef } : {}),
    lockId,
  };
  const memoSummary = {
    ...(operation.memoText !== undefined && { memoText: operation.memoText }),
    ...(operation.memoJson !== undefined && { memoJson: operation.memoJson }),
  };

  switch (operation.type) {
    case 'lock_fund': {
      const { amount, summary } = await tokens.resolveAmount(operation.tokenId, operation.amountUnits);
      return {
        operation: {
          [OperationType.LockFund]: {
            token: TokenId.fromString(operation.tokenId),
            lock: LockId.fromString(lockId),
            amount,
            ...(memo !== undefined ? { memo } : {}),
          },
        },
        summary: {
          type: operation.type,
          ...referenceSummary,
          tokenId: operation.tokenId,
          amount: summary,
          ...memoSummary,
        },
      };
    }
    case 'lock_send': {
      const { amount, summary } = await tokens.resolveAmount(operation.tokenId, operation.amountUnits);
      return {
        operation: {
          [OperationType.LockSend]: {
            token: TokenId.fromString(operation.tokenId),
            lock: LockId.fromString(lockId),
            source: CborAccountAddress.fromBase58(operation.sourceAddress),
            amount,
            recipient: CborAccountAddress.fromBase58(operation.toAddress),
            ...(memo !== undefined ? { memo } : {}),
          },
        },
        summary: {
          type: operation.type,
          ...referenceSummary,
          tokenId: operation.tokenId,
          sourceAddress: operation.sourceAddress,
          toAddress: operation.toAddress,
          amount: summary,
          ...memoSummary,
        },
      };
    }
    case 'lock_cancel':
      return {
        operation: {
          [OperationType.LockCancel]: {
            lock: LockId.fromString(lockId),
            ...(memo !== undefined ? { memo } : {}),
          },
        },
        summary: { type: operation.type, ...referenceSummary, ...memoSummary },
      };
    case 'lock_release': {
      const { amount, summary } = await tokens.resolveAmount(operation.tokenId, operation.amountUnits);
      return {
        operation: {
          [OperationType.LockRelease]: {
            token: TokenId.fromString(operation.tokenId),
            lock: LockId.fromString(lockId),
            source: CborAccountAddress.fromBase58(operation.sourceAddress),
            amount,
            ...(memo !== undefined ? { memo } : {}),
          },
        },
        summary: {
          type: operation.type,
          ...referenceSummary,
          tokenId: operation.tokenId,
          sourceAddress: operation.sourceAddress,
          amount: summary,
          ...memoSummary,
        },
      };
    }
  }
}

/**
 * Per-build lock state for the protocol version 11+ unscoped `tokenUpdate` path.
 *
 * A `lock_create` lock id is derived from the sender account index, the resolved transaction sequence number, and a
 * per-build creation counter, so ids depend on the position of the create operation in one build. The counter and
 * the `lockRef` → lock id map are intentionally request-local: a `lockRef` only resolves locks created earlier in the
 * same operation list, and neither state is cached across invocations. The sender account index lookup is lazy and
 * memoized for the build, so builds without `lock_create` never query `getAccountInfo`.
 */
export class PltLockContext {
  private senderAccountIndex: string | undefined;
  private creationOrder = 0n;
  private readonly lockRefs = new Map<string, string>();

  constructor(
    private readonly client: AccountIndexReader,
    private readonly sender: string,
    private readonly sequenceNumber: string,
    private readonly tokens: PltTokenContext,
  ) {}

  /** Memoizes the sender account index for this build only, so builds without `lock_create` never query it. */
  private async getSenderAccountIndex(): Promise<string> {
    if (this.senderAccountIndex !== undefined) return this.senderAccountIndex;
    this.senderAccountIndex = (await this.client.getAccountInfo(this.sender)).index;
    return this.senderAccountIndex;
  }

  /** Builds one lock operation plus its user-facing summary, advancing creation order and recording `lockRef`s. */
  async buildOperation(operation: LockOperation): Promise<{ operation: Operation; summary: McpJsonObject }> {
    if (operation.type !== 'lock_create') {
      return buildLockOperation(this.tokens, operation, this.lockRefs);
    }

    const lockId = LockId.create(
      BigInt(await this.getSenderAccountIndex()),
      BigInt(this.sequenceNumber),
      this.creationOrder,
    ).toString();
    this.creationOrder += 1n;
    const controllerMemo = resolvePltMemo({
      memoText: operation.controllerMemoText,
      memoJson: operation.controllerMemoJson,
    });
    const built = buildLockCreateOperation({
      recipients: operation.recipients,
      lockExpiryUnixSeconds: operation.lockExpiryUnixSeconds,
      grants: operation.grants,
      tokenIds: operation.tokenIds,
      ...(operation.keepAlive !== undefined ? { keepAlive: operation.keepAlive } : {}),
      ...(controllerMemo !== undefined ? { controllerMemo } : {}),
      ...(operation.metadataJson !== undefined ? { metadataJson: operation.metadataJson } : {}),
    });
    if (operation.ref !== undefined) this.lockRefs.set(operation.ref, lockId);
    return {
      operation: built,
      summary: {
        type: operation.type,
        ...(operation.ref !== undefined ? { ref: operation.ref } : {}),
        lockId,
        recipients: operation.recipients,
        lockExpiryUnixSeconds: operation.lockExpiryUnixSeconds,
        grants: operation.grants,
        tokenIds: operation.tokenIds,
        ...(operation.keepAlive !== undefined ? { keepAlive: operation.keepAlive } : {}),
        ...(operation.controllerMemoText !== undefined && {
          controllerMemoText: operation.controllerMemoText,
        }),
        ...(operation.controllerMemoJson !== undefined && {
          controllerMemoJson: operation.controllerMemoJson,
        }),
        ...(operation.metadataJson !== undefined && { metadataJson: operation.metadataJson }),
      },
    };
  }
}
