import {
  catalogLabelActionSchema,
  CatalogLabelError,
  resolveNetwork,
  setSoftContractInstanceLabel,
} from '@ccd-agent-kit/config-utils';
import { caip2Reference, contractInstance } from '@ccd-agent-kit/sdk-utils';
import { z } from 'zod';

import { jsonTool } from '../../toolPlumbing/toolHandlers.js';
import { effectiveNetwork } from '../../toolPlumbing/networkClient.js';
import { networkNameSchema } from '../../toolPlumbing/toolSchemas.js';
import type { ToolDefinition } from '../../toolPlumbing/toolRegistry.js';

/** Input for an agent-modifiable contract-instance label scoped to one canonical network. */
export const labelContractInstanceArgsSchema = catalogLabelActionSchema
  .safeExtend({
    address: z
      .string()
      .refine((value) => contractInstance.from(value) !== undefined, 'Expected a contract-instance address.')
      .describe('Contract-instance address as index,subindex or index.subindex.'),
    network: networkNameSchema,
  });

/** Writes only network-scoped public contract-instance label metadata. */
export const labelContractInstanceHandler = jsonTool(async (ctx, args: z.infer<typeof labelContractInstanceArgsSchema>) => {
  try {
    const input = labelContractInstanceArgsSchema.parse(args);
    const network = resolveNetwork(effectiveNetwork(ctx, input.network));
    const address = contractInstance.require(input.address);
    const label = input.remove === true ? undefined : input.label;
    const caip2Ref = caip2Reference(network.config.caip2);
    setSoftContractInstanceLabel(label, address, caip2Ref);
    return {
      address: contractInstance.format(address),
      ...(label === undefined ? {} : { label }),
      network: network.name,
    };
  } catch (error) {
    if (error instanceof CatalogLabelError && error.code === 'LABEL_PROTECTED') {
      throw { kind: 'invalid-argument', message: 'LABEL_PROTECTED' };
    }
    throw error;
  }
});

/** `label_contract_instance` MCP tool definition for scoped soft contract-instance metadata. */
export const labelContractInstanceTool = {
  name: 'label_contract_instance',
  title: 'Label Contract Instance',
  description: 'Provide label to set a soft contract-instance label or remove: true to remove it without changing an operator-protected label.',
  annotations: { openWorldHint: false, idempotentHint: true },
  inputSchema: labelContractInstanceArgsSchema,
  handler: labelContractInstanceHandler,
} satisfies ToolDefinition<typeof labelContractInstanceArgsSchema>;
