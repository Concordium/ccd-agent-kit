import { assembleSignedCredentialDeployment, finalizeCredentialDeploymentHex } from '@ccd-agent-kit/sdk-utils';
import type { CredentialSignature } from '@concordium/web-sdk';
import { hexStringSchema } from '@ccd-agent-kit/mcp-utils';
import { z } from 'zod';
import { networkNameSchema } from '../toolPlumbing/toolSchemas.js';
import type { ToolContext } from '../toolPlumbing/toolTypes.js';

const keyIndexSchema = z.string().refine(
  value => /^(0|[1-9]\d*)$/.test(value) && Number(value) <= 255,
  'Expected a canonical decimal credential key index from 0 to 255.',
);
const credentialSignaturesSchema = z.record(
  keyIndexSchema,
  z.string().regex(/^[0-9a-fA-F]{128}$/),
);

/** Public input for verified account-opening credential completion. */
export const completeAccountOpeningArgsSchema = z.object({
  credDeploymentHex: hexStringSchema,
  signatures: credentialSignaturesSchema,
  submit: z.boolean().optional(),
  finalize: z.boolean().optional(),
  returnInput: z.boolean().optional(),
  network: networkNameSchema,
}).strict().refine(args => !(args.submit === true && args.finalize === false), {
  message: 'submit true requires finalization; finalize cannot be false.',
});

export type CompleteAccountOpeningArgs = z.infer<typeof completeAccountOpeningArgsSchema>;

/** Verifies detached credential signatures, finalizes a new-account deployment, and optionally submits it. */
export async function completeAccountOpening(
  ctx: ToolContext,
  args: CompleteAccountOpeningArgs,
): Promise<Record<string, unknown> & { submitted: boolean }> {
  if (args.submit === true && args.finalize === false) {
    throw { kind: 'invalid-argument', message: 'submit true requires finalization; finalize cannot be false.' };
  }
  const signatures = normalizeSignatures(args.signatures);
  if (!args.credDeploymentHex.startsWith('00')) {
    throw { kind: 'invalid-argument', message: 'Account-opening credential handoff could not be finalized.' };
  }
  if (args.finalize === false) {
    await completion(() => assembleSignedCredentialDeployment(args.credDeploymentHex, signatures));
    return { signatures, submitted: false };
  }
  const finalized = await completion(() => finalizeCredentialDeploymentHex(args.credDeploymentHex, signatures));
  if (args.submit !== true) return { ...finalized, submitted: false };
  const { client, networkName } = ctx.clients.getClient(args.network);
  const transactionHash = await client.submitBlockItem(finalized.blockItemHex);
  const { blockItemHex, ...submittedCredential } = finalized;
  return {
    ...submittedCredential,
    ...(args.returnInput === true ? { blockItemHex } : {}),
    network: networkName,
    submitted: true,
    transactionHash,
  };
}

function normalizeSignatures(signatures: CredentialSignature): CredentialSignature {
  return Object.fromEntries(Object.entries(signatures).map(([index, signature]) => [index, signature.toLowerCase()]));
}

async function completion<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch { throw { kind: 'invalid-argument', message: 'Account-opening credential handoff could not be finalized.' }; }
}
