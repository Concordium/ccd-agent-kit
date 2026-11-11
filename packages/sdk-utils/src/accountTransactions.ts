import {
  AccountTransactionV0,
  AccountTransactionV1,
  BlockItemKind,
  Payload,
  Transaction,
} from '@concordium/web-sdk';
import * as ed from '@concordium/web-sdk/shims/ed25519';
import { deserializeBlockItem } from '@concordium/web-sdk/wasm';

import { parseHexBytes } from './identity.js';
import { toArrayBuffer } from './internal/bytes.js';
import {
  isEmptySignatureMap,
  normalizeRoleSeparatedSignatureMaps,
  type NormalizedRoleSeparatedSignatureMaps,
  type RoleSeparatedSignatureMaps,
} from './signatures.js';

/** Parsed unsigned account transaction data derived from a standard empty-map block item. */
export type ParsedUnsignedAccountTransaction =
  | {
      version: 0;
      transaction: AccountTransactionV0.Unsigned;
      sender: string;
      unsignedBytes: Buffer;
    }
  | {
      version: 1;
      transaction: AccountTransactionV1.Unsigned;
      sender: string;
      sponsor?: string;
      unsignedBytes: Buffer;
    };

/** Parsed signed block item split into unsigned transaction hex and detached JSON signatures. */
export interface ParsedSignedAccountBlockItem {
  transactionHex: string;
  signatures: NormalizedRoleSeparatedSignatureMaps;
}

/** Input for verifying one detached account transaction signature candidate. */
export interface VerifyAccountTransactionSignatureSlotInput {
  /** Parsed unsigned account transaction whose signing digest is verified. */
  unsigned: ParsedUnsignedAccountTransaction;
  /** Hex-encoded detached Ed25519 signature candidate. */
  signature: string;
  /** Hex-encoded Ed25519 public key for the exact credential/key slot. */
  publicKey: string;
}

/** Parsed or raw unsigned account transaction forms accepted by shared signing helpers. */
export type AccountTransactionSigningDigestInput =
  ParsedUnsignedAccountTransaction | AccountTransactionV0.Unsigned | AccountTransactionV1.Unsigned;

/** Finalized account transaction block item assembled from unsigned hex and detached signatures. */
export interface FinalizedAccountTransactionHex {
  transactionVersion: 'v0' | 'v1';
  blockItemHex: string;
  signatures: NormalizedRoleSeparatedSignatureMaps;
}
/**
 * Serializes an SDK unsigned account transaction as a standard block item with empty signature maps.
 * This is the minimal empty-map encoding the SDK's signed serializer intentionally refuses to produce.
 */
export function serializeUnsignedAccountTransactionHex(
  transaction: AccountTransactionV0.Unsigned | AccountTransactionV1.Unsigned,
): string {
  const header =
    transaction.version === 0
      ? AccountTransactionV0.serializeHeader(transaction.header)
      : AccountTransactionV1.serializeHeader(transaction.header);
  const prefix =
    transaction.version === 0
      ? [BlockItemKind.AccountTransactionKind, 0]
      : [BlockItemKind.AccountTransactionV1Kind, 0, 0];
  return Buffer.concat([Buffer.from(prefix), Buffer.from(header), Buffer.from(Payload.serialize(transaction.payload))]).toString(
    'hex',
  );
}

/**
 * Asserts that a decoded account transaction header declares the exact serialized payload length.
 *
 * @throws {Error} If the declared payload size differs from the decoded payload bytes.
 */
export function assertAccountTransactionPayloadSize(
  transaction:
    | AccountTransactionV0.Unsigned
    | AccountTransactionV0.Type
    | AccountTransactionV1.Unsigned
    | AccountTransactionV1.Type,
): void {
  if (transaction.header.payloadSize !== Payload.serialize(transaction.payload).length) {
    throw new Error('Account transaction header payload size does not match the decoded payload.');
  }
}

/**
 * Parses a standard account block item whose embedded sender and sponsor signature maps are empty.
 * Malformed, truncated, trailing, signed, bare, and legacy encodings are rejected.
 */
export function parseUnsignedAccountTransactionHex(transactionHex: string): ParsedUnsignedAccountTransaction {
  const unsignedBytes = parseHexBytes(transactionHex);
  const blockItem = decodeAccountBlockItem(unsignedBytes);

  if (blockItem.kind === BlockItemKind.AccountTransactionKind) {
    if (!isEmptySignatureMap(blockItem.transaction.signature)) {
      throw new Error('Unsigned account transaction must have an empty sender signature map.');
    }
    const transaction: AccountTransactionV0.Unsigned = {
      version: 0,
      header: blockItem.transaction.header,
      payload: blockItem.transaction.payload,
    };
    if (serializeUnsignedAccountTransactionHex(transaction) !== unsignedBytes.toString('hex')) {
      throw new Error('Unsigned account transaction block item is not canonical.');
    }
    return {
      version: 0,
      transaction,
      sender: transaction.header.sender.toString(),
      unsignedBytes,
    };
  }

  if (
    !isEmptySignatureMap(blockItem.transaction.signatures.sender) ||
    !isEmptySignatureMap(blockItem.transaction.signatures.sponsor ?? {})
  ) {
    throw new Error('Unsigned account transaction must have empty embedded signature maps.');
  }
  const transaction: AccountTransactionV1.Unsigned = {
    version: 1,
    header: blockItem.transaction.header,
    payload: blockItem.transaction.payload,
  };
  if (serializeUnsignedAccountTransactionHex(transaction) !== unsignedBytes.toString('hex')) {
    throw new Error('Unsigned account transaction block item is not canonical.');
  }
  return {
    version: 1,
    transaction,
    sender: transaction.header.sender.toString(),
    ...(transaction.header.sponsor !== undefined ? { sponsor: transaction.header.sponsor.toString() } : {}),
    unsignedBytes,
  };
}

/** Computes the exact digest that account transaction signatures sign. */
export function computeAccountTransactionSigningDigest(unsigned: AccountTransactionSigningDigestInput): Uint8Array {
  const transaction = 'transaction' in unsigned ? unsigned.transaction : unsigned;
  return Uint8Array.from(
    transaction.version === 0
      ? AccountTransactionV0.signDigest(transaction)
      : AccountTransactionV1.signDigest(transaction),
  );
}

/** Verifies one detached signature candidate for an exact account transaction credential/key slot. */
export async function verifyAccountTransactionSignatureSlot(
  input: VerifyAccountTransactionSignatureSlotInput,
): Promise<boolean> {
  return ed.verifyAsync(input.signature, computeAccountTransactionSigningDigest(input.unsigned), input.publicKey);
}

/**
 * Assembles finalized block item hex from parser-owned unsigned transaction data and detached signatures.
 *
 * The parsed transaction must come from {@link parseUnsignedAccountTransactionHex}; this function uses SDK block-item
 * serialization, clones role-separated signature maps once for ownership isolation, and does not mutate caller maps.
 */
export function finalizeParsedAccountTransaction(
  unsigned: ParsedUnsignedAccountTransaction,
  signatures: RoleSeparatedSignatureMaps,
): FinalizedAccountTransactionHex {
  const normalized = normalizeRoleSeparatedSignatureMaps(signatures);

  if (unsigned.version === 0) {
    if (!isEmptySignatureMap(normalized.sponsor)) {
      throw new Error('V0 transactions do not support sponsor signatures.');
    }
    return {
      transactionVersion: 'v0',
      blockItemHex: Buffer.from(
        Transaction.serializeBlockItem(AccountTransactionV0.create(unsigned.transaction, normalized.sender)),
      ).toString('hex'),
      signatures: { sender: normalized.sender, sponsor: {} },
    };
  }

  return {
    transactionVersion: 'v1',
    blockItemHex: Buffer.from(
      Transaction.serializeBlockItem(
        AccountTransactionV1.create(unsigned.transaction, {
          sender: normalized.sender,
          ...(isEmptySignatureMap(normalized.sponsor) ? {} : { sponsor: normalized.sponsor }),
        }),
      ),
    ).toString('hex'),
    signatures: normalized,
  };
}

/** Assembles finalized block item hex from unsigned transaction hex and detached JSON signatures. */
export function finalizeAccountTransactionHex(
  transactionHex: string,
  signatures: RoleSeparatedSignatureMaps,
): FinalizedAccountTransactionHex {
  const unsigned = parseUnsignedAccountTransactionHex(transactionHex);
  return finalizeParsedAccountTransaction(unsigned, signatures);
}

/** Decodes a signed account block item into standard empty-map transaction hex and detached signatures. */
export function parseSignedAccountBlockItemHex(blockItemHex: string): ParsedSignedAccountBlockItem {
  const bytes = parseHexBytes(blockItemHex);
  const blockItem = decodeAccountBlockItem(bytes);
  if (blockItem.kind === BlockItemKind.AccountTransactionKind) {
    const { signature, ...transaction } = blockItem.transaction;
    return {
      transactionHex: serializeUnsignedAccountTransactionHex(transaction),
      signatures: normalizeRoleSeparatedSignatureMaps({ sender: signature }),
    };
  }
  const { signatures, ...transaction } = blockItem.transaction;
  return {
    transactionHex: serializeUnsignedAccountTransactionHex(transaction),
    signatures: normalizeRoleSeparatedSignatureMaps(signatures),
  };
}

function decodeAccountBlockItem(bytes: Uint8Array) {
  const blockItem = deserializeBlockItem(toArrayBuffer(bytes));
  if (
    blockItem === null ||
    (blockItem.kind !== BlockItemKind.AccountTransactionKind &&
      blockItem.kind !== BlockItemKind.AccountTransactionV1Kind)
  ) {
    throw new Error('Block item is not an account transaction.');
  }
  assertAccountTransactionPayloadSize(blockItem.transaction);
  return blockItem;
}
