import { hexStringSchema, signatureMapSchema } from '@ccd-agent-kit/mcp-utils';
import { normalizeMessageInput } from '@ccd-agent-kit/sdk-utils';
import { verifyMessageSignature } from '@concordium/web-sdk';
import { z } from 'zod';
import { getAccountVerificationInfoCacheFirst } from '../accountCredentialsCache.js';
import {
  accountAddressSchema,
  blockReferenceSchema,
  networkNameSchema,
  parseBlockReference,
} from '../toolPlumbing/toolSchemas.js';
import { jsonTool } from '../toolPlumbing/toolHandlers.js';
import type { ToolContext } from '../toolPlumbing/toolTypes.js';

export const verifyMessageSignatureArgsSchema = z
  .object({
    address: accountAddressSchema,
    messageText: z.string().describe('Plain-text message to UTF-8 encode before verification.').optional(),
    messageHex: hexStringSchema.describe('Hex-encoded message bytes to verify exactly as provided.').optional(),
    signature: signatureMapSchema,
    returnInput: z.boolean().optional(),
    block: blockReferenceSchema.optional(),
    network: networkNameSchema,
  })
  .refine((args) => (args.messageText !== undefined) !== (args.messageHex !== undefined), {
    message: 'Provide exactly one of messageText or messageHex.',
  });
export type VerifyMessageSignatureArgs = z.infer<typeof verifyMessageSignatureArgsSchema>;

export interface VerifyMessageSignatureResult {
  valid: boolean;
  network: string;
  address: string;
  inputFormat: 'text' | 'hex';
  messageHex?: string;
  messageText?: string;
}

export async function verifyMessage(
  ctx: ToolContext,
  args: VerifyMessageSignatureArgs,
): Promise<VerifyMessageSignatureResult> {
  const { client, networkName } = ctx.clients.getClient(args.network);
  const block = parseBlockReference(args.block);
  const accountInfo = await getAccountVerificationInfoCacheFirst(client, networkName, args.address, block);
  const message = normalizeMessageInput(
    args.messageText !== undefined ? { messageText: args.messageText } : { messageHex: args.messageHex! },
  );
  let valid = await verifyMessageSignature(message.messageBytes, args.signature, accountInfo.info);
  let verificationInfo = accountInfo.info;
  if (!valid && accountInfo.source === 'cache') {
    const refreshed = await getAccountVerificationInfoCacheFirst(client, networkName, args.address, block, true);
    verificationInfo = refreshed.info;
    valid = await verifyMessageSignature(message.messageBytes, args.signature, verificationInfo);
  }
  return {
    valid,
    network: networkName,
    address: verificationInfo.accountAddress.toString(),
    inputFormat: message.inputFormat,
    ...(args.returnInput === true ? { messageHex: message.messageHex } : {}),
    ...(args.returnInput === true && message.messageText !== undefined ? { messageText: message.messageText } : {}),
  };
}

export const verifyMessageSignatureHandler = jsonTool(verifyMessage);
