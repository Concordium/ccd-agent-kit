import { AccountTransactionV1, AccountTransactionV0 } from '@concordium/web-sdk';
import {
  hexStringSchema,
  roleSeparatedSignaturesSchema,
  type VerifyTransactionSignatureResultDto,
} from '@ccd-agent-kit/mcp-utils';
import {
  isEmptySignatureMap,
  parseSignedAccountBlockItemHex,
  parseUnsignedAccountTransactionHex,
} from '@ccd-agent-kit/sdk-utils';
import { z } from 'zod';
import { getAccountVerificationInfoCacheFirst } from '../../accountCredentialsCache.js';
import { blockReferenceSchema, parseBlockReference, networkNameSchema } from '../../toolPlumbing/toolSchemas.js';
import type { ToolContext } from '../../toolPlumbing/toolTypes.js';

export const verifyTransactionSignatureArgsSchema = z
  .object({
    transactionHex: hexStringSchema.describe('Expected unsigned transaction hex emitted by a builder.').optional(),
    blockItemHex: hexStringSchema.describe('Expected signed or finalized block item hex.').optional(),
    signatures: roleSeparatedSignaturesSchema.optional(),
    block: blockReferenceSchema.optional(),
    network: networkNameSchema,
  })
  .refine(
    (args) =>
      (args.transactionHex !== undefined && args.signatures !== undefined) !== (args.blockItemHex !== undefined),
    {
      message: 'Provide either transactionHex with signatures, or blockItemHex.',
    },
  );
export type VerifyTransactionSignatureArgs = z.infer<typeof verifyTransactionSignatureArgsSchema>;

export type VerifyTransactionSignatureResult = VerifyTransactionSignatureResultDto;

export async function verifyTransactionSignature(
  ctx: ToolContext,
  args: VerifyTransactionSignatureArgs,
): Promise<VerifyTransactionSignatureResult> {
  const input =
    args.blockItemHex !== undefined
      ? parseSignedAccountBlockItemHex(args.blockItemHex)
      : { transactionHex: args.transactionHex!, signatures: args.signatures! };
  const unsigned = parseUnsignedAccountTransactionHex(input.transactionHex);
  const { client, networkName: network } = ctx.clients.getClient(args.network);
  const block = parseBlockReference(args.block);
  const senderSignature = input.signatures.sender;
  const sponsorSignature = input.signatures.sponsor;
  const senderVerification = await getAccountVerificationInfoCacheFirst(client, network, unsigned.sender, block);
  let senderValid =
    unsigned.version === 0
      ? await AccountTransactionV0.verifySignature(unsigned.transaction, senderSignature, senderVerification.info)
      : await AccountTransactionV1.verifySignature(unsigned.transaction, senderSignature, senderVerification.info);
  if (!senderValid && senderVerification.source === 'cache') {
    const refreshed = await getAccountVerificationInfoCacheFirst(client, network, unsigned.sender, block, true);
    senderValid =
      unsigned.version === 0
        ? await AccountTransactionV0.verifySignature(unsigned.transaction, senderSignature, refreshed.info)
        : await AccountTransactionV1.verifySignature(unsigned.transaction, senderSignature, refreshed.info);
  }

  if (unsigned.version === 0) {
    if (!isEmptySignatureMap(input.signatures.sponsor)) {
      throw {
        kind: 'invalid-argument',
        message: 'V0 transactions do not support sponsor signatures.',
      };
    }
    return {
      valid: senderValid,
      transactionVersion: 'v0',
      network,
      sender: { address: unsigned.sender, valid: senderValid },
    };
  }

  if (unsigned.sponsor === undefined) {
    if (!isEmptySignatureMap(input.signatures.sponsor)) {
      throw { kind: 'invalid-argument', message: 'Transaction does not declare a sponsor.' };
    }
    return {
      valid: senderValid,
      transactionVersion: 'v1',
      network,
      sender: { address: unsigned.sender, valid: senderValid },
    };
  }

  const sponsorVerification = await getAccountVerificationInfoCacheFirst(client, network, unsigned.sponsor, block);
  let sponsorValid = await AccountTransactionV1.verifySignature(
    unsigned.transaction,
    sponsorSignature,
    sponsorVerification.info,
  );
  if (!sponsorValid && sponsorVerification.source === 'cache') {
    const refreshed = await getAccountVerificationInfoCacheFirst(client, network, unsigned.sponsor, block, true);
    sponsorValid = await AccountTransactionV1.verifySignature(unsigned.transaction, sponsorSignature, refreshed.info);
  }
  return {
    valid: senderValid && sponsorValid,
    transactionVersion: 'v1',
    network,
    sender: { address: unsigned.sender, valid: senderValid },
    sponsor: { address: unsigned.sponsor, valid: sponsorValid },
  };
}
