import {
  Cbor,
  TransactionEventTag,
  TransactionKindString,
  TransactionSummaryType,
  type AccountTransactionSummary,
  type BlockItemSummary,
  type OperationEvent,
  type TokenTransferEvent,
} from '@concordium/web-sdk';
import { mcpJsonValueSchema } from '@ccd-agent-kit/mcp-utils';
import { z } from 'zod';
import type {
  AccountTransactionEffectSummaryDTO,
  CcdTransferEffectDTO,
  JsonObject,
  JsonValue,
  TokenEffectDTO,
  TokenTransferEffectDTO,
  TransactionEffectDTO,
  TransactionMemoDTO,
} from './dto.js';
import { formatCcd, formatTokenAmount } from './formats.js';

type JsonReplacerValue = JsonValue | bigint | Uint8Array | Date | object | undefined;
const jsonObjectSchema: z.ZodType<JsonObject> = z.record(z.string(), mcpJsonValueSchema);

function terminalJsonObject(value: object): JsonObject {
  const encoded = JSON.stringify(structuredClone(value), (key: string, item: JsonReplacerValue): JsonReplacerValue => {
    if (key === '__type' || key === 'decodedAddress') return undefined;
    if (typeof item === 'bigint') return item.toString();
    if (Buffer.isBuffer(item)) return item.toString('hex');
    if (item instanceof Uint8Array) return Buffer.from(item).toString('hex');
    return item;
  });
  return jsonObjectSchema.parse(JSON.parse(encoded));
}

/** Decodes memo bytes as a CBOR text string or UTF-8, or undefined when not decodable. */
function memoText(hex: string): string | undefined {
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2 !== 0) return undefined;
  const bytes = Buffer.from(hex, 'hex');
  try {
    const cborText = z.string().safeParse(Cbor.decode(Cbor.fromHexString(hex)));
    if (cborText.success) return cborText.data;
  } catch {
    // Fall back to plain UTF-8 below for non-CBOR memo bytes.
  }
  const direct = bytes.toString('utf8');
  if (Buffer.from(direct, 'utf8').equals(bytes)) return direct;
  return undefined;
}

function normalizedMemo(hex: string): TransactionMemoDTO {
  const text = memoText(hex);
  return text === undefined ? { hex } : { hex, text };
}

function ccdTransfer(
  summary: Extract<
    AccountTransactionSummary,
    { transactionType: TransactionKindString.Transfer | TransactionKindString.TransferWithMemo }
  >,
): CcdTransferEffectDTO {
  const microCcdAmount = summary.transfer.amount.microCcdAmount.toString();
  return {
    from: { type: 'account', address: summary.sender.address },
    to: { type: 'account', address: summary.transfer.to.address },
    amount: { microCcdAmount, display: formatCcd(microCcdAmount) },
    ...(summary.transactionType === TransactionKindString.TransferWithMemo && {
      memo: normalizedMemo(summary.memo.memo),
    }),
  };
}

function tokenTransfer(event: TokenTransferEvent): TokenTransferEffectDTO {
  const value = event.amount.value.toString();
  const decimals = event.amount.decimals;
  return {
    type: 'tokenTransfer',
    tokenId: event.tokenId.toString(),
    amount: { value, decimals, display: formatTokenAmount(value, decimals) },
    ...(event.from !== null && { from: event.from.toString() }),
    ...(event.to !== null && { to: event.to.toString() }),
    ...(event.memo !== undefined && { memo: normalizedMemo(event.memo.toString()) }),
  };
}

function tokenUpdateEvent(event: OperationEvent): TokenEffectDTO {
  switch (event.tag) {
    case TransactionEventTag.TokenTransfer:
      return tokenTransfer(event);
    case TransactionEventTag.LockCreated:
      return {
        type: 'lockCreated',
        lockId: event.lockId.toString(),
        lockConfig: Buffer.from(event.lockConfig.bytes).toString('hex'),
      };
    case TransactionEventTag.LockDestroyed:
      return { type: 'lockDestroyed', lockId: event.lockId.toString() };
    case TransactionEventTag.LockAmount:
    case TransactionEventTag.UnlockAmount: {
      const value = event.amount.value.toString();
      const decimals = event.amount.decimals;
      return {
        type: event.tag === TransactionEventTag.LockAmount ? 'lockAmount' : 'unlockAmount',
        tokenId: event.tokenId.toString(),
        lockId: event.lockId.toString(),
        ...(event.tokenHolder !== null && { tokenHolder: event.tokenHolder.toString() }),
        amount: { value, decimals, display: formatTokenAmount(value, decimals) },
      };
    }
    default:
      return terminalJsonObject(event);
  }
}

function accountTransactionSummary(summary: AccountTransactionSummary): AccountTransactionEffectSummaryDTO {
  const serialized = terminalJsonObject(summary);
  delete serialized.type;
  delete serialized.sender;
  delete serialized.sponsor;
  delete serialized.cost;
  delete serialized.energyCost;
  delete serialized.hash;
  delete serialized.index;
  if (
    summary.transactionType === TransactionKindString.Transfer ||
    summary.transactionType === TransactionKindString.TransferWithMemo
  ) {
    delete serialized.transfer;
    delete serialized.memo;
  } else if (summary.transactionType === TransactionKindString.TokenUpdate) {
    delete serialized.events;
  }

  const common = {
    ...serialized,
    transactionType: summary.transactionType,
    sender: summary.sender.address,
    ...(summary.sponsor !== undefined && {
      sponsor: { address: summary.sponsor.sponsor.address, cost: summary.sponsor.cost.microCcdAmount.toString() },
    }),
    cost: summary.cost.toString(),
    energyCost: summary.energyCost.value.toString(),
    hash: summary.hash.toString(),
  };

  switch (summary.transactionType) {
    case TransactionKindString.Transfer:
    case TransactionKindString.TransferWithMemo:
      return {
        ...common,
        transactionType: summary.transactionType,
        ccdTransfer: ccdTransfer(summary),
        index: summary.index.toString(),
      };
    case TransactionKindString.TokenUpdate:
      return {
        ...common,
        transactionType: summary.transactionType,
        tokenEvents: summary.events.map((event) => (event === null ? null : tokenUpdateEvent(event))),
        index: summary.index.toString(),
      };
    default:
      return { ...common, transactionType: summary.transactionType, index: summary.index.toString() };
  }
}

/** Map a known SDK block-item summary directly to its JSON-safe public DTO. */
export function blockItemSummaryToEventDto(summary: BlockItemSummary): TransactionEffectDTO {
  switch (summary.type) {
    case TransactionSummaryType.AccountTransaction:
      return { type: summary.type, summary: accountTransactionSummary(summary) };
    case TransactionSummaryType.AccountCreation:
      return {
        type: summary.type,
        summary: {
          type: summary.type,
          index: summary.index.toString(),
          energyCost: { value: summary.energyCost.value.toString() },
          hash: { buffer: Buffer.from(summary.hash.buffer).toString('hex') },
          credentialType: summary.credentialType,
          address: { address: summary.address.address },
          regId: summary.regId,
        },
      };
    case TransactionSummaryType.UpdateTransaction:
    case TransactionSummaryType.TokenCreation:
      return { type: summary.type, summary: terminalJsonObject(summary) };
  }
}
