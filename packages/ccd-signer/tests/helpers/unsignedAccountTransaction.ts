import { AccountTransactionV0, AccountTransactionV1, Payload } from '@concordium/web-sdk';
import { parseUnsignedAccountTransactionHex } from '@ccd-agent-kit/sdk-utils';

import { transactionFixtures } from './transactionFixtures.js';

export function unsignedHexForPayload(payload: Payload.Type, version: 0 | 1): string {
  const payloadBytes = Payload.serialize(payload);
  const header = {
    ...parseUnsignedAccountTransactionHex(transactionFixtures.unsignedTransferWithMemoHex).transaction.header,
    payloadSize: payloadBytes.length,
  };
  const transactionBytes = Buffer.concat([
    version === 0 ? AccountTransactionV0.serializeHeader(header) : AccountTransactionV1.serializeHeader(header),
    payloadBytes,
  ]);
  return Buffer.concat([Buffer.from(version === 0 ? [0, 0] : [3, 0, 0]), transactionBytes]).toString('hex');
}
