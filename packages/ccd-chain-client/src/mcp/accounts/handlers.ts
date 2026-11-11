import {
  resolveNetwork,
  setAccountCredentialObservation,
  setAccountCredentialRefreshError,
  setSoftAccountLabel,
  catalogLabelActionSchema,
  CatalogLabelError,
} from '@ccd-agent-kit/config-utils';
import { z } from 'zod';
import { resolveAccountInput } from './accountLabels.js';
import { jsonTool } from '../toolPlumbing/toolHandlers.js';
import { accountAddressSchema, networkNameSchema } from '../toolPlumbing/toolSchemas.js';
import { effectiveNetwork } from '../toolPlumbing/networkClient.js';
import { caip2Reference } from '@ccd-agent-kit/sdk-utils';
import type { ToolHandler } from '../toolPlumbing/toolTypes.js';
import { accountCredentialRefreshErrorFromUnknown } from './refreshErrors.js';

export const syncAccountCredentialsArgsSchema = z.object({
  address: accountAddressSchema,
  network: networkNameSchema,
});
export type SyncAccountCredentialsArgs = z.infer<typeof syncAccountCredentialsArgsSchema>;
export type SyncAccountCredentialsHandler = ToolHandler<SyncAccountCredentialsArgs>;

/** Input for an agent-modifiable account label scoped to one canonical network. */
export const labelAccountArgsSchema = catalogLabelActionSchema.safeExtend({
  address: accountAddressSchema,
  network: networkNameSchema,
});
export type LabelAccountArgs = z.infer<typeof labelAccountArgsSchema>;

/** Writes only network-scoped public account label metadata. */
export const labelAccountHandler: ToolHandler<LabelAccountArgs> = jsonTool(async (ctx, args) => {
  try {
    const input = labelAccountArgsSchema.parse(args);
    const network = effectiveNetwork(ctx, input.network);
    const address = resolveAccountInput(input.address, network);
    const caip2Ref = caip2Reference(resolveNetwork(network).config.caip2);
    const label = input.remove === true ? undefined : input.label;
    setSoftAccountLabel(label, address, caip2Ref);
    return { address, ...(label === undefined ? {} : { label }), network };
  } catch (error) {
    if (error instanceof CatalogLabelError && error.code === 'LABEL_PROTECTED') {
      throw { kind: 'invalid-argument', message: 'LABEL_PROTECTED' };
    }
    throw error;
  }
});

export const syncAccountCredentialsHandler: SyncAccountCredentialsHandler = jsonTool(async (ctx, args) => {
  const networkName = effectiveNetwork(ctx, args.network);
  const network = ctx.clients.getClient(args.network);
  const address = resolveAccountInput(args.address, networkName);
  const caip2Ref = caip2Reference(resolveNetwork(networkName).config.caip2);
  let result: Awaited<ReturnType<typeof network.client.getFinalizedAccountCredentials>>;
  try {
    result = await network.client.getFinalizedAccountCredentials(address);
  } catch (error) {
    setAccountCredentialRefreshError(address, accountCredentialRefreshErrorFromUnknown(error), caip2Ref);
    throw error;
  }
  setAccountCredentialObservation(result.canonicalAddress, result.observation, caip2Ref);
  return {
    address: result.canonicalAddress,
    credentialCount: Object.keys(result.observation.credentials).length,
    keyCount: Object.values(result.observation.credentials).reduce(
      (count, credential) => count + Object.keys(credential.keys).length,
      0,
    ),
    network: networkName,
    sourceBlock: result.observation.sourceBlock,
  };
});
