import type {
  AccountSigningRequirements,
  AccountVerificationInfo,
  BlockIdentifier,
  ConcordiumQueryClient,
  ContractIdentifier,
  EstimateContractUpdateEnergyParam,
  SimulateContractParam,
} from '../../src/concordium/client.js';
import type {
  AccountBalanceResourceDTO,
  AccountBalancesDTO,
  AccountInfoDTO,
  AccountStakeResourceDTO,
  AccountTokensDTO,
  BlockItemDTO,
  LockInfoDTO,
  AccountPoolInfoDTO,
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
  TokenInfoDTO,
  TokenListDTO,
  TransactionEffectsDTO,
} from '../../src/concordium/dto.js';
import type { ServerConfig } from '../../src/config.js';
import type { NetworkClientProvider, ToolContext } from '../../src/mcp/toolPlumbing/toolTypes.js';
import { resolveNetwork, type AccountCredentialObservation } from '@ccd-agent-kit/config-utils';
import { ed25519PublicKey } from '@ccd-agent-kit/sdk-utils';

export interface FakeDataset {
  protocolVersion?: number;
  accounts?: Record<string, AccountInfoDTO>;
  accountsByIndex?: Record<string, AccountInfoDTO>;
  accountBalances?: Record<string, AccountBalancesDTO>;
  accountStakes?: Record<string, AccountStakeResourceDTO>;
  signingRequirements?: Record<string, AccountSigningRequirements>;
  accountVerificationInfos?: Record<string, AccountVerificationInfo>;
  lockInfos?: Record<string, LockInfoDTO>;
  lockList?: string[];
  sequenceNumbers?: Record<string, NextSequenceNumberDTO>;
  blocks?: Record<string, BlockInfoDTO>;
  blockItems?: Record<string, BlockItemDTO>;
  transactionEffects?: Record<string, TransactionEffectsDTO>;
  consensus?: ConsensusInfoDTO;
  instances?: Record<string, InstanceInfoDTO>;
  moduleRefs?: string[];
  moduleSources?: Record<string, ModuleSourceDTO>;
  moduleInterfaces?: Record<string, ModuleInterfaceDTO>;
  moduleSchemas?: Record<string, string | undefined>;
  invokes?: InvokeResultDTO[];
  contractUpdateExecutionEnergy?: string;
  contractUpdateExecutionEnergyError?: unknown;
  pools?: Record<string, PoolInfoDTO>;
  accountPools?: Record<string, AccountPoolInfoDTO>;
  passiveDelegation?: PassiveDelegationInfoDTO;
  tokenList?: TokenListDTO;
  tokenIds?: string[];
  tokenInfos?: Record<string, TokenInfoDTO>;
  accountTokens?: Record<string, AccountTokensDTO>;
  tokenBalances?: Record<string, TokenBalanceDTO>;
  cis2Balances?: Record<string, Cis2BalanceDTO>;
  submittedBlockItems?: Record<string, string>;
  accountCredentialObservations?: Record<string, { canonicalAddress: string; observation: AccountCredentialObservation }>;
}

function resolveBlock(blocks: Record<string, BlockInfoDTO>, id: BlockIdentifier | undefined): BlockInfoDTO {
  const key =
    id === undefined || id.type === 'last_final'
      ? 'last_final'
      : id.type === 'best'
        ? 'best'
        : id.type === 'hash'
          ? id.hash
          : `${id.genesisIndex ?? 0}:${id.height}`;
  const block = blocks[key];
  if (!block) throw { kind: 'invalid-argument', message: `Unknown block: ${key}` };
  return block;
}

function accountVerificationObservation(info: AccountVerificationInfo): AccountCredentialObservation {
  return {
    accountThreshold: String(info.accountThreshold),
    credentials: Object.fromEntries(
      Object.entries(info.accountCredentials).map(([credentialIndex, credential]) => {
        const publicKeys = (credential as { value?: { contents?: { credentialPublicKeys?: { threshold?: number | bigint; keys?: Record<string, { schemeId?: string; verifyKey?: string }> } } } })
          .value?.contents?.credentialPublicKeys;
        return [
          credentialIndex,
          {
            threshold: String(publicKeys?.threshold ?? 1),
            keys: Object.fromEntries(
              Object.entries(publicKeys?.keys ?? {}).flatMap(([keyIndex, key]) =>
                typeof key.schemeId === 'string' && key.schemeId.toLowerCase() === 'ed25519' && key.verifyKey !== undefined
                  ? [[keyIndex, { scheme: 'Ed25519' as const, publicKey: ed25519PublicKey.require(key.verifyKey) }]]
                  : [],
              ),
            ),
          },
        ];
      }),
    ),
    sourceBlock: { hash: '00'.repeat(32), height: '0', time: '2026-01-01T00:00:00.000Z' },
  };
}

export function createStaticNetworkClientProvider(
  client: ConcordiumQueryClient,
  networkName: string,
): NetworkClientProvider {
  return {
    getClient: (network) => ({
      client,
      networkName: typeof network === 'object' ? network.name : (network ?? networkName),
    }),
  };
}

export class FakeConcordiumClient implements ConcordiumQueryClient {
  readonly calls: Record<string, number> = {};
  lastEstimateContractUpdateExecutionEnergyParam?: EstimateContractUpdateEnergyParam;

  constructor(private readonly data: FakeDataset = {}) {}

  private count(method: string): void {
    this.calls[method] = (this.calls[method] ?? 0) + 1;
  }

  private accountBalanceKey(selector: string): string {
    const byIndex = /^\d+$/.test(selector) ? this.data.accountsByIndex?.[selector]?.address : undefined;
    return byIndex ?? selector;
  }

  async getAccountInfo(address: string): Promise<AccountInfoDTO> {
    this.count('getAccountInfo');
    const account = this.data.accounts?.[address];
    if (!account) throw { kind: 'invalid-argument', message: `Unknown account: ${address}` };
    return account;
  }

  async getAccountInfoByIndex(index: bigint): Promise<AccountInfoDTO> {
    this.count('getAccountInfoByIndex');
    const account = this.data.accountsByIndex?.[index.toString()];
    if (!account) throw { kind: 'invalid-argument', message: `Unknown account index: ${index}` };
    return account;
  }

  async getAccountAddressByIndex(index: bigint): Promise<string> {
    this.count('getAccountAddressByIndex');
    return (await this.getAccountInfoByIndex(index)).address;
  }

  async getFinalizedAccountCredentials(
    address: string,
  ): Promise<{ canonicalAddress: string; observation: AccountCredentialObservation }> {
    this.count('getFinalizedAccountCredentials');
    const observation = this.data.accountCredentialObservations?.[address];
    if (!observation) {
      const verificationInfo = this.data.accountVerificationInfos?.[address];
      if (verificationInfo !== undefined) {
        return { canonicalAddress: address, observation: accountVerificationObservation(verificationInfo) };
      }
      throw { kind: 'invalid-argument', message: `Unknown account credentials: ${address}` };
    }
    return observation;
  }

  async getAccountBalances(address: string): Promise<AccountBalancesDTO> {
    const balances = this.data.accountBalances?.[address] ?? this.data.accountBalances?.[this.accountBalanceKey(address)];
    if (!balances) throw { kind: 'invalid-argument', message: `Unknown account balances: ${address}` };
    return balances;
  }

  async getAccountBalance(address: string, tokenId: string): Promise<AccountBalanceResourceDTO> {
    const key = this.accountBalanceKey(address);
    const balance = this.data.accountBalances?.[address]?.balances[tokenId] ?? this.data.accountBalances?.[key]?.balances[tokenId];
    if (!balance) throw { kind: 'invalid-argument', message: `Unknown account balance: ${address}:${tokenId}` };
    return { address: this.data.accountBalances?.[key]?.address ?? address, balance };
  }

  async getAccountStake(address: string): Promise<AccountStakeResourceDTO> {
    const stake = this.data.accountStakes?.[address] ?? this.data.accountStakes?.[this.accountBalanceKey(address)];
    if (!stake) throw { kind: 'invalid-argument', message: `Unknown account stake: ${address}` };
    return stake;
  }

  async getAccountSigningRequirements(address: string): Promise<AccountSigningRequirements> {
    const requirements = this.data.signingRequirements?.[address];
    if (requirements) return requirements;
    const account = this.data.accounts?.[address];
    if (!account) throw { kind: 'invalid-argument', message: `Unknown account: ${address}` };
    return {
      accountThreshold: account.keys.threshold,
      credentialSignThresholds: Array.from({ length: account.keys.credentialCount }, () => 1),
    };
  }

  async getAccountVerificationInfo(address: string): Promise<AccountVerificationInfo> {
    this.count('getAccountVerificationInfo');
    const info = this.data.accountVerificationInfos?.[address];
    if (!info) throw { kind: 'invalid-argument', message: `Unknown account verification info: ${address}` };
    return info;
  }

  async getProtocolVersion(): Promise<number> {
    return this.data.protocolVersion ?? 11;
  }

  async getLockInfo(lockId: string): Promise<LockInfoDTO> {
    const info = this.data.lockInfos?.[lockId];
    if (!info) throw { kind: 'invalid-argument', message: `Unknown lock: ${lockId}` };
    return info;
  }

  async getLockList(): Promise<string[]> {
    return this.data.lockList ?? Object.keys(this.data.lockInfos ?? {});
  }

  async getNextAccountSequenceNumber(address: string): Promise<NextSequenceNumberDTO> {
    this.count('getNextAccountSequenceNumber');
    const sequenceNumber = this.data.sequenceNumbers?.[address];
    if (!sequenceNumber) throw { kind: 'invalid-argument', message: `Unknown account: ${address}` };
    return sequenceNumber;
  }

  async getBlockInfo(block?: BlockIdentifier): Promise<BlockInfoDTO> {
    const blocks = this.data.blocks ?? {};
    return resolveBlock(blocks, block);
  }

  async getBlockItem(transactionHash: string): Promise<BlockItemDTO> {
    const item = this.data.blockItems?.[transactionHash];
    if (!item) throw { kind: 'invalid-argument', message: `Unknown block item: ${transactionHash}` };
    return item;
  }

  async getTransactionEffects(transactionHash: string): Promise<TransactionEffectsDTO> {
    const effects = this.data.transactionEffects?.[transactionHash];
    if (!effects) throw { kind: 'invalid-argument', message: `Unknown transaction: ${transactionHash}` };
    return effects;
  }

  async getBlockTransactionEvents(block?: BlockIdentifier): Promise<BlockTransactionEventsDTO> {
    const info = await this.getBlockInfo(block);
    return { hash: info.hash, height: info.height, events: [] };
  }

  async getConsensusInfo(): Promise<ConsensusInfoDTO> {
    if (!this.data.consensus) throw { kind: 'node', message: 'No consensus data' };
    return this.data.consensus;
  }

  async getInstanceInfo(index: bigint, subindex: bigint): Promise<InstanceInfoDTO> {
    const instance = this.data.instances?.[`${index},${subindex}`];
    if (!instance) throw { kind: 'invalid-argument', message: `Unknown instance: ${index},${subindex}` };
    return instance;
  }

  async getModuleRefs(): Promise<string[]> {
    return this.data.moduleRefs ?? [];
  }

  async getModuleSource(moduleRef: string): Promise<ModuleSourceDTO> {
    const source = this.data.moduleSources?.[moduleRef];
    if (source === undefined) throw { kind: 'invalid-argument', message: `Unknown module: ${moduleRef}` };
    return source;
  }

  async getModuleInterface(moduleRef: string): Promise<ModuleInterfaceDTO> {
    this.count('getModuleInterface');
    const info = this.data.moduleInterfaces?.[moduleRef];
    if (info !== undefined) return info;
    const source = this.data.moduleSources?.[moduleRef];
    if (source === undefined) throw { kind: 'invalid-argument', message: `Unknown module: ${moduleRef}` };
    return { moduleRef, version: source.version, sourceSizeBytes: source.source.byteLength, schemaAvailable: false, contracts: [] };
  }

  async getModuleSchema(moduleRef: string): Promise<string | undefined> {
    this.count('getModuleSchema');
    return this.data.moduleSchemas?.[moduleRef];
  }

  async simulateContract(param: SimulateContractParam): Promise<InvokeResultDTO> {
    if (param.contract.index === 999n) throw { kind: 'node', message: 'Node unreachable', code: 14 };
    const result = this.data.invokes?.shift();
    if (!result) throw { kind: 'invalid-argument', message: 'No simulation result configured' };
    return result;
  }

  async estimateContractUpdateExecutionEnergy(param: EstimateContractUpdateEnergyParam): Promise<bigint> {
    this.count('estimateContractUpdateExecutionEnergy');
    this.lastEstimateContractUpdateExecutionEnergyParam = param;
    if (this.data.contractUpdateExecutionEnergyError !== undefined) throw this.data.contractUpdateExecutionEnergyError;
    if (this.data.contractUpdateExecutionEnergy === undefined) {
      throw { kind: 'invalid-argument', message: 'No contract update energy estimate configured' };
    }
    return BigInt(this.data.contractUpdateExecutionEnergy);
  }

  async getPoolInfo(poolId: bigint): Promise<PoolInfoDTO> {
    const pool = this.data.pools?.[poolId.toString()];
    if (!pool) throw { kind: 'invalid-argument', message: `Unknown pool: ${poolId}` };
    return pool;
  }

  async getAccountPoolInfo(address: string): Promise<AccountPoolInfoDTO> {
    const pool = this.data.accountPools?.[address];
    if (!pool) throw { kind: 'invalid-argument', message: `Unknown account: ${address}` };
    return pool;
  }

  async getPassiveDelegationInfo(): Promise<PassiveDelegationInfoDTO> {
    if (!this.data.passiveDelegation) throw { kind: 'node', message: 'No passive delegation data' };
    return this.data.passiveDelegation;
  }

  async getTokenList(): Promise<TokenListDTO> {
    return this.data.tokenList ?? { PLTs: [] };
  }

  async getTokenIds(): Promise<string[]> {
    this.count('getTokenIds');
    return this.data.tokenIds ?? this.data.tokenList?.PLTs.map((token) => token.tokenId) ?? [];
  }

  async getTokenInfo(tokenId: string): Promise<TokenInfoDTO> {
    this.count('getTokenInfo');
    const info = this.data.tokenInfos?.[tokenId];
    if (!info) throw { kind: 'invalid-argument', message: `Unknown token: ${tokenId}` };
    return info;
  }

  async getAccountTokens(address: string): Promise<AccountTokensDTO> {
    return this.data.accountTokens?.[address] ?? { address, PLTs: [] };
  }

  async getTokenBalance(tokenId: string, holder: string): Promise<TokenBalanceDTO> {
    const balance = this.data.tokenBalances?.[`${tokenId}:${holder}`];
    if (!balance) throw { kind: 'invalid-argument', message: `Unknown token balance` };
    return balance;
  }

  async getCis2TokenBalance(contract: ContractIdentifier, tokenId: string, address: string): Promise<Cis2BalanceDTO> {
    const key = `${contract.index},${contract.subindex}:${tokenId}:${address}`;
    const balance = this.data.cis2Balances?.[key];
    if (!balance) throw { kind: 'invalid-argument', message: `Unknown CIS-2 balance` };
    return balance;
  }

  async submitBlockItem(blockItemHex: string): Promise<string> {
    const transactionHash = this.data.submittedBlockItems?.[blockItemHex];
    if (!transactionHash) throw { kind: 'invalid-argument', message: 'Unknown block item' };
    return transactionHash;
  }
}

export function makeContext(client: ConcordiumQueryClient, config?: Partial<ServerConfig>): ToolContext {
  const network = config?.network ?? 'mainnet';
  const resolvedNetwork = config?.resolvedNetwork ?? resolveNetwork(network);
  return {
    clients: createStaticNetworkClientProvider(client, network),
    config: {
      network,
      resolvedNetwork,
      defaultNetworkSource: 'config',
      grpc: { endpoint: 'grpc.mainnet.concordium.software:20000', tls: true, timeoutMs: 15000 },
      transport: 'stdio',
      accountCredentials: { startupRefresh: { enabled: true, maxAgeMs: 86_400_000, failureRetryMs: 300_000, concurrency: 3 } },
      ...config,
    },
  };
}
