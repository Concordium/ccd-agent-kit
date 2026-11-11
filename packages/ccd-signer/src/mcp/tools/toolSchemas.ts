import { hexStringSchema, roleSeparatedSignaturesSchema, signatureMapSchema, signatureRequirementsSchema } from '@ccd-agent-kit/mcp-utils';
import { catalogLabelActionSchema } from '@ccd-agent-kit/config-utils';
import { z } from 'zod';

export { signatureRequirementsSchema };

/** Input for agent-modifiable public signing-key labels; legacy fields are rejected. */
export const labelSigningKeyInputSchema = catalogLabelActionSchema.safeExtend({
  keyRef: z.string().regex(/^ed25519:[0-9a-f]{64}$/).describe('Public signing-key reference.'),
});

/** Safe public output for a signing-key label mutation, without protection or custody metadata. */
export const labelSigningKeyOutputSchema = z.strictObject({
  keyRef: z.string(), label: z.string().optional(),
});

export const describeTransactionToolInputSchema = z.object({
  transactionHex: hexStringSchema.describe('Serialized signed, unsigned, or finalized block-item transaction hex.'),
  network: z
    .string()
    .optional()
    .describe('Optional network name, CAIP-2 reference, or full CAIP-2 identifier. Uses default network when omitted.'),
});

export const describeTransactionToolOutputSchema = z.object({ kind: z.string().optional() }).passthrough();

export const roleSeparatedSignatureSetsSchema = z.union([
  roleSeparatedSignaturesSchema,
  z.array(roleSeparatedSignaturesSchema).min(1),
]);

export const signedMessageOutputSchema = z.object({
  account: z.string(),
  inputFormat: z.enum(['text', 'hex']),
  messageHex: z.string().optional(),
  messageText: z.string().optional(),
  label: z.string().optional(),
  network: z.string(),
  signature: signatureMapSchema,
  signingAddress: z.string().optional(),
});

export const signTransactionInputSchema = z
  .object({
    transactionHex: hexStringSchema.describe('Unsigned transaction hex.'),
    role: z.enum(['sender', 'sponsor']).describe('The signing role (sender or sponsor).'),
    signatures: roleSeparatedSignatureSetsSchema
      .optional()
      .describe('Optional existing role-separated detached signature set or sets.'),
    keys: z
      .array(z.string())
      .optional()
      .describe('Optional exact credential/key pairs to sign, such as ["0:0", "0:1"].'),
    maxSignatures: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Optional maximum number of available missing keys to sign when keys is omitted. Defaults to 1.'),
    signatureRequirements: signatureRequirementsSchema
      .optional()
      .describe('Optional builder-compatible signature requirements metadata.'),
    describe: z.boolean().optional(),
    finalize: z.boolean().optional(),
    returnInput: z.boolean().optional(),
    network: z
      .string()
      .optional()
      .describe('Optional network name, CAIP-2 reference, or full CAIP-2 identifier. Uses default network when omitted.'),
  })
  .refine((value) => !(value.keys && value.maxSignatures !== undefined), {
    message: 'Provide either keys or maxSignatures, not both.',
  });

export const signTransactionOutputSchema = z.object({
  address: z.string(),
  label: z.string().optional(),
  network: z.string(),
  signingAddress: z.string().optional(),
  transaction: z.string().optional(),
  roleSigned: z.enum(['sender', 'sponsor']),
  newSignature: signatureMapSchema,
  signatures: roleSeparatedSignaturesSchema,
  isFullySigned: z.boolean(),
  signatureRequirementsKnown: z.boolean(),
  missingSignatures: z.object({ sender: z.number(), sponsor: z.number() }),
  parsedTransaction: describeTransactionToolOutputSchema.optional(),
  transactionVersion: z.enum(['v0', 'v1']).optional(),
  blockItemHex: z.string().optional(),
});

const credentialDeploymentKeyIndexSchema = z.string().refine((value) => {
  const index = Number(value);
  return Number.isInteger(index) && index >= 0 && index <= 255 && String(index) === value;
}, 'Expected a canonical decimal credential key index from 0 to 255.');

/** Raw flat credential signatures with canonical byte indexes and 64-byte Ed25519 signature hex. */
export const credentialDeploymentSignatureMapSchema = z.record(
  credentialDeploymentKeyIndexSchema,
  hexStringSchema.length(128, 'Expected a 64-byte Ed25519 signature hex string.'),
);

export const signCredentialDeploymentInputSchema = z
  .object({
    credDeploymentHex: hexStringSchema.describe(
      'Credential deployment signing handoff hex: targetContext || unsignedCredentialDeployment.',
    ),
    signatures: credentialDeploymentSignatureMapSchema
      .optional()
      .describe('Optional existing credential deployment signatures keyed by credential key index.'),
    keys: z
      .array(z.string().regex(/^\d+$/))
      .optional()
      .describe('Optional exact credential key indexes to sign, such as ["0", "1"].'),
    maxSignatures: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Optional maximum number of available missing keys to sign when keys is omitted. Defaults to 1.'),
    network: z
      .string()
      .optional()
      .describe('Optional network name, CAIP-2 reference, or full CAIP-2 identifier. Uses default network when omitted.'),
  })
  .refine((value) => !(value.keys && value.maxSignatures !== undefined), {
    message: 'Provide either keys or maxSignatures, not both.',
  });

export const signCredentialDeploymentOutputSchema = z.object({
  kind: z.literal('credentialDeploymentSigning'),
  target: z.object({ type: z.string() }).passthrough(),
  digestHex: z.string(),
  newSignatures: credentialDeploymentSignatureMapSchema,
  signatures: credentialDeploymentSignatureMapSchema,
  isFullySigned: z.boolean(),
  signatureThreshold: z.number(),
  missingSignatures: z.number(),
  credentialPublicKeys: z.object({ threshold: z.number(), keys: z.record(z.string(), z.string()) }),
});

export const signMessageInputSchema = z
  .object({
    account: z.string().describe('Account address or public account label to sign the message with.'),
    messageText: z.string().optional().describe('Plain-text message to UTF-8 encode before signing.'),
    messageHex: hexStringSchema.optional().describe('Hex-encoded message bytes to sign exactly as provided.'),
    returnInput: z.boolean().optional(),
    network: z
      .string()
      .optional()
      .describe('Optional network name, CAIP-2 reference, or full CAIP-2 identifier. Uses default network when omitted.'),
  })
  .refine((value) => (value.messageText !== undefined) !== (value.messageHex !== undefined), {
    message: 'Provide exactly one of messageText or messageHex.',
  });
