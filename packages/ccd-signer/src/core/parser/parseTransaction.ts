import { Buffer } from 'node:buffer';
import { TextDecoder } from 'node:util';

import {
  AccountTransactionType,
  AccountTransactionV0,
  AccountTransactionV1,
  BlockItemKind,
  type BlockItemCredentialDeployment,
  Cbor,
  DataBlob,
  type Operation,
  OperationType,
  Payload,
  type TokenOperation,
  TokenOperationType,
  type UnknownOperation,
  type UnknownTokenOperation,
  decodeOperations,
  decodeTokenOperations,
  getTransactionKindString,
  jsonUnwrapStringify,
} from '@concordium/web-sdk';
import {
  assertAccountTransactionPayloadSize,
  countSignatureEntries,
  parseHexBytes,
  parseUnsignedAccountTransactionHex,
  summarizeCredentialDeploymentBlockItem,
  summarizeCredentialDeploymentSigningHandoff,
  type ParsedUnsignedAccountTransaction as SdkParsedUnsignedAccountTransaction,
} from '@ccd-agent-kit/sdk-utils';
import { deserializeBlockItem } from '@concordium/web-sdk/wasm';

import type {
  ParsedAccountTransaction,
  ParsedBinaryValue,
  ParsedCredentialDeploymentSigningTransaction,
  ParsedCredentialDeploymentTransaction,
  ParsedOperation,
  ParsedPayloadSummary,
  ParsedTransaction,
  ParsedTransactionHeader,
  ParsedTransactionSignatureState,
} from '../model/parsedTransaction.js';
import { detectTransactionFormat } from './detectTransactionFormat.js';
import { parseOpaqueOperation, parseParsedJsonValue } from './parsedOperations.js';

/**
 * The supported parser error codes.
 */
export type ParseTransactionErrorCode = 'unsupported_format' | 'sdk_parse_failed';

/**
 * Options that control how transaction parsing interprets the raw input.
 */
export interface ParseTransactionOptions {
  /** The explicit input format. When omitted, the parser auto-detects supported hex input. */
  format?: 'hex' | 'auto';
}

/**
 * Error raised when transaction parsing fails.
 */
export class ParseTransactionError extends Error {
  /** The stable parser error code. */
  public readonly code: ParseTransactionErrorCode;

  /**
   * Creates a parser error.
   *
   * @param code - The stable parser error code.
   * @param message - A human-readable error message.
   * @param cause - The original underlying error.
   */
  public constructor(code: ParseTransactionErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.code = code;
    this.name = 'ParseTransactionError';
  }
}

/**
 * Parses a raw transaction input into the normalized inspection model.
 *
 * @param input - The raw transaction input.
 * @param options - Optional parser behavior overrides.
 * @returns The normalized parsed transaction.
 * @throws {ParseTransactionError} If the input format is unsupported or SDK parsing fails.
 */
export function parseTransaction(input: string, options: ParseTransactionOptions = {}): ParsedTransaction {
  const format = resolveFormat(input, options.format);

  try {
    const bytes = parseHexBytes(normalizeHex(input));
    const blockItem = tryDeserializeBlockItem(bytes);

    if (blockItem !== null) {
      switch (blockItem.kind) {
        case BlockItemKind.AccountTransactionKind:
        case BlockItemKind.AccountTransactionV1Kind:
          assertAccountTransactionPayloadSize(blockItem.transaction);
          return normalizeAccountTransaction(blockItem.transaction);
        case BlockItemKind.CredentialDeploymentKind:
          return normalizeCredentialDeployment(blockItem.transaction, bytes);
        default:
          throw new ParseTransactionError('sdk_parse_failed', 'Unsupported block item kind.');
      }
    }

    const credentialDeploymentBlockItem = parseCredentialDeploymentBlockItem(bytes);
    if (credentialDeploymentBlockItem !== null) {
      return credentialDeploymentBlockItem;
    }

    // Credential-deployment signing handoff inputs intentionally overlap with
    // serialized block item prefixes: existing-account handoff hex starts with
    // `01`, as do observed credential deployment block items. Always attempt
    // canonical block-item parsing before this signer-specific fallback.
    const credentialDeploymentSigning = parseCredentialDeploymentSigningHandoff(bytes);
    if (credentialDeploymentSigning !== null) {
      return credentialDeploymentSigning;
    }

    throw new ParseTransactionError('sdk_parse_failed', 'The SDK returned a null block item.');
  } catch (error) {
    if (error instanceof ParseTransactionError) {
      throw error;
    }

    throw new ParseTransactionError('sdk_parse_failed', `Failed to parse ${format} transaction input.`, error);
  }
}

/**
 * Parses standard empty-signature-map account block-item hex through the shared SDK decoder.
 * Preserves the complete block item, including the V1 header bitmap, without guessed wrappers.
 *
 * @param input - Unsigned account-transaction hex.
 * @returns The parsed unsigned account transaction together with its version kind.
 * @throws {ParseTransactionError} If the hex cannot be parsed as an unsigned account transaction.
 */
export function parseUnsignedHexAccountTransaction(
  input: string,
):
  | (Extract<SdkParsedUnsignedAccountTransaction, { version: 0 }> & { kind: BlockItemKind.AccountTransactionKind })
  | (Extract<SdkParsedUnsignedAccountTransaction, { version: 1 }> & { kind: BlockItemKind.AccountTransactionV1Kind }) {
  try {
    const parsed = parseUnsignedAccountTransactionHex(normalizeHex(input));
    return parsed.version === 0
      ? { ...parsed, kind: BlockItemKind.AccountTransactionKind }
      : { ...parsed, kind: BlockItemKind.AccountTransactionV1Kind };
  } catch (error) {
    throw new ParseTransactionError('sdk_parse_failed', 'Unsupported unsigned account transaction hex.', error);
  }
}

function resolveFormat(input: string, format: ParseTransactionOptions['format']): 'hex' {
  if (format !== undefined && format !== 'auto') {
    return format;
  }

  const detectedFormat = detectTransactionFormat(input);
  if (detectedFormat === undefined) {
    throw new ParseTransactionError('unsupported_format', 'Transaction input is not supported transaction hex.');
  }

  return detectedFormat;
}

function normalizeAccountTransaction(
  transaction: AccountTransactionV0.Type | AccountTransactionV1.Type,
): ParsedAccountTransaction {
  if (transaction.payload.type === AccountTransactionType.UpdateCredentialKeys) {
    const payloadType = getTransactionKindString(transaction.payload.type);
    return {
      kind: 'accountTransaction',
      version: transaction.version,
      payloadType,
      payloadSummary: { kind: 'generic', type: payloadType },
      header: normalizeHeader(transaction.header),
      signatureState: normalizeSignatureState(transaction),
    };
  }

  const payloadJson = Payload.toJSON(transaction.payload);

  return {
    kind: 'accountTransaction',
    version: transaction.version,
    payloadType: String(payloadJson.type),
    payloadSummary: normalizePayloadSummary(payloadJson),
    header: normalizeHeader(transaction.header),
    signatureState: normalizeSignatureState(transaction),
  };
}

function normalizeCredentialDeployment(
  transaction: BlockItemCredentialDeployment['transaction'],
  bytes: Uint8Array,
): ParsedCredentialDeploymentTransaction {
  const parsed: ParsedCredentialDeploymentTransaction = {
    kind: 'credentialDeployment',
    expiry: normalizeExpiry(transaction.expiry),
  };
  parsed.expiryDate = formatEpochMillisecondsDate(parsed.expiry);

  try {
    const summary = summarizeCredentialDeploymentBlockItem(bytes);
    parsed.credential = summary.credential;
    parsed.proofs = summary.proofs;
  } catch {
    // SDK parsing is authoritative; the review summary is best-effort for unsupported credential encodings.
  }

  return parsed;
}

function parseCredentialDeploymentBlockItem(bytes: Uint8Array): ParsedCredentialDeploymentTransaction | null {
  try {
    const summary = summarizeCredentialDeploymentBlockItem(bytes);
    return {
      credential: summary.credential,
      expiry: normalizeExpiry(Number(summary.expiry)),
      expiryDate: formatEpochSecondsDate(summary.expiry),
      kind: 'credentialDeployment',
      proofs: summary.proofs,
    };
  } catch {
    return null;
  }
}

function normalizeHeader(header: AccountTransactionV0.Header | AccountTransactionV1.Header): ParsedTransactionHeader {
  return {
    sender: String(header.sender),
    nonce: header.nonce.value,
    expiry: normalizeExpiry(header.expiry.expiryEpochSeconds),
    energy: header.energyAmount.value,
    sponsor: 'sponsor' in header && header.sponsor !== undefined ? String(header.sponsor) : undefined,
  };
}

function normalizeSignatureState(
  transaction: AccountTransactionV0.Type | AccountTransactionV1.Type,
): ParsedTransactionSignatureState {
  if (transaction.version === 0) {
    return {
      senderSignatureCount: countSignatureEntries(transaction.signature ?? {}),
      sponsorSignatureCount: 0,
    };
  }

  return {
    senderSignatureCount: countSignatureEntries(transaction.signatures.sender ?? {}),
    sponsorSignatureCount: countSignatureEntries(transaction.signatures.sponsor ?? {}),
  };
}

function normalizePayloadSummary(payloadJson: {
  type: unknown;
  amount?: unknown;
  toAddress?: unknown;
  memo?: unknown;
  data?: unknown;
  source?: unknown;
  initName?: unknown;
  moduleRef?: unknown;
  param?: unknown;
  address?: unknown;
  receiveName?: unknown;
  message?: unknown;
  stake?: unknown;
  restakeEarnings?: unknown;
  delegationTarget?: unknown;
  openForDelegation?: unknown;
  metadataUrl?: unknown;
  transactionFeeCommission?: unknown;
  bakingRewardCommission?: unknown;
  finalizationRewardCommission?: unknown;
  threshold?: unknown;
  newCredentials?: unknown;
  removeCredentialIds?: unknown;
  tokenId?: unknown;
  variant?: unknown;
  operations?: unknown;
}): ParsedPayloadSummary {
  const type = String(payloadJson.type);

  switch (type) {
    case 'transfer':
      return {
        kind: 'transfer',
        amount: String(payloadJson.amount),
        toAddress: String(payloadJson.toAddress),
      };
    case 'transferWithMemo':
      return {
        kind: 'transferWithMemo',
        amount: String(payloadJson.amount),
        memo: normalizeDataBlobJson(payloadJson.memo),
        toAddress: String(payloadJson.toAddress),
      };
    case 'registerData':
      return {
        data: normalizeDataBlobJson(payloadJson.data),
        kind: 'registerData',
      };
    case 'deployModule':
      return {
        kind: 'deployModule',
        source: String(payloadJson.source),
      };
    case 'initContract':
      return {
        amount: String(payloadJson.amount),
        initName: String(payloadJson.initName),
        kind: 'initContract',
        moduleRef: String(payloadJson.moduleRef),
        param: String(payloadJson.param),
      };
    case 'update':
      return {
        address: normalizeContractAddress(payloadJson.address),
        amount: String(payloadJson.amount),
        kind: 'updateContract',
        message: String(payloadJson.message),
        receiveName: String(payloadJson.receiveName),
      };
    case 'configureDelegation':
      return {
        delegationTarget: normalizeDelegationTarget(payloadJson.delegationTarget),
        kind: 'configureDelegation',
        restakeEarnings: normalizeOptionalBoolean(payloadJson.restakeEarnings),
        stake: normalizeOptionalString(payloadJson.stake),
      };
    case 'configureBaker':
      return {
        bakingRewardCommission: normalizeOptionalNumber(payloadJson.bakingRewardCommission),
        finalizationRewardCommission: normalizeOptionalNumber(payloadJson.finalizationRewardCommission),
        kind: 'configureValidator',
        metadataUrl: normalizeOptionalString(payloadJson.metadataUrl),
        openForDelegation: normalizeOptionalNumber(payloadJson.openForDelegation),
        restakeEarnings: normalizeOptionalBoolean(payloadJson.restakeEarnings),
        stake: normalizeOptionalString(payloadJson.stake),
        transactionFeeCommission: normalizeOptionalNumber(payloadJson.transactionFeeCommission),
      };
    case 'updateCredentials':
      return {
        kind: 'updateCredentials',
        newCredentialCount: Array.isArray(payloadJson.newCredentials) ? payloadJson.newCredentials.length : 0,
        removeCredentialIds: normalizeStringArray(payloadJson.removeCredentialIds),
        threshold: normalizeNumber(payloadJson.threshold),
      };
    case 'tokenUpdate':
      if (payloadJson.variant === 'scoped') {
        return {
          kind: 'tokenUpdate',
          variant: 'scoped',
          tokenId: String(payloadJson.tokenId),
          ...normalizeTokenOperations(payloadJson.operations),
        };
      }
      if (payloadJson.variant === 'unscoped') {
        return {
          kind: 'tokenUpdate',
          variant: 'unscoped',
          ...normalizeOperations(payloadJson.operations),
        };
      }
      throw new ParseTransactionError('sdk_parse_failed', 'Unsupported token-update payload variant.');
    default:
      return {
        kind: 'generic',
        type,
      };
  }
}

function normalizeContractAddress(value: unknown): { index: number; subindex: number } {
  if (value !== null && typeof value === 'object' && 'index' in value && 'subindex' in value) {
    return {
      index: Number((value as { index: unknown }).index),
      subindex: Number((value as { subindex: unknown }).subindex),
    };
  }

  throw new ParseTransactionError('sdk_parse_failed', 'Unable to normalize contract address payload data.');
}

function normalizeDelegationTarget(value: unknown): { delegateType: string; bakerId?: number } | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value !== null && typeof value === 'object' && 'delegateType' in value) {
    return {
      delegateType: String((value as { delegateType: unknown }).delegateType),
      bakerId: 'bakerId' in value ? Number((value as { bakerId: unknown }).bakerId) : undefined,
    };
  }

  throw new ParseTransactionError('sdk_parse_failed', 'Unable to normalize delegation target payload data.');
}

function normalizeOptionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function normalizeOptionalNumber(value: unknown): number | undefined {
  return value === undefined ? undefined : normalizeNumber(value);
}

function normalizeOptionalString(value: unknown): string | undefined {
  return value === undefined ? undefined : String(value);
}

function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item)) : [];
}

function normalizeBigInt(value: unknown): bigint {
  if (typeof value === 'bigint') {
    return value;
  }

  if (typeof value === 'number') {
    return BigInt(value);
  }

  if (value !== null && typeof value === 'object') {
    if ('value' in value) {
      return normalizeBigInt(value.value);
    }

    if ('expiryEpochSeconds' in value) {
      return normalizeBigInt(value.expiryEpochSeconds);
    }
  }

  throw new ParseTransactionError('sdk_parse_failed', `Unable to normalize bigint value from ${String(value)}.`);
}

function normalizeNumber(value: unknown): number {
  if (typeof value === 'number') {
    return value;
  }

  return Number(normalizeBigInt(value));
}

function normalizeExpiry(value: unknown): number {
  const numericValue = normalizeNumber(value);

  // Concordium SDK surfaces transaction expiries in both second-like and millisecond-like forms.
  // Normalize the inspection model to epoch milliseconds for a stable external contract.
  return numericValue < 1_000_000_000_000 ? numericValue * 1000 : numericValue;
}

function normalizeHex(input: string): string {
  const trimmed = input.trim();

  return trimmed.slice(0, 2).toLowerCase() === '0x' ? trimmed.slice(2) : trimmed;
}

/**
 * Decodes and normalizes unscoped PLT operations for transaction inspection.
 *
 * @param value - The SDK JSON operations value, encoded as CBOR hex.
 * @returns The normalized operation list used in parsed transaction summaries.
 */
export function normalizeOperations(value: unknown): {
  operations: ParsedOperation[];
} {
  return decodeCborOperations(value, 'unscoped');
}

function normalizeTokenOperations(value: unknown): {
  operations: ParsedOperation[];
} {
  return decodeCborOperations(value, 'scoped');
}

function decodeCborOperations(
  value: unknown,
  scope: 'scoped' | 'unscoped',
): { operations: ParsedOperation[] } {
  const operationsHex = String(value);

  try {
    const decoded =
      scope === 'unscoped'
        ? decodeOperations(Cbor.fromHexString(operationsHex)).map(projectOperation)
        : decodeTokenOperations(Cbor.fromHexString(operationsHex)).map(projectTokenOperation);
    return {
      operations: decoded,
    };
  } catch (error) {
    throw new ParseTransactionError('sdk_parse_failed', 'Failed to decode token-update operations.', error);
  }
}

function normalizeDecodedOpaqueOperation(operation: UnknownTokenOperation | UnknownOperation): ParsedOperation {
  return parseOpaqueOperation(JSON.parse(jsonUnwrapStringify(operation, 1)));
}

const tokenOperationKeys = new Set<string>(Object.values(TokenOperationType));
const operationKeys = new Set<string>(Object.values(OperationType));

function operationKey(operation: object): string {
  return Object.keys(operation)[0]!;
}

function isKnownTokenOperation(
  operation: TokenOperation | UnknownTokenOperation,
): operation is TokenOperation {
  return tokenOperationKeys.has(operationKey(operation));
}

function isKnownOperation(operation: Operation | UnknownOperation): operation is Operation {
  return operationKeys.has(operationKey(operation));
}

function knownOperation(operation: TokenOperation | Operation): ParsedOperation {
  return { kind: 'knownOperation', operation, participantLabels: new Map() };
}

function projectTokenOperation(operation: TokenOperation | UnknownTokenOperation): ParsedOperation {
  return isKnownTokenOperation(operation) ? knownOperation(operation) : normalizeDecodedOpaqueOperation(operation);
}

function projectOperation(operation: Operation | UnknownOperation): ParsedOperation {
  return isKnownOperation(operation) ? knownOperation(operation) : normalizeDecodedOpaqueOperation(operation);
}

function normalizeDataBlobJson(value: unknown): ParsedBinaryValue {
  const hex = String(value);

  try {
    const blob = DataBlob.fromJSON(hex);
    return normalizeBinaryValue(hex, Uint8Array.from(blob.data));
  } catch {
    return { hex };
  }
}

function normalizeBinaryValue(hex: string, bytes: Uint8Array): ParsedBinaryValue {
  const text = tryDecodePrintableUtf8(bytes);
  const cbor = tryDecodeCbor(bytes);

  return {
    hex,
    ...(text === undefined ? {} : { text }),
    ...(cbor === undefined ? {} : { cbor }),
    ...(text === undefined && typeof cbor === 'string' ? { text: cbor } : {}),
  };
}

function tryDecodePrintableUtf8(bytes: Uint8Array): string | undefined {
  try {
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return /^(?:[\t\n\r]|[\x20-\x7e])+$/.test(decoded) ? decoded : undefined;
  } catch {
    return undefined;
  }
}

function tryDecodeCbor(bytes: Uint8Array): import('../model/parsedTransaction.js').ParsedJsonValue | undefined {
  try {
    return parseParsedJsonValue(normalizeDecodedValue(Cbor.decode(Cbor.fromBuffer(Uint8Array.from(bytes).buffer))));
  } catch {
    return undefined;
  }
}

function normalizeDecodedValue(value: unknown): unknown {
  if (value instanceof Uint8Array) {
    return Buffer.from(value).toString('hex');
  }

  if (Array.isArray(value)) {
    return value.map(normalizeDecodedValue);
  }

  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, normalizeDecodedValue(entry)]));
  }

  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
}

function tryDeserializeBlockItem(bytes: Uint8Array) {
  try {
    return deserializeBlockItem(Uint8Array.from(bytes).buffer);
  } catch {
    return null;
  }
}

function parseCredentialDeploymentSigningHandoff(
  bytes: Uint8Array,
): ParsedCredentialDeploymentSigningTransaction | null {
  try {
    const summary = summarizeCredentialDeploymentSigningHandoff(bytes);
    const targetContextLength = summary.target.type === 'new_account' ? 9 : 33;
    const target =
      summary.target.type === 'new_account'
        ? {
            ...summary.target,
            messageExpiryDate: formatEpochSecondsDate(summary.target.messageExpiry),
          }
        : summary.target;
    return {
      credential: summary.credential,
      credentialPublicKeys: summary.credential.credentialPublicKeys,
      kind: 'credentialDeploymentSigning',
      proofs: summary.proofs,
      target,
      targetContextHex: Buffer.from(bytes.slice(0, targetContextLength)).toString('hex'),
      unsignedCredentialDeploymentHex: Buffer.from(bytes.slice(targetContextLength)).toString('hex'),
    };
  } catch {
    return null;
  }
}

function formatEpochSecondsDate(value: string): string {
  return formatEpochMillisecondsDate(Number(value) * 1000);
}

function formatEpochMillisecondsDate(value: number): string {
  return new Date(value).toISOString();
}
