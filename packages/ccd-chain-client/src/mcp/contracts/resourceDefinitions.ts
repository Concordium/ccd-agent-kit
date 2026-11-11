import type { ResolvedNetwork } from '@ccd-agent-kit/config-utils';
import {
  contractInstance,
  normalizeInitContractName,
  normalizeReceiveEntrypoint,
  schemaTypeToJsonSchema,
  type SmartContractJsonSchema,
} from '@ccd-agent-kit/sdk-utils';
import { parseRawModuleSchema } from '@concordium/web-sdk';
import { NetworkResourceError } from '@ccd-agent-kit/mcp-utils';
import type { ToolContext } from '../toolPlumbing/toolTypes.js';
import type { ResourceInstance } from '../resourcePlumbing/resourceTypes.js';
import { readRequiredChainResource, type ChainNetworkResourceFamily } from '../resourcePlumbing/networkResources.js';
import { listContractInstanceLabelsForNetwork, resolveContractInstanceUriSegment } from './contractInstanceLabels.js';

interface ContractSchemaPayload {
  module: { moduleRef: string };
  contract: { name: string };
  schemaAvailable: boolean;
  entrypoint?: string;
  parameter?: SmartContractJsonSchema;
  events?: SmartContractJsonSchema;
  returnValue?: SmartContractJsonSchema;
  error?: SmartContractJsonSchema;
}


function missingResource(message: string): never {
  throw new NetworkResourceError('RESOURCE_NOT_FOUND', message);
}

async function schemaForModule(ctx: ToolContext, network: ResolvedNetwork, moduleRef: string): Promise<string | undefined> {
  return ctx.clients.getClient(network).client.getModuleSchema(moduleRef);
}

function schemaBufferFromHex(schemaHex: string): ArrayBuffer {
  const buffer = Buffer.from(schemaHex, 'hex');
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

function rawContractSchema(schemaHex: string, contractName: string) {
  const normalized = normalizeInitContractName(contractName);
  const parsed = parseRawModuleSchema({ type: 'versioned', buffer: schemaBufferFromHex(schemaHex) });
  switch (parsed.version) {
    case 0: {
      const schema = parsed.module.contracts.get(normalized);
      if (schema === undefined) missingResource(`Contract ${normalized} was not found in module schema.`);
      return { name: normalized, version: parsed.version, schema };
    }
    case 1: {
      const schema = parsed.module.contracts.get(normalized);
      if (schema === undefined) missingResource(`Contract ${normalized} was not found in module schema.`);
      return { name: normalized, version: parsed.version, schema };
    }
    case 2: {
      const schema = parsed.module.contracts.get(normalized);
      if (schema === undefined) missingResource(`Contract ${normalized} was not found in module schema.`);
      return { name: normalized, version: parsed.version, schema };
    }
    case 3: {
      const schema = parsed.module.contracts.get(normalized);
      if (schema === undefined) missingResource(`Contract ${normalized} was not found in module schema.`);
      return { name: normalized, version: parsed.version, schema };
    }
  }
}

async function readModuleCatalogueResource(ctx: ToolContext, network: ResolvedNetwork): Promise<unknown> {
  return { modules: await ctx.clients.getClient(network).client.getModuleRefs() };
}

async function readModuleResource(ctx: ToolContext, network: ResolvedNetwork, moduleRef: string): Promise<unknown> {
  const decodedModuleRef = decodeURIComponent(moduleRef);
  const info = await readRequiredChainResource(() =>
    ctx.clients.getClient(network).client.getModuleInterface(decodedModuleRef),
  );
  return info;
}

async function contractSummary(ctx: ToolContext, network: ResolvedNetwork, moduleRef: string, contractName: string) {
  const client = ctx.clients.getClient(network).client;
  const info = await readRequiredChainResource(() => client.getModuleInterface(moduleRef));
  const contractInterface = info.contracts.find((contract) => contract.name === contractName);
  if (contractInterface === undefined) missingResource(`Contract ${contractName} was not found in module ${moduleRef}.`);

  const schemaHex = await client.getModuleSchema(moduleRef);
  if (schemaHex === undefined) {
    return {
      module: { moduleRef },
      contract: {
        name: contractName,
        schemaAvailable: false,
        hasInit: true,
        hasEvents: false,
        entrypoints: contractInterface.entrypoints.map((name) => ({ name })),
      },
    };
  }

  const schema = rawContractSchema(schemaHex, contractName);
  return {
    module: { moduleRef },
    contract: {
      name: contractName,
      schemaAvailable: true,
        hasInit: schema.schema.init !== undefined,
        hasEvents: schema.version === 3 && schema.schema.event !== undefined,
        entrypoints: [...schema.schema.receive.entries()]
          .map(([name, entrypoint]) => ({
            name: String(name),
            hasParameter: entrypoint.parameter !== undefined,
            hasReturnValue: entrypoint.returnValue !== undefined,
            hasError:
              schema.version === 2 || schema.version === 3
                ? schema.schema.receive.get(name)?.error !== undefined
                : false,
          }))
          .sort((left, right) => left.name.localeCompare(right.name)),
    },
  };
}

async function readContractResource(
  ctx: ToolContext,
  network: ResolvedNetwork,
  moduleRef: string,
  contractName: string,
): Promise<unknown> {
  return contractSummary(ctx, network, decodeURIComponent(moduleRef), decodeURIComponent(contractName));
}

async function readContractInstanceResource(
  ctx: ToolContext,
  network: ResolvedNetwork,
  addressOrLabel: string,
): Promise<unknown> {
  const { client } = ctx.clients.getClient(network);
  const contract = resolveContractInstanceUriSegment(addressOrLabel, network);
  const info = await readRequiredChainResource(() => client.getInstanceInfo(contract.index, contract.subindex));
  return {
    address: contract.canonical,
    ...(contract.label !== undefined && { label: contract.label }),
    moduleRef: info.moduleRef,
    owner: info.owner,
    amount: info.amount,
    contract: { name: info.name, entrypoints: info.methods },
  };
}

async function resolveContractInstanceSchemaContext(ctx: ToolContext, network: ResolvedNetwork, addressOrLabel: string) {
  const { client } = ctx.clients.getClient(network);
  const contract = resolveContractInstanceUriSegment(addressOrLabel, network);
  const info = await readRequiredChainResource(() => client.getInstanceInfo(contract.index, contract.subindex));
  return {
    info,
    instance: {
      address: contract.canonical,
      ...(contract.label !== undefined && { label: contract.label }),
      moduleRef: info.moduleRef,
      contract: { name: info.name },
    },
  };
}

async function initSchemaObject(
  ctx: ToolContext,
  network: ResolvedNetwork,
  moduleRef: string,
  contractName: string,
): Promise<ContractSchemaPayload> {
  const decodedModuleRef = decodeURIComponent(moduleRef);
  const decodedContractName = decodeURIComponent(contractName);
  const schemaHex = await schemaForModule(ctx, network, decodedModuleRef);
  if (schemaHex === undefined) {
    await contractSummary(ctx, network, decodedModuleRef, decodedContractName);
    return { module: { moduleRef: decodedModuleRef }, contract: { name: decodedContractName }, schemaAvailable: false };
  }
  const body: ContractSchemaPayload = {
    module: { moduleRef: decodedModuleRef },
    schemaAvailable: true,
    contract: { name: decodedContractName },
  };
  const contract = rawContractSchema(schemaHex, decodedContractName);
  if (contract.schema.init?.parameter !== undefined) body.parameter = schemaTypeToJsonSchema(contract.schema.init.parameter);
  return body;
}

async function eventsSchemaObject(
  ctx: ToolContext,
  network: ResolvedNetwork,
  moduleRef: string,
  contractName: string,
): Promise<ContractSchemaPayload> {
  const decodedModuleRef = decodeURIComponent(moduleRef);
  const decodedContractName = decodeURIComponent(contractName);
  const schemaHex = await schemaForModule(ctx, network, decodedModuleRef);
  if (schemaHex === undefined) {
    await contractSummary(ctx, network, decodedModuleRef, decodedContractName);
    return { module: { moduleRef: decodedModuleRef }, contract: { name: decodedContractName }, schemaAvailable: false };
  }
  const body: ContractSchemaPayload = {
    module: { moduleRef: decodedModuleRef },
    schemaAvailable: true,
    contract: { name: decodedContractName },
  };
  const contract = rawContractSchema(schemaHex, decodedContractName);
  if (contract.version === 3 && contract.schema.event !== undefined)
    body.events = schemaTypeToJsonSchema(contract.schema.event);
  return body;
}

async function receiveSchemaObject(
  ctx: ToolContext,
  network: ResolvedNetwork,
  moduleRef: string,
  contractName: string,
  receiveName: string,
): Promise<ContractSchemaPayload> {
  const decodedModuleRef = decodeURIComponent(moduleRef);
  const decodedContractName = decodeURIComponent(contractName);
  const decodedReceiveName = decodeURIComponent(receiveName);
  const schemaHex = await schemaForModule(ctx, network, decodedModuleRef);
  if (schemaHex === undefined) {
    const summary = await contractSummary(ctx, network, decodedModuleRef, decodedContractName);
    const entrypointExists = summary.contract.entrypoints.some((entrypoint) => entrypoint.name === decodedReceiveName);
    if (!entrypointExists) {
      missingResource(`Entrypoint ${decodedReceiveName} was not found in contract ${decodedContractName}.`);
    }
    return {
      module: { moduleRef: decodedModuleRef },
      contract: { name: decodedContractName },
      schemaAvailable: false,
      entrypoint: decodedReceiveName,
    };
  }
  const contract = rawContractSchema(schemaHex, decodedContractName);
  const entrypoint = normalizeReceiveEntrypoint(decodedReceiveName, contract.name);
  const receive = contract.schema.receive.get(entrypoint);
  if (receive === undefined) {
    missingResource(`Entrypoint ${decodedReceiveName} was not found in contract ${decodedContractName}.`);
  }
  const error =
    contract.version === 2 || contract.version === 3
      ? contract.schema.receive.get(entrypoint)?.error
      : undefined;
  const schema = {
    name: entrypoint,
    ...(receive.parameter !== undefined ? { parameter: schemaTypeToJsonSchema(receive.parameter) } : {}),
    ...(receive.returnValue !== undefined ? { returnValue: schemaTypeToJsonSchema(receive.returnValue) } : {}),
    ...(error !== undefined ? { error: schemaTypeToJsonSchema(error) } : {}),
  };
  return {
    module: { moduleRef: decodedModuleRef },
    schemaAvailable: true,
    contract: { name: decodedContractName },
    entrypoint: schema.name,
    ...(schema.parameter !== undefined ? { parameter: schema.parameter } : {}),
    ...(schema.returnValue !== undefined ? { returnValue: schema.returnValue } : {}),
    ...(schema.error !== undefined ? { error: schema.error } : {}),
  };
}

async function readContractInstanceInitSchemaResource(
  ctx: ToolContext,
  network: ResolvedNetwork,
  addressOrLabel: string,
): Promise<unknown> {
  const { info, instance } = await resolveContractInstanceSchemaContext(ctx, network, addressOrLabel);
  const body = await initSchemaObject(ctx, network, info.moduleRef, info.name);
  return { ...body, instance };
}

async function readContractInstanceEventsSchemaResource(
  ctx: ToolContext,
  network: ResolvedNetwork,
  addressOrLabel: string,
): Promise<unknown> {
  const { info, instance } = await resolveContractInstanceSchemaContext(ctx, network, addressOrLabel);
  const body = await eventsSchemaObject(ctx, network, info.moduleRef, info.name);
  return { ...body, instance };
}

async function readContractInstanceReceiveSchemaResource(
  ctx: ToolContext,
  network: ResolvedNetwork,
  addressOrLabel: string,
  receiveName: string,
): Promise<unknown> {
  const { info, instance } = await resolveContractInstanceSchemaContext(ctx, network, addressOrLabel);
  const body = await receiveSchemaObject(ctx, network, info.moduleRef, info.name, receiveName);
  return { ...body, instance };
}

function labeledContractInstanceResources(networkName: string): ResourceInstance[] {
  return Object.entries(listContractInstanceLabelsForNetwork(networkName))
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([label, address]) => [
      {
        uri: `ccd://${networkName}/contract-instance/${encodeURIComponent(label)}`,
        name: `Concordium Contract Instance ${networkName}:${label}`,
      },
      {
        uri: `ccd://${networkName}/contract-instance/${contractInstance.format(address)}`,
        name: `Concordium Contract Instance ${networkName}:${contractInstance.format(address)}`,
      },
      {
        uri: `ccd://${networkName}/contract-instance/${encodeURIComponent(label)}/init/schema`,
        name: `Concordium Contract Instance Init Schema ${networkName}:${label}`,
      },
    ]);
}

function defaultLabeledContractInstanceResources(networkName: string): ResourceInstance[] {
  return labeledContractInstanceResources(networkName).map(({ uri, name }) => ({
    uri: uri.replace(`ccd://${networkName}/`, 'ccd://'),
    name: name.replace(`${networkName}:`, ''),
  }));
}

function readContractInstanceLabelsResource(network: ResolvedNetwork): unknown {
    const labels = listContractInstanceLabelsForNetwork(network);
  return {
    labels: Object.fromEntries(
      Object.entries(labels)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([label, address]) => [label, { ...address, address: contractInstance.format(address) }]),
    ),
  };
}

/** Returns contract-instance, module, and contract-schema resource families. */
export function contractResourceFamilies(): ChainNetworkResourceFamily[] {
  const schema = (name: string, path: string, read: ChainNetworkResourceFamily['read']): ChainNetworkResourceFamily => ({
    name, path, title: 'Concordium Contract Schema',
    description: 'Parsed smart-contract module schema resource.', read,
  });
  return [
    {
      name: 'contract-instance', path: 'contract-instance/{addressOrLabel}',
      title: 'Concordium Contract Instance',
      description: 'Contract instance module, owner, balance, contract name, and receive entrypoints.',
      read: ({ ctx, network, parameters }) => readContractInstanceResource(ctx, network, parameters.addressOrLabel!),
      listDefault: async (ctx) => defaultLabeledContractInstanceResources(ctx.config.network),
    },
    schema('contract-instance-init-schema', 'contract-instance/{addressOrLabel}/init/schema',
      ({ ctx, network, parameters }) => readContractInstanceInitSchemaResource(ctx, network, parameters.addressOrLabel!)),
    schema('contract-instance-events-schema', 'contract-instance/{addressOrLabel}/events/schema',
      ({ ctx, network, parameters }) => readContractInstanceEventsSchemaResource(ctx, network, parameters.addressOrLabel!)),
    schema('contract-instance-receive-schema', 'contract-instance/{addressOrLabel}/receive/{entrypoint}/schema',
      ({ ctx, network, parameters }) => readContractInstanceReceiveSchemaResource(
        ctx, network, parameters.addressOrLabel!, parameters.entrypoint!,
      )),
    {
      name: 'modules', path: 'modules', title: 'Concordium Smart Contract Modules',
      description: 'Smart contract module references.',
      read: ({ ctx, network }) => readModuleCatalogueResource(ctx, network),
      listDefault: async () => [{ uri: 'ccd://modules', name: 'Concordium Smart Contract Modules' }],
    },
    schema('module', 'module/{moduleRef}',
      ({ ctx, network, parameters }) => readModuleResource(ctx, network, parameters.moduleRef!)),
    schema('module-contract', 'module/{moduleRef}/contract/{contractName}',
      ({ ctx, network, parameters }) => readContractResource(ctx, network, parameters.moduleRef!, parameters.contractName!)),
    schema('module-contract-init-schema', 'module/{moduleRef}/contract/{contractName}/init/schema',
      ({ ctx, network, parameters }) => initSchemaObject(ctx, network, parameters.moduleRef!, parameters.contractName!)),
    schema('module-contract-events-schema', 'module/{moduleRef}/contract/{contractName}/events/schema',
      ({ ctx, network, parameters }) => eventsSchemaObject(ctx, network, parameters.moduleRef!, parameters.contractName!)),
    schema('module-contract-receive-schema', 'module/{moduleRef}/contract/{contractName}/receive/{entrypoint}/schema',
      ({ ctx, network, parameters }) => receiveSchemaObject(
        ctx, network, parameters.moduleRef!, parameters.contractName!, parameters.entrypoint!,
      )),
    {
      name: 'contract-instance-labels', path: 'contract-instance-labels',
      title: 'Concordium Contract Instance Labels',
      description: 'Configured contract instance labels.',
      read: async ({ network }) => readContractInstanceLabelsResource(network),
      listDefault: async () => [{ uri: 'ccd://contract-instance-labels', name: 'Concordium Contract Instance Labels' }],
    },
  ];
}
