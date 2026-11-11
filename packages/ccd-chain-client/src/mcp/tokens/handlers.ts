import { z } from 'zod';
import { jsonTextToolResult } from '@ccd-agent-kit/mcp-utils';
import { resolveAccountInput } from '../accounts/accountLabels.js';
import { resolveContractInstanceInput } from '../contracts/contractInstanceLabels.js';
import { effectiveNetwork } from '../toolPlumbing/networkClient.js';
import { contractAddressSchema, accountAddressSchema, networkNameSchema } from '../toolPlumbing/toolSchemas.js';
import type { ToolHandler } from '../toolPlumbing/toolTypes.js';

export const getCis2TokenBalanceArgsSchema = z.object({
  contract: contractAddressSchema,
  tokenId: z.string(),
  address: accountAddressSchema,
  network: networkNameSchema,
});
export type GetCis2TokenBalanceArgs = z.infer<typeof getCis2TokenBalanceArgsSchema>;
export type GetCis2TokenBalanceHandler = ToolHandler<GetCis2TokenBalanceArgs>;

export const getCis2TokenBalanceHandler: GetCis2TokenBalanceHandler = async (ctx, args) => {
  const client = ctx.clients.getClient(args.network).client;
  const network = effectiveNetwork(ctx, args.network);
  const contract = resolveContractInstanceInput(args.contract, network);
  const balance = await client.getCis2TokenBalance(
    { index: contract.index, subindex: contract.subindex },
    args.tokenId,
    resolveAccountInput(args.address, network),
  );
  return jsonTextToolResult(balance);
};
