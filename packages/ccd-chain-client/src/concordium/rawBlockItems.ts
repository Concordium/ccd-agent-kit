import {
  AccountAddress,
  AccountTransactionV0,
  AccountTransactionV1,
  BlockItemKind,
  Energy,
  SequenceNumber,
  TransactionExpiry,
  TransactionHash,
  serializeAccountTransactionSignature,
  type ConcordiumGRPCClient,
} from '@concordium/web-sdk';
import type { BlockItemDTO } from './dto.js';
import { guard } from './errors.js';

type WireValue<T> = { value?: T };
type WireSignature = { signatures: Record<number, { signatures: Record<number, { value: Uint8Array }> }> };
type WireHeader = {
  sender?: WireValue<Uint8Array>;
  sequenceNumber?: WireValue<bigint>;
  energyAmount?: WireValue<bigint>;
  expiry?: WireValue<bigint>;
  sponsor?: WireValue<Uint8Array>;
};
type WirePayload = { oneofKind: 'rawPayload' | undefined; rawPayload?: Uint8Array };
interface RawBlockItemResponse {
  hash?: WireValue<Uint8Array>;
  blockItem: {
    oneofKind:
      | 'accountTransaction'
      | 'accountTransactionV1'
      | 'credentialDeployment'
      | 'updateInstruction'
      | 'rawBlockItem'
      | undefined;
    accountTransaction?: { signature?: WireSignature; header?: WireHeader; payload?: { payload: WirePayload } };
    accountTransactionV1?: {
      signatures?: { senderSignatures?: WireSignature; sponsorSignatures?: WireSignature };
      header?: WireHeader;
      payload?: { payload: WirePayload };
    };
    credentialDeployment?: { messageExpiry?: WireValue<bigint>; payload: WirePayload };
    rawBlockItem?: Uint8Array;
  };
}

// SDK 13 alpha does not export the generated protobuf service types or a public
// raw-block-item API. Keep the private-client bridge here; SDK serializers still
// own transaction headers and signature encoding. This module never signs.
function rawClient(grpc: ConcordiumGRPCClient) {
  return (
    grpc as unknown as {
      client: {
        getBlockItems(input: { blockHashInput: { oneofKind: 'given'; given: { value: Uint8Array } } }): {
          responses: AsyncIterable<RawBlockItemResponse>;
        };
        sendBlockItem(input: { blockItem: { oneofKind: 'rawBlockItem'; rawBlockItem: Uint8Array } }): {
          response: Promise<WireValue<Uint8Array>>;
        };
      };
    }
  ).client;
}

function signatureToSdk(signature: WireSignature): Record<number, Record<number, string>> {
  return Object.fromEntries(
    Object.entries(signature.signatures).map(([credentialIndex, keyMap]) => [
      Number(credentialIndex),
      Object.fromEntries(
        Object.entries(keyMap.signatures).map(([keyIndex, sig]) => [
          Number(keyIndex),
          Buffer.from(sig.value).toString('hex'),
        ]),
      ),
    ]),
  );
}

function addressFromBytes(bytes: Uint8Array = new Uint8Array()) {
  return AccountAddress.fromBuffer(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  );
}

function headerToSdk(header: WireHeader, payload: Uint8Array) {
  return {
    sender: addressFromBytes(header.sender?.value),
    nonce: SequenceNumber.create(header.sequenceNumber?.value ?? 0n),
    expiry: TransactionExpiry.fromEpochSeconds(header.expiry?.value ?? 0n),
    energyAmount: Energy.create(header.energyAmount?.value ?? 0n),
    payloadSize: payload.length,
  };
}

function serializeItem(item: RawBlockItemResponse['blockItem']): Pick<BlockItemDTO, 'blockItemKind' | 'blockItemHex'> {
  switch (item.oneofKind) {
    case 'rawBlockItem':
      if (item.rawBlockItem === undefined)
        throw { kind: 'node', message: 'Raw block item response was missing raw bytes.' };
      return { blockItemKind: 'rawBlockItem', blockItemHex: Buffer.from(item.rawBlockItem).toString('hex') };
    case 'accountTransaction': {
      const tx = item.accountTransaction;
      if (tx === undefined) throw { kind: 'node', message: 'Account transaction block item payload was missing.' };
      const payload = tx.payload?.payload.oneofKind === 'rawPayload' ? tx.payload.payload.rawPayload : undefined;
      if (tx.signature === undefined || tx.header === undefined || payload === undefined) {
        throw {
          kind: 'node',
          message: 'Account transaction block item was missing fields required for serialization.',
        };
      }
      return {
        blockItemKind: 'accountTransaction',
        blockItemHex: Buffer.concat([
          Buffer.from([BlockItemKind.AccountTransactionKind]),
          serializeAccountTransactionSignature(signatureToSdk(tx.signature)),
          AccountTransactionV0.serializeHeader(headerToSdk(tx.header, payload)),
          Buffer.from(payload),
        ]).toString('hex'),
      };
    }
    case 'accountTransactionV1': {
      const tx = item.accountTransactionV1;
      if (tx === undefined) throw { kind: 'node', message: 'Account transaction V1 block item payload was missing.' };
      const payload = tx.payload?.payload.oneofKind === 'rawPayload' ? tx.payload.payload.rawPayload : undefined;
      if (tx.signatures?.senderSignatures === undefined || tx.header === undefined || payload === undefined) {
        throw {
          kind: 'node',
          message: 'Account transaction V1 block item was missing fields required for serialization.',
        };
      }
      return {
        blockItemKind: 'accountTransactionV1',
        blockItemHex: Buffer.concat([
          Buffer.from([BlockItemKind.AccountTransactionV1Kind]),
          Buffer.from(
            AccountTransactionV1.serializeSignatures({
              sender: signatureToSdk(tx.signatures.senderSignatures),
              ...(tx.signatures.sponsorSignatures !== undefined
                ? { sponsor: signatureToSdk(tx.signatures.sponsorSignatures) }
                : {}),
            }),
          ),
          Buffer.from(
            AccountTransactionV1.serializeHeader({
              ...headerToSdk(tx.header, payload),
              ...(tx.header.sponsor?.value !== undefined ? { sponsor: addressFromBytes(tx.header.sponsor.value) } : {}),
            }),
          ),
          Buffer.from(payload),
        ]).toString('hex'),
      };
    }
    case 'credentialDeployment': {
      const deployment = item.credentialDeployment;
      const payload = deployment?.payload.oneofKind === 'rawPayload' ? deployment.payload.rawPayload : undefined;
      const expiry = deployment?.messageExpiry?.value;
      if (expiry === undefined || payload === undefined) {
        throw {
          kind: 'node',
          message: 'Credential deployment block item was missing fields required for serialization.',
        };
      }
      const expiryBytes = Buffer.alloc(8);
      expiryBytes.writeBigUInt64BE(expiry);
      return {
        blockItemKind: 'credentialDeployment',
        blockItemHex: Buffer.concat([
          Buffer.from([BlockItemKind.CredentialDeploymentKind]),
          expiryBytes,
          Buffer.from(payload),
        ]).toString('hex'),
      };
    }
    case 'updateInstruction':
      return { blockItemKind: 'updateInstruction' };
    default:
      throw { kind: 'node', message: `Unsupported block item kind in block stream: ${String(item.oneofKind)}` };
  }
}

/** Locate the transaction in its observed block and reconstruct submitted bytes without signing. */
export function getBlockItem(grpc: ConcordiumGRPCClient, transactionHash: string): Promise<BlockItemDTO> {
  return guard(async () => {
    const status = await grpc.getBlockItemStatus(TransactionHash.fromHexString(transactionHash));
    if (status.status === 'received') return { transactionHash, status: 'received', blockHash: null };
    const blockHash = status.status === 'finalized' ? status.outcome.blockHash : status.outcomes[0]?.blockHash;
    if (blockHash === undefined) return { transactionHash, status: 'committed', blockHash: null };
    for await (const item of rawClient(grpc).getBlockItems({
      blockHashInput: { oneofKind: 'given', given: { value: blockHash.buffer } },
    }).responses) {
      if (Buffer.from(item.hash?.value ?? new Uint8Array()).toString('hex') !== transactionHash) continue;
      return { transactionHash, status: status.status, blockHash: String(blockHash), ...serializeItem(item.blockItem) };
    }
    throw { kind: 'node', message: `Block item ${transactionHash} was not found in block ${String(blockHash)}.` };
  });
}

/** Submit already finalized block-item bytes; this explicit operation does not construct signatures. */
export function submitBlockItem(grpc: ConcordiumGRPCClient, blockItemHex: string): Promise<string> {
  return guard(async () => {
    const response = await rawClient(grpc).sendBlockItem({
      blockItem: { oneofKind: 'rawBlockItem', rawBlockItem: Uint8Array.from(Buffer.from(blockItemHex, 'hex')) },
    }).response;
    return Buffer.from(response.value ?? new Uint8Array()).toString('hex');
  });
}
