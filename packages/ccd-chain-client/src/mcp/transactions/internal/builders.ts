import {
  AccountAddress,
  CcdAmount,
  ContractAddress,
  ContractName,
  DataBlob,
  DelegationTargetType,
  Energy,
  ModuleReference,
  OpenStatus,
  Parameter,
  ReceiveName,
  Transaction,
  encodeHexString,
  type DelegationTarget,
} from '@concordium/web-sdk';
import type { BuildTransactionResultDto } from '@ccd-agent-kit/mcp-utils';
import {
  normalizeInitContractName,
  serializeInitParameterJsonFromHex,
  serializeReceiveParameterJsonFromHex,
} from '@ccd-agent-kit/sdk-utils';
import { resolveAccountInput } from '../../accounts/accountLabels.js';
import type { ConcordiumQueryClient } from '../../../concordium/client.js';
import { resolveContractInstanceInput } from '../../contracts/contractInstanceLabels.js';
import type { ToolContext } from '../../toolPlumbing/toolTypes.js';
import { DEFAULT_ENERGY } from './metadata.js';
import { buildTransactionWithSponsorship, resolveBuildContext, resolveBuildMetadata } from './buildContext.js';
import type {
  BuildConfigureBakerArgs,
  BuildConfigureDelegationArgs,
  BuildInitContractArgs,
  BuildRegisterDataArgs,
  BuildTransferArgs,
  BuildUpdateContractArgs,
} from './schemas.js';

/** Re-exported so tool handlers keep a single import surface for all payload builders. */
export { buildUpdateCredentialKeys } from './credentialKeyBuilder.js';
export { buildPlt } from './pltBuilder.js';

function ccdAmountSummary(amountMicroCcd: string): {
  value: string;
  decimals: number;
  display: string;
} {
  return { value: amountMicroCcd, decimals: 6, display: CcdAmount.fromMicroCcd(BigInt(amountMicroCcd)).toString() };
}

function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function memoBytesFromArgs(args: Pick<BuildTransferArgs, 'memoText' | 'memoJson'>): DataBlob {
  if (args.memoText !== undefined) {
    return new DataBlob(bytesToArrayBuffer(Buffer.from(args.memoText, 'utf8')));
  }
  return new DataBlob(bytesToArrayBuffer(Buffer.from(JSON.stringify(args.memoJson), 'utf8')));
}

/** Builds an unsigned CCD transfer, adding a memo payload when memo arguments are provided. */
export async function buildTransfer(ctx: ToolContext, args: BuildTransferArgs): Promise<BuildTransactionResultDto> {
  const { network, clientCtx, sponsorshipArgs } = resolveBuildContext(ctx, args);
  const toAddress = resolveAccountInput(args.toAddress, network);
  const payload = {
    toAddress: AccountAddress.fromBase58(toAddress),
    amount: CcdAmount.fromMicroCcd(BigInt(args.amountMicroCcd)),
  };
  const hasMemo = args.memoText !== undefined || args.memoJson !== undefined;
  const builder = hasMemo ? Transaction.transfer(payload, memoBytesFromArgs(args)) : Transaction.transfer(payload);
  const metadata = await resolveBuildMetadata(clientCtx, sponsorshipArgs);
  const transaction = await buildTransactionWithSponsorship(sponsorshipArgs, builder, metadata);
  return {
    transactionType: hasMemo ? 'transferWithMemo' : 'transfer',
    payload: {
      toAddress,
      amount: ccdAmountSummary(args.amountMicroCcd),
      ...(args.memoText !== undefined && { memoText: args.memoText }),
      ...(args.memoJson !== undefined && { memoJson: args.memoJson }),
    },
    ...transaction,
  };
}

/** Builds an unsigned register-data transaction for the given hex data. */
export async function buildRegisterData(
  ctx: ToolContext,
  args: BuildRegisterDataArgs,
): Promise<BuildTransactionResultDto> {
  const { clientCtx, sponsorshipArgs } = resolveBuildContext(ctx, args);
  const metadata = await resolveBuildMetadata(clientCtx, sponsorshipArgs);
  const transaction = await buildTransactionWithSponsorship(
    sponsorshipArgs,
    Transaction.registerData({ data: new DataBlob(bytesToArrayBuffer(encodeHexString(args.dataHex))) }),
    metadata,
  );
  return { transactionType: 'registerData', payload: { data: args.dataHex }, ...transaction };
}

/** Builds an unsigned configure-delegation transaction, validating pool delegation arguments. */
export async function buildConfigureDelegation(
  ctx: ToolContext,
  args: BuildConfigureDelegationArgs,
): Promise<BuildTransactionResultDto> {
  const { clientCtx, sponsorshipArgs } = resolveBuildContext(ctx, args);
  const delegationTarget: DelegationTarget =
    args.delegationTarget === 'pool'
      ? { delegateType: DelegationTargetType.Baker, bakerId: BigInt(args.poolId!) }
      : { delegateType: DelegationTargetType.PassiveDelegation };
  const metadata = await resolveBuildMetadata(clientCtx, sponsorshipArgs);
  const transaction = await buildTransactionWithSponsorship(
    sponsorshipArgs,
    Transaction.configureDelegation({
      delegationTarget,
      ...(args.amountMicroCcd !== undefined ? { stake: CcdAmount.fromMicroCcd(BigInt(args.amountMicroCcd)) } : {}),
      ...(args.restakeEarnings !== undefined ? { restakeEarnings: args.restakeEarnings } : {}),
    }),
    metadata,
  );
  return {
    transactionType: 'configureDelegation',
    payload: {
      delegationTarget: args.delegationTarget,
      ...(args.poolId !== undefined ? { poolId: args.poolId } : {}),
      ...(args.amountMicroCcd !== undefined ? { amount: ccdAmountSummary(args.amountMicroCcd) } : {}),
      ...(args.restakeEarnings !== undefined ? { restakeEarnings: args.restakeEarnings } : {}),
    },
    ...transaction,
  };
}

const OPEN_STATUS: Record<'open' | 'closed' | 'closed_for_new', OpenStatus> = {
  open: OpenStatus.OpenForAll,
  closed: OpenStatus.ClosedForAll,
  closed_for_new: OpenStatus.ClosedForNew,
};

/** Builds an unsigned configure-baker transaction from optional staking and open-status arguments. */
export async function buildConfigureBaker(
  ctx: ToolContext,
  args: BuildConfigureBakerArgs,
): Promise<BuildTransactionResultDto> {
  const { clientCtx, sponsorshipArgs } = resolveBuildContext(ctx, args);
  const metadata = await resolveBuildMetadata(clientCtx, sponsorshipArgs);
  const transaction = await buildTransactionWithSponsorship(
    sponsorshipArgs,
    Transaction.configureValidator({
      ...(args.amountMicroCcd !== undefined ? { stake: CcdAmount.fromMicroCcd(BigInt(args.amountMicroCcd)) } : {}),
      ...(args.restakeEarnings !== undefined ? { restakeEarnings: args.restakeEarnings } : {}),
      ...(args.openStatus !== undefined ? { openForDelegation: OPEN_STATUS[args.openStatus] } : {}),
    }),
    metadata,
  );
  return {
    transactionType: 'configureBaker',
    payload: {
      ...(args.amountMicroCcd !== undefined ? { amount: ccdAmountSummary(args.amountMicroCcd) } : {}),
      ...(args.restakeEarnings !== undefined ? { restakeEarnings: args.restakeEarnings } : {}),
      ...(args.openStatus !== undefined ? { openStatus: args.openStatus } : {}),
    },
    ...transaction,
  };
}

async function estimateUpdateContractExecutionEnergy(
  client: ConcordiumQueryClient,
  args: {
    contract: ReturnType<typeof resolveContractInstanceInput>;
    receiveName: string;
    parameterHex: string | undefined;
    amountMicroCcd: string | undefined;
    sender: string;
  },
): Promise<bigint> {
  try {
    return await client.estimateContractUpdateExecutionEnergy({
      contract: { index: args.contract.index, subindex: args.contract.subindex },
      method: args.receiveName,
      ...(args.parameterHex !== undefined ? { parameterHex: args.parameterHex } : {}),
      ...(args.amountMicroCcd !== undefined ? { amountMicroCcd: BigInt(args.amountMicroCcd) } : {}),
      invoker: args.sender,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : (error as { message?: string } | undefined)?.message;
    throw {
      kind: 'invalid-argument',
      message: `Could not estimate update contract energy. Provide energy explicitly to build without estimation.${message !== undefined ? ` ${message}` : ''}`,
    };
  }
}

/** Builds an unsigned init-contract transaction using provided or default execution energy. */
export async function buildInitContract(
  ctx: ToolContext,
  args: BuildInitContractArgs,
): Promise<BuildTransactionResultDto> {
  const { clientCtx, sponsorshipArgs } = resolveBuildContext(ctx, args);
  const energy = BigInt(args.energy ?? DEFAULT_ENERGY);
  const client = clientCtx.clients.getClient().client;
  const schemaHex = args.parameterJson === undefined ? undefined : await client.getModuleSchema(args.moduleRef);
  // JSON parameters are schema-shaped values; the schema is required to serialize them into Concordium parameter bytes.
  if (args.parameterJson !== undefined && schemaHex === undefined) {
    throw { kind: 'invalid-argument', message: 'parameterJson requires an embedded module schema. Use parameterHex instead.' };
  }
  const parameterHex =
    args.parameterJson !== undefined
      ? serializeInitParameterJsonFromHex(schemaHex!, args.initName, args.parameterJson)
      : args.parameterHex;
  const metadata = await resolveBuildMetadata(clientCtx, sponsorshipArgs);
  const transaction = await buildTransactionWithSponsorship(
    sponsorshipArgs,
    Transaction.initContract(
      {
        amount: CcdAmount.fromMicroCcd(BigInt(args.amountMicroCcd ?? '0')),
        moduleRef: ModuleReference.fromHexString(args.moduleRef),
        initName: ContractName.fromString(normalizeInitContractName(args.initName)),
        param: parameterHex !== undefined ? Parameter.fromHexString(parameterHex) : Parameter.empty(),
      },
      Energy.create(energy),
    ),
    metadata,
  );
  return {
    transactionType: 'initContract',
    payload: {
      moduleRef: args.moduleRef,
      initName: args.initName,
      ...(parameterHex !== undefined ? { parameterHex } : {}),
      amount: ccdAmountSummary(args.amountMicroCcd ?? '0'),
      executionEnergy: args.energy ?? DEFAULT_ENERGY.toString(),
      energySource: args.energy === undefined ? 'default' : 'provided',
    },
    ...transaction,
  };
}

/** Builds an unsigned update-contract transaction, estimating execution energy when the caller omits `energy`. */
export async function buildUpdateContract(
  ctx: ToolContext,
  args: BuildUpdateContractArgs,
): Promise<BuildTransactionResultDto> {
  const { network, clientCtx, sender, sponsorshipArgs } = resolveBuildContext(ctx, args);
  const contract = resolveContractInstanceInput(args.contract, network);
  const client = clientCtx.clients.getClient().client;
  const instanceInfo = args.parameterJson === undefined ? undefined : await client.getInstanceInfo(contract.index, contract.subindex);
  const schemaHex = instanceInfo === undefined ? undefined : await client.getModuleSchema(instanceInfo.moduleRef);
  // JSON parameters are schema-shaped values; the schema is required to serialize them into Concordium parameter bytes.
  if (args.parameterJson !== undefined && schemaHex === undefined) {
    throw { kind: 'invalid-argument', message: 'parameterJson requires an embedded module schema. Use parameterHex instead.' };
  }
  const parameterHex =
    args.parameterJson !== undefined
      ? serializeReceiveParameterJsonFromHex(schemaHex!, instanceInfo!.name, args.receiveName, args.parameterJson)
      : args.parameterHex;
  const metadata = await resolveBuildMetadata(clientCtx, sponsorshipArgs);
  const simulatedExecutionEnergy =
    args.energy === undefined
      ? await estimateUpdateContractExecutionEnergy(client, {
          contract,
          receiveName: args.receiveName,
          parameterHex,
          amountMicroCcd: args.amountMicroCcd,
          sender,
        })
      : undefined;
  const energy = BigInt(args.energy ?? simulatedExecutionEnergy!.toString());
  const transaction = await buildTransactionWithSponsorship(
    sponsorshipArgs,
    Transaction.updateContract(
      {
        amount: CcdAmount.fromMicroCcd(BigInt(args.amountMicroCcd ?? '0')),
        address: ContractAddress.create(contract.index, contract.subindex),
        receiveName: ReceiveName.fromString(args.receiveName),
        message: parameterHex !== undefined ? Parameter.fromHexString(parameterHex) : Parameter.empty(),
      },
      Energy.create(energy),
    ),
    metadata,
  );
  return {
    transactionType: 'updateContract',
    payload: {
      contract: { index: contract.address.index, subindex: contract.address.subindex, address: contract.canonical },
      receiveName: args.receiveName,
      ...(parameterHex !== undefined ? { parameterHex } : {}),
      amount: ccdAmountSummary(args.amountMicroCcd ?? '0'),
      executionEnergy: energy.toString(),
      energySource: args.energy === undefined ? 'simulated' : 'provided',
      ...(simulatedExecutionEnergy !== undefined ? { simulatedExecutionEnergy: simulatedExecutionEnergy.toString() } : {}),
    },
    ...transaction,
  };
}
