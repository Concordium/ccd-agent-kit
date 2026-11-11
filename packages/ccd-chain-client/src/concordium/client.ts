import { credentials } from '@grpc/grpc-js';
import {
  AccountAddress,
  type AccountInfo,
  AccountInfoType,
  Cbor,
  CIS2Contract,
  ContractAddress,
  DelegationTargetType,
  Energy,
  isKnown,
  ModuleReference,
  TransactionHash,
  LockId,
  TokenId,
  getEmbeddedModuleSchema,
  parseModuleInterface,
  type ConcordiumGRPCClient,
} from '@concordium/web-sdk';
import { ConcordiumGRPCNodeClient } from '@concordium/web-sdk/nodejs';
import type { AccountCredentialObservation } from '@ccd-agent-kit/config-utils';
import { extractAccountCredentials, credentialSigningThreshold } from '@ccd-agent-kit/sdk-utils';
import { formatTokenAmount } from './formats.js';
import {
  accountBalancesToDto,
  accountInfoToDto,
  accountStakeToDto,
  blockInfoToDto,
  consensusInfoToDto,
  instanceInfoToDto,
  simulateContractResultToDto,
  renderRejectReason,
  lockInfoToDto,
  nextAccountSequenceNumberToDto,
  tokenHoldingsToDto,
  tokenBalancesToDto,
  tokenHoldingBalanceToDto,
} from './serializers.js';
import type {
  AccountBalanceResourceDTO,
  AccountBalancesDTO,
  AccountInfoDTO,
  AccountStakeResourceDTO,
  AccountPoolInfoDTO,
  AccountTokensDTO,
  BlockItemDTO,
  LockInfoDTO,
  BlockHashString,
  BlockInfoDTO,
  BlockTransactionEventsDTO,
  Cis2BalanceDTO,
  ConsensusInfoDTO,
  InstanceInfoDTO,
  InvokeResultDTO,
  ModuleInterfaceDTO,
  ModuleSourceDTO,
  NextSequenceNumberDTO,
  PassiveDelegationInfoDTO,
  PoolInfoDTO,
  TokenBalanceDTO,
  TokenDTO,
  TokenInfoDTO,
  TokenListDTO,
  TransactionEffectDTO,
  TransactionEffectsDTO,
} from './dto.js';
import type { GrpcEndpoint } from './endpoints.js';
import { LruCache, PromiseCache } from './cache.js';
import { contractContext } from './contractContext.js';
import { guard } from './errors.js';
import { getBlockItem, submitBlockItem } from './rawBlockItems.js';
import { resolveBlockHash } from './blocks.js';
import { blockItemSummaryToEventDto } from './transactionEffects.js';
export type { ConcordiumClientError } from './errors.js';

export type BlockIdentifier =
  | { type: 'best' }
  | { type: 'last_final' }
  | { type: 'hash'; hash: BlockHashString }
  | { type: 'height'; height: bigint; genesisIndex?: number };

export interface ContractIdentifier {
  index: bigint;
  subindex: bigint;
}

export interface AccountSigningRequirements {
  accountThreshold: number;
  credentialSignThresholds: number[];
}

export type AccountVerificationInfo = Pick<AccountInfo, 'accountAddress' | 'accountThreshold' | 'accountCredentials'>;

export interface SimulateContractParam {
  contract: ContractIdentifier;
  method: string;
  parameterHex?: string;
  amountMicroCcd?: bigint;
  energy?: bigint;
  invoker?: string;
  block?: BlockIdentifier;
}

export interface EstimateContractUpdateEnergyParam {
  contract: ContractIdentifier;
  method: string;
  parameterHex?: string;
  amountMicroCcd?: bigint;
  invoker: string;
  block?: BlockIdentifier;
}

export interface ConcordiumQueryClient {
  getAccountInfo(address: string, block?: BlockIdentifier): Promise<AccountInfoDTO>;
  getAccountInfoByIndex(index: bigint, block?: BlockIdentifier): Promise<AccountInfoDTO>;
  /** Resolve a canonical account index to its account address, using stable identity cache when available. */
  getAccountAddressByIndex(index: bigint): Promise<string>;
  getFinalizedAccountCredentials(
    address: string,
  ): Promise<{ canonicalAddress: string; observation: AccountCredentialObservation }>;
  getAccountBalances(address: string): Promise<AccountBalancesDTO>;
  getAccountBalance(address: string, tokenId: string): Promise<AccountBalanceResourceDTO>;
  getAccountStake(address: string): Promise<AccountStakeResourceDTO>;
  getAccountSigningRequirements(address: string): Promise<AccountSigningRequirements>;
  getAccountVerificationInfo(address: string, block?: BlockIdentifier): Promise<AccountVerificationInfo>;
  getProtocolVersion(): Promise<number>;
  getBlockItem(transactionHash: string): Promise<BlockItemDTO>;
  getTransactionEffects(transactionHash: string): Promise<TransactionEffectsDTO>;
  getLockInfo(lockId: string): Promise<LockInfoDTO>;
  getLockList(): Promise<string[]>;
  getNextAccountSequenceNumber(address: string): Promise<NextSequenceNumberDTO>;
  getBlockInfo(block?: BlockIdentifier): Promise<BlockInfoDTO>;
  getBlockTransactionEvents(block?: BlockIdentifier): Promise<BlockTransactionEventsDTO>;
  getConsensusInfo(): Promise<ConsensusInfoDTO>;
  getInstanceInfo(index: bigint, subindex: bigint): Promise<InstanceInfoDTO>;
  getModuleRefs(): Promise<string[]>;
  getModuleSource(moduleRef: string): Promise<ModuleSourceDTO>;
  getModuleInterface(moduleRef: string): Promise<ModuleInterfaceDTO>;
  getModuleSchema(moduleRef: string): Promise<string | undefined>;
  simulateContract(param: SimulateContractParam): Promise<InvokeResultDTO>;
  estimateContractUpdateExecutionEnergy(param: EstimateContractUpdateEnergyParam): Promise<bigint>;
  getPoolInfo(poolId: bigint): Promise<PoolInfoDTO>;
  getAccountPoolInfo(address: string): Promise<AccountPoolInfoDTO>;
  getPassiveDelegationInfo(): Promise<PassiveDelegationInfoDTO>;
  getTokenList(): Promise<TokenListDTO>;
  getTokenInfo(tokenId: string): Promise<TokenInfoDTO>;
  getAccountTokens(address: string): Promise<AccountTokensDTO>;
  getTokenBalance(tokenId: string, holder: string): Promise<TokenBalanceDTO>;
  getCis2TokenBalance(contract: ContractIdentifier, tokenId: string, address: string): Promise<Cis2BalanceDTO>;
  submitBlockItem(blockItemHex: string): Promise<string>;
  /** Return protocol-level token identifiers in node stream order without fetching token metadata. */
  getTokenIds(block?: BlockIdentifier): Promise<string[]>;
}

export class ConcordiumNodeQueries implements ConcordiumQueryClient {
  private readonly accountIndexAddressCache = new LruCache<string, string>(1024);
  private readonly moduleSourceCache = new PromiseCache<string, ModuleSourceDTO>(128);
  private readonly moduleInterfaceCache = new PromiseCache<string, ModuleInterfaceDTO>(128);
  private readonly moduleSchemaCache = new PromiseCache<string, string | undefined>(128);

  constructor(private readonly grpc: ConcordiumGRPCClient) {}

  private rememberAccountIdentity(info: AccountInfo): void {
    this.accountIndexAddressCache.set(info.accountIndex.toString(), info.accountAddress.address);
  }

  private async readAccountInfo(
    accountIdentifier: string | bigint,
    block?: BlockIdentifier,
  ): Promise<AccountInfo> {
    const info = await this.grpc.getAccountInfo(
      typeof accountIdentifier === 'string' ? AccountAddress.fromBase58(accountIdentifier) : accountIdentifier,
      await resolveBlockHash(this.grpc, block),
    );
    this.rememberAccountIdentity(info);
    return info;
  }

  private getAccountInfoByIdentifier(
    accountIdentifier: string | bigint,
    block?: BlockIdentifier,
  ): Promise<AccountInfoDTO> {
    return guard(async () => accountInfoToDto(await this.readAccountInfo(accountIdentifier, block)));
  }

  private accountSelector(identifier: string): string | bigint {
    return /^(0|[1-9]\d*)$/.test(identifier) ? BigInt(identifier) : identifier;
  }

  getAccountInfo(address: string, block?: BlockIdentifier): Promise<AccountInfoDTO> {
    return this.getAccountInfoByIdentifier(address, block);
  }

  getFinalizedAccountCredentials(
    address: string,
  ): Promise<{ canonicalAddress: string; observation: AccountCredentialObservation }> {
    return guard(async () => {
      const status = await this.grpc.getConsensusStatus();
      const lastFinalized = status.lastFinalizedBlock;
      const [info, blockInfo] = await Promise.all([
        this.grpc.getAccountInfo(AccountAddress.fromBase58(address), lastFinalized),
        this.grpc.getBlockInfo(lastFinalized),
      ]);
      return {
        canonicalAddress: info.accountAddress.address,
        observation: {
          accountThreshold: info.accountThreshold.toString(),
          credentials: extractAccountCredentials(info),
          sourceBlock: {
            hash: String(status.lastFinalizedBlock),
            height: blockInfo.blockHeight.toString(),
            time: blockInfo.blockSlotTime.toISOString(),
          },
        },
      };
    });
  }

  getAccountInfoByIndex(index: bigint, block?: BlockIdentifier): Promise<AccountInfoDTO> {
    return this.getAccountInfoByIdentifier(index, block);
  }

  getAccountAddressByIndex(index: bigint): Promise<string> {
    const normalizedIndex = index.toString();
    const cachedAddress = this.accountIndexAddressCache.get(normalizedIndex);
    if (cachedAddress !== undefined) return Promise.resolve(cachedAddress);
    return this.getAccountInfoByIndex(index).then((info) => info.address);
  }

  getAccountSigningRequirements(address: string): Promise<AccountSigningRequirements> {
    return guard(async () => {
      const info = await this.grpc.getAccountInfo(AccountAddress.fromBase58(address));
      return {
        accountThreshold: info.accountThreshold,
        credentialSignThresholds: Object.values(info.accountCredentials).map(credentialSigningThreshold),
      };
    });
  }

  getAccountVerificationInfo(address: string, block?: BlockIdentifier): Promise<AccountVerificationInfo> {
    return guard(async () => {
      const info = await this.grpc.getAccountInfo(
        AccountAddress.fromBase58(address),
        await resolveBlockHash(this.grpc, block),
      );
      return {
        accountAddress: info.accountAddress,
        accountThreshold: info.accountThreshold,
        accountCredentials: info.accountCredentials,
      };
    });
  }

  getBlockItem(transactionHash: string): Promise<BlockItemDTO> {
    return getBlockItem(this.grpc, transactionHash);
  }

  getLockInfo(lockId: string): Promise<LockInfoDTO> {
    return guard(async () => {
      const raw = await this.grpc.getLockInfo(LockId.fromString(lockId));
      return lockInfoToDto(Cbor.decode(raw.lockInfo, 'LockInfo'));
    });
  }

  getLockList(): Promise<string[]> {
    return guard(async () => {
      const locks: string[] = [];
      for await (const lockId of this.grpc.getLockList()) {
        locks.push(lockId.toString());
      }
      return locks;
    });
  }

  getNextAccountSequenceNumber(address: string): Promise<NextSequenceNumberDTO> {
    return guard(async () =>
      nextAccountSequenceNumberToDto(await this.grpc.getNextAccountNonce(AccountAddress.fromBase58(address))),
    );
  }

  getBlockInfo(block?: BlockIdentifier): Promise<BlockInfoDTO> {
    return guard(async () => blockInfoToDto(await this.grpc.getBlockInfo(await resolveBlockHash(this.grpc, block))));
  }

  getBlockTransactionEvents(block?: BlockIdentifier): Promise<BlockTransactionEventsDTO> {
    return guard(async () => {
      const blockHash = await resolveBlockHash(this.grpc, block);
      const info = await this.grpc.getBlockInfo(blockHash);
      const events: TransactionEffectDTO[] = [];
      for await (const summary of this.grpc.getBlockTransactionEvents(blockHash)) {
        if (isKnown(summary)) events.push(blockItemSummaryToEventDto(summary));
      }
      return { hash: String(info.blockHash), height: info.blockHeight.toString(), events };
    });
  }

  getTransactionEffects(transactionHash: string): Promise<TransactionEffectsDTO> {
    return guard(async () => {
      const status = await this.grpc.getBlockItemStatus(TransactionHash.fromHexString(transactionHash));
      if (status.status === 'received') return { transactionHash, status: 'received', blockHash: null, effects: [] };
      const outcomes = status.status === 'finalized' ? [status.outcome] : status.outcomes;
      const blockHash = outcomes[0]?.blockHash;
      return {
        transactionHash,
        status: status.status,
        blockHash: blockHash === undefined ? null : String(blockHash),
        effects: outcomes.flatMap((outcome) => {
          if (!isKnown(outcome.summary)) return [];
          return [blockItemSummaryToEventDto(outcome.summary)];
        }),
      };
    });
  }

  getConsensusInfo(): Promise<ConsensusInfoDTO> {
    return guard(async () => consensusInfoToDto(await this.grpc.getConsensusStatus()));
  }

  getProtocolVersion(): Promise<number> {
    return guard(async () => Number((await this.grpc.getConsensusStatus()).protocolVersion));
  }

  getInstanceInfo(index: bigint, subindex: bigint): Promise<InstanceInfoDTO> {
    return guard(async () => {
      const address = ContractAddress.create(index, subindex);
      return instanceInfoToDto(await this.grpc.getInstanceInfo(address), { index, subindex });
    });
  }

  getModuleRefs(): Promise<string[]> {
    return guard(async () => {
      const modules: string[] = [];
      for await (const ref of this.grpc.getModuleList()) {
        modules.push(String(ref));
      }
      return modules;
    });
  }

  getModuleSource(moduleRef: string): Promise<ModuleSourceDTO> {
    return this.moduleSourceCache.load(moduleRef, () =>
      guard(async () => {
        const source = await this.grpc.getModuleSource(ModuleReference.fromHexString(moduleRef));
        return { moduleRef, version: source.version, source: source.source };
      }),
    );
  }

  getModuleInterface(moduleRef: string): Promise<ModuleInterfaceDTO> {
    return this.moduleInterfaceCache.load(moduleRef, () =>
      guard(async () => {
        const source = await this.getModuleSource(moduleRef);
        const [moduleInterface, schemaHex] = await Promise.all([
          parseModuleInterface(source),
          this.getModuleSchema(moduleRef),
        ]);
        return {
          moduleRef,
          version: source.version,
          sourceSizeBytes: source.source.byteLength,
          schemaAvailable: schemaHex !== undefined,
          contracts: [...moduleInterface.values()]
            .map((contract) => ({
              name: String(contract.contractName),
              entrypoints: [...contract.entrypointNames].map(String).sort((left, right) => left.localeCompare(right)),
            }))
            .sort((left, right) => left.name.localeCompare(right.name)),
        };
      }),
    );
  }

  getModuleSchema(moduleRef: string): Promise<string | undefined> {
    return this.moduleSchemaCache.load(moduleRef, () =>
      guard(async () => {
        const source = await this.getModuleSource(moduleRef);
        const schema = await getEmbeddedModuleSchema(source);
        return schema === undefined ? undefined : Buffer.from(schema.buffer).toString('hex');
      }),
    );
  }

  simulateContract(param: SimulateContractParam): Promise<InvokeResultDTO> {
    return guard(async () => {
      const blockHash = await resolveBlockHash(this.grpc, param.block);
      const context = {
        ...contractContext(param),
        ...(param.energy !== undefined && { energy: Energy.create(param.energy) }),
        ...(param.invoker !== undefined && { invoker: AccountAddress.fromBase58(param.invoker) }),
      };
      return simulateContractResultToDto(await this.grpc.invokeContract(context, blockHash));
    });
  }

  estimateContractUpdateExecutionEnergy(param: EstimateContractUpdateEnergyParam): Promise<bigint> {
    return guard(async () => {
      const blockHash = await resolveBlockHash(this.grpc, param.block);
      const result = await this.grpc.invokeContract(
        {
          ...contractContext(param),
          invoker: AccountAddress.fromBase58(param.invoker),
        },
        blockHash,
      );
      if (result.tag === 'failure') {
        const reason = renderRejectReason(result.reason);
        throw {
          kind: 'invalid-argument',
          message: `Contract update simulation failed${reason === undefined ? '' : `: ${reason}`}.`,
        };
      }
      return result.usedEnergy.value;
    });
  }

  getPoolInfo(poolId: bigint): Promise<PoolInfoDTO> {
    return guard(async () => {
      const raw = await this.grpc.getPoolInfo(poolId);
      return {
        poolId: raw.bakerId.toString(),
        bakerAccount: raw.bakerAddress.address,
        stakedAmount: raw.bakerEquityCapital?.microCcdAmount.toString() ?? '0',
        delegatedAmount: raw.delegatedCapital?.microCcdAmount.toString() ?? '0',
        ...(raw.delegatedCapitalCap !== undefined && {
          delegatedCapitalCap: raw.delegatedCapitalCap.microCcdAmount.toString(),
        }),
        currentPaydayStaked: raw.currentPaydayStatus?.bakerEquityCapital.microCcdAmount.toString() ?? '0',
        currentPaydayDelegated: raw.currentPaydayStatus?.delegatedCapital.microCcdAmount.toString() ?? '0',
        poolType: 'BakerPool',
        ...(raw.poolInfo !== undefined && {
          poolInfo: {
            openStatus: raw.poolInfo.openStatus === null ? null : String(raw.poolInfo.openStatus),
            metadataUrl: raw.poolInfo.metadataUrl,
            commissionRates: raw.poolInfo.commissionRates,
          },
        }),
        isSuspended: raw.isSuspended,
      };
    });
  }

  getAccountPoolInfo(address: string): Promise<AccountPoolInfoDTO> {
    return guard(async () => {
      const info = await this.grpc.getAccountInfo(AccountAddress.fromBase58(address));
      switch (info.type) {
        case AccountInfoType.Baker:
          return {
            address,
            poolStatus: 'Baker',
            stakedAmount: info.accountBaker.stakedAmount.microCcdAmount.toString(),
          };
        case AccountInfoType.Delegator: {
          const target = info.accountDelegation.delegationTarget;
          return {
            address,
            poolStatus: 'Delegator',
            ...(target.delegateType === DelegationTargetType.Baker && {
              bakerPoolId: target.bakerId.toString(),
            }),
            stakedAmount: info.accountDelegation.stakedAmount.microCcdAmount.toString(),
          };
        }
        default:
          return { address, poolStatus: 'None', stakedAmount: '0' };
      }
    });
  }

  getPassiveDelegationInfo(): Promise<PassiveDelegationInfoDTO> {
    return guard(async () => {
      const raw = await this.grpc.getPassiveDelegationInfo();
      return {
        totalStaked: raw.delegatedCapital.microCcdAmount.toString(),
        currentPaydayStaked: raw.currentPaydayDelegatedCapital.microCcdAmount.toString(),
      };
    });
  }

  getTokenList(): Promise<TokenListDTO> {
    return guard(async () => {
      const tokens: TokenDTO[] = [];
      for await (const id of this.grpc.getTokenList()) {
        const info = await this.grpc.getTokenInfo(id);
        tokens.push({
          tokenId: String(id),
          decimals: info.state.decimals,
          'total supply': {
            value: info.state.totalSupply.value.toString(),
            decimals: info.state.decimals,
            display: formatTokenAmount(info.state.totalSupply.value, info.state.decimals),
          },
        });
      }
      return { PLTs: tokens };
    });
  }

  getTokenIds(block?: BlockIdentifier): Promise<string[]> {
    return guard(async () => {
      const blockHash = await resolveBlockHash(this.grpc, block);
      const ids: string[] = [];
      for await (const id of this.grpc.getTokenList(blockHash)) ids.push(String(id));
      return ids;
    });
  }

  getTokenInfo(tokenId: string): Promise<TokenInfoDTO> {
    return guard(async () => {
      const info = await this.grpc.getTokenInfo(TokenId.fromString(tokenId));
      const state = Cbor.decode(info.state.moduleState, 'TokenModuleState');
      return {
        tokenId: String(info.id),
        moduleRef: String(info.state.moduleRef),
        decimals: info.state.decimals,
        'total supply': {
          value: info.state.totalSupply.value.toString(),
          decimals: info.state.decimals,
          display: formatTokenAmount(info.state.totalSupply.value, info.state.decimals),
        },
        name: state.name,
        metadataUrl: state.metadata?.toString(),
        governanceAccount: state.governanceAccount?.toString(),
        allowList: state.allowList,
        denyList: state.denyList,
        mintable: state.mintable,
        burnable: state.burnable,
        paused: state.paused,
      };
    });
  }

  getAccountTokens(address: string): Promise<AccountTokensDTO> {
    return guard(async () => {
      const info = await this.grpc.getAccountInfo(AccountAddress.fromBase58(address));
      return { address, PLTs: tokenHoldingsToDto(info) };
    });
  }

  getAccountBalances(address: string): Promise<AccountBalancesDTO> {
    return guard(async () => accountBalancesToDto(await this.readAccountInfo(this.accountSelector(address))));
  }

  getAccountBalance(address: string, tokenId: string): Promise<AccountBalanceResourceDTO> {
    return guard(async () => {
      if (tokenId === 'CCD') {
        const balances = accountBalancesToDto(await this.readAccountInfo(this.accountSelector(address)));
        return { address: balances.address, balance: balances.balances.CCD! };
      }
      return {
        address,
        balance: tokenHoldingBalanceToDto(await this.getTokenBalance(tokenId, address)),
      };
    });
  }

  getAccountStake(address: string): Promise<AccountStakeResourceDTO> {
    return guard(async () => accountStakeToDto(await this.readAccountInfo(this.accountSelector(address))));
  }

  getTokenBalance(tokenId: string, holder: string): Promise<TokenBalanceDTO> {
    return guard(async () => {
      const [info, tokenInfo] = await Promise.all([
        this.grpc.getAccountInfo(AccountAddress.fromBase58(holder)),
        this.grpc.getTokenInfo(TokenId.fromString(tokenId)),
      ]);
      const balance = tokenBalancesToDto(info).find((token) => token.tokenId === tokenId);
      if (balance !== undefined) return balance;

      const decimals = tokenInfo.state.decimals;
      return {
        tokenId,
        holder,
        decimals,
        'total balance': { value: '0', decimals, display: formatTokenAmount(0n, decimals) },
        'available balance': { value: '0', decimals, display: formatTokenAmount(0n, decimals) },
        'locked balance': { value: '0', decimals, display: formatTokenAmount(0n, decimals) },
        locks: [],
      };
    });
  }

  getCis2TokenBalance(contract: ContractIdentifier, tokenId: string, address: string): Promise<Cis2BalanceDTO> {
    return guard(async () => {
      const cis2 = await CIS2Contract.create(this.grpc, ContractAddress.create(contract.index, contract.subindex));
      const balance = await cis2.balanceOf({
        tokenId,
        address: AccountAddress.fromBase58(address),
      });
      return {
        contractIndex: contract.index.toString(),
        contractSubindex: contract.subindex.toString(),
        tokenId,
        address,
        balance: balance.toString(),
      };
    });
  }

  submitBlockItem(blockItemHex: string): Promise<string> {
    return submitBlockItem(this.grpc, blockItemHex);
  }
}

/** Creates a connected SDK gRPC client against a node gRPC endpoint. */
export function createConcordiumClient(endpoint: GrpcEndpoint, timeoutMs: number): ConcordiumGRPCClient {
  return new ConcordiumGRPCNodeClient(
    endpoint.host,
    endpoint.port,
    endpoint.tls ? credentials.createSsl() : credentials.createInsecure(),
    { timeout: timeoutMs },
  );
}
