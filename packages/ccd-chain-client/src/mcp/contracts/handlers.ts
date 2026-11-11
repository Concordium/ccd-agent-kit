import { z } from 'zod';
import { jsonTextToolResult, mcpJsonValueSchema, type McpJsonValue } from '@ccd-agent-kit/mcp-utils';
import {
  parseReceiveErrorJsonFromHex,
  parseReceiveReturnJsonFromHex,
  receiveSchemaFromHex,
  serializeReceiveParameterJsonFromHex,
} from '@ccd-agent-kit/sdk-utils';
import { resolveAccountInput } from '../accounts/accountLabels.js';
import {
  accountAddressSchema,
  blockReferenceSchema,
  contractAddressSchema,
  networkNameSchema,
  u64StringSchema,
  parseBlockReference,
} from '../toolPlumbing/toolSchemas.js';
import { effectiveNetwork } from '../toolPlumbing/networkClient.js';
import type { ToolHandler } from '../toolPlumbing/toolTypes.js';
import { resolveContractInstanceInput } from './contractInstanceLabels.js';

function addParameterEncodingIssue(
  args: { parameterHex?: string | undefined; parameterJson?: McpJsonValue | undefined },
  ctx: z.RefinementCtx,
): void {
  if (args.parameterHex === undefined || args.parameterJson === undefined) return;
  ctx.addIssue({
    code: 'custom',
    message: 'parameterHex and parameterJson are mutually exclusive.',
    path: ['parameterJson'],
  });
}

/** Args for simulating a contract. */
export const simulateContractArgsSchema = z
  .object({
    contract: contractAddressSchema,
    method: z.string().describe('Receive function name (entrypoint).'),
    parameterHex: z.string().describe('Hex-encoded serialized parameter bytes.').optional(),
    parameterJson: mcpJsonValueSchema
      .describe('JSON parameter value to serialize with the embedded module schema.')
      .optional(),
    amountMicroCcd: u64StringSchema.optional(),
    energy: u64StringSchema.optional(),
    invoker: accountAddressSchema.optional(),
    block: blockReferenceSchema.optional(),
    network: networkNameSchema,
  })
  .superRefine((args, ctx) => addParameterEncodingIssue(args, ctx));
export type SimulateContractArgs = z.infer<typeof simulateContractArgsSchema>;
export type SimulateContractHandler = ToolHandler<SimulateContractArgs>;

export const simulateContractHandler: SimulateContractHandler = async (ctx, args) => {
  if (args.parameterHex !== undefined && args.parameterJson !== undefined) {
    throw { kind: 'invalid-argument', message: 'parameterHex and parameterJson are mutually exclusive.' };
  }
  const network = effectiveNetwork(ctx, args.network);
  const client = ctx.clients.getClient(args.network).client;
  const contract = resolveContractInstanceInput(args.contract, network);
  const block = args.block !== undefined ? parseBlockReference(args.block) : undefined;
  const instanceInfo =
    args.parameterJson !== undefined ? await client.getInstanceInfo(contract.index, contract.subindex) : undefined;
  const schemaHex = instanceInfo !== undefined ? await client.getModuleSchema(instanceInfo.moduleRef) : undefined;
  // JSON parameters are schema-shaped values; the schema is required to serialize them into Concordium parameter bytes.
  if (args.parameterJson !== undefined && schemaHex === undefined) {
    throw {
      kind: 'invalid-argument',
      message: 'parameterJson requires an embedded module schema. Use parameterHex instead.',
    };
  }
  const parameterHex =
    args.parameterJson !== undefined
      ? serializeReceiveParameterJsonFromHex(schemaHex!, instanceInfo!.name, args.method, args.parameterJson)
      : args.parameterHex;
  const result = await client.simulateContract({
    contract: { index: contract.index, subindex: contract.subindex },
    method: args.method,
    ...(parameterHex !== undefined && { parameterHex }),
    ...(args.amountMicroCcd !== undefined && { amountMicroCcd: BigInt(args.amountMicroCcd) }),
    ...(args.energy !== undefined && { energy: BigInt(args.energy) }),
    ...(args.invoker !== undefined && { invoker: resolveAccountInput(args.invoker, network) }),
    ...(block !== undefined && { block }),
  });
  let decodeInfo = instanceInfo;
  if (decodeInfo === undefined && (result.returnValueHex !== undefined || result.errorHex !== undefined)) {
    try {
      decodeInfo = await client.getInstanceInfo(contract.index, contract.subindex);
    } catch {
      decodeInfo = undefined;
    }
  }
  const decodeSchemaHex =
    decodeInfo !== undefined && (result.returnValueHex !== undefined || result.errorHex !== undefined)
      ? (schemaHex ?? (await client.getModuleSchema(decodeInfo.moduleRef)))
      : undefined;
  let returnValueJson;
  let errorJson;
  if (decodeSchemaHex !== undefined && decodeInfo !== undefined) {
    const receiveSchema = receiveSchemaFromHex(decodeSchemaHex, decodeInfo.name, args.method);
    if (receiveSchema.returnValue !== undefined && result.returnValueHex !== undefined) {
      returnValueJson = parseReceiveReturnJsonFromHex(
        decodeSchemaHex,
        decodeInfo.name,
        args.method,
        result.returnValueHex,
      );
    }
    if (receiveSchema.error !== undefined && result.errorHex !== undefined) {
      errorJson = parseReceiveErrorJsonFromHex(decodeSchemaHex, decodeInfo.name, args.method, result.errorHex);
    }
  }
  return jsonTextToolResult({
    ...result,
    ...(returnValueJson !== undefined ? { returnValueJson } : {}),
    ...(errorJson !== undefined ? { errorJson } : {}),
  });
};
