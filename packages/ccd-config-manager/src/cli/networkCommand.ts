import { z } from 'zod';
import {
  BUILTIN_NETWORKS,
  CATALOG_LABEL_PATTERN,
  addNetwork,
  getNetwork,
  getActiveNetworkFromRegistry,
  loadNetworks,
  removeNetwork,
  resolveNetworkFromRegistry,
  setDefaultNetwork,
  updateNetwork,
  type NetworkConfig,
} from '@ccd-agent-kit/config-utils';
import { autoDetectConnection, caip2FromGenesis } from '../core/grpc.js';

export interface RunNetworkCommandOptions {
  request: NetworkCommandRequest;
  stdout: string[];
  stderr: string[];
}

/** Operational request for network configuration after Commander parsing, including persisted-default inspection. */
export type NetworkCommandRequest =
  | { kind: 'list' }
  | { kind: 'show'; name: string }
  | { kind: 'default-show' }
  | { kind: 'add'; name: string; grpcHost: string; grpcPort: string }
  | { kind: 'update'; name: string; grpcHost?: string; grpcPort?: string }
  | { kind: 'remove'; name: string }
  | { kind: 'default'; name: string }
  | { kind: 'doctor'; name?: string };

const networkCommandMessages = {
  genesisMismatch: (expected: string, actual: string, context: 'doctor' | 'update') =>
    context === 'update'
      ? `Genesis hash mismatch: expected ${expected}, got ${actual}. This node may be a different network.`
      : `Genesis hash mismatch: expected ${expected}, got ${actual}.`,
  networkNotFound: (name: string) => `Network '${name}' not found.`,
} as const;

const networkNameSchema = z
  .string()
  .trim()
  .regex(
    CATALOG_LABEL_PATTERN,
    'Network name must be 1-49 ASCII characters, start with a letter, and contain only letters, digits, underscores, or hyphens.',
  );
const grpcHostSchema = z.string().trim().min(1, 'gRPC host must not be blank.');
const grpcPortSchema = z.coerce
  .number()
  .int()
  .min(1, 'Invalid port number. Must be between 1 and 65535.')
  .max(65535, 'Invalid port number. Must be between 1 and 65535.');
const addEndpointSchema = z.object({ grpcHost: grpcHostSchema, grpcPort: grpcPortSchema });
const updateEndpointSchema = addEndpointSchema.partial();

/** Runs the human-facing network configuration command after validating command-owned names and endpoint options. */
export async function runNetworkCommand(options: RunNetworkCommandOptions): Promise<number> {
  let { request } = options;
  if ('name' in request && request.name !== undefined) {
    const result = networkNameSchema.safeParse(request.name);
    if (!result.success) {
      options.stderr.push(result.error.issues[0].message);
      return 2;
    }
    request = { ...request, name: result.data };
  }

  try {
    switch (request.kind) {
      case 'list':
        return runList(options);
      case 'show':
        return runShow(options, request.name);
      case 'default-show':
        return runDefaultShow(options);
      case 'add':
        return await runAdd(options, request);
      case 'update':
        return await runUpdate(options, request);
      case 'remove':
        return runRemove(options, request.name);
      case 'default':
        return runDefault(options, request.name);
      case 'doctor':
        return await runDoctor(options, request.name);
    }
  } catch (error) {
    options.stderr.push(formatUnknownError(error));
    return 1;
  }
}

function runList(options: RunNetworkCommandOptions): number {
  const config = loadNetworks();
  const activeDefault = getActiveNetworkFromRegistry(config);

  options.stdout.push('Networks:', '');
  for (const name of Object.keys(config.networks).sort((left, right) => left.localeCompare(right))) {
    const network = config.networks[name]!;
    const defaultMarker =
      name === activeDefault.name ? (activeDefault.source === 'session' ? ' (default, session)' : ' (default)') : '';
    options.stdout.push(`  ${name}${defaultMarker}`);
    options.stdout.push(`    CAIP-2: ${network.caip2}`);
    options.stdout.push(
      `    gRPC:   ${network.grpc.host}:${network.grpc.port} (${network.grpc.ssl ? 'tls' : 'no-tls'})`,
    );
    options.stdout.push('');
  }

  return 0;
}

function runShow(options: RunNetworkCommandOptions, name: string): number {
  const network = getNetwork(name);
  if (!network) {
    options.stderr.push(networkCommandMessages.networkNotFound(name));
    return 1;
  }

  writeNetworkDetails(options.stdout, name, network);
  return 0;
}

async function runAdd(
  options: RunNetworkCommandOptions,
  request: Extract<NetworkCommandRequest, { kind: 'add' }>,
): Promise<number> {
  const result = addEndpointSchema.safeParse(request);
  if (!result.success) {
    options.stderr.push(result.error.issues[0].message);
    return 2;
  }
  const { name } = request;
  const normalized = result.data;

  options.stdout.push(`Connecting to ${normalized.grpcHost}:${normalized.grpcPort}...`);
  const connection = await autoDetectConnection(normalized.grpcHost, normalized.grpcPort);

  const caip2 = caip2FromGenesis(connection.genesisBlock);
  const networkConfig: NetworkConfig = {
    caip2,
    genesisHash: connection.genesisBlock,
    grpc: { host: normalized.grpcHost, port: normalized.grpcPort, ssl: connection.ssl },
  };

  addNetwork(name, networkConfig);

  options.stdout.push(`Genesis: ${connection.genesisBlock}`);
  options.stdout.push(`CAIP-2: ${caip2}`);
  options.stdout.push(`Network '${name}' added successfully (ssl: ${connection.ssl}).`);
  return 0;
}

async function runUpdate(
  options: RunNetworkCommandOptions,
  request: Extract<NetworkCommandRequest, { kind: 'update' }>,
): Promise<number> {
  const result = updateEndpointSchema.safeParse(request);
  if (!result.success) {
    options.stderr.push(result.error.issues[0].message);
    return 2;
  }
  const { name } = request;
  const normalized = result.data;

  const existing = getNetwork(name);
  if (!existing) {
    options.stderr.push(networkCommandMessages.networkNotFound(name));
    return 1;
  }

  if (normalized.grpcHost === undefined && normalized.grpcPort === undefined) {
    options.stdout.push('No changes specified. Use --grpc-host and/or --grpc-port to update.');
    return 0;
  }

  const targetHost = normalized.grpcHost ?? existing.grpc.host;
  const targetPort = normalized.grpcPort ?? existing.grpc.port;
  options.stdout.push(`Connecting to ${targetHost}:${targetPort}...`);

  const connection = await autoDetectConnection(targetHost, targetPort);

  if (connection.genesisBlock.toLowerCase() !== existing.genesisHash) {
    options.stderr.push(networkCommandMessages.genesisMismatch(existing.genesisHash, connection.genesisBlock, 'update'));
    return 1;
  }

  updateNetwork(name, { grpc: { host: targetHost, port: targetPort, ssl: connection.ssl } });

  options.stdout.push(`Genesis matches: ${connection.genesisBlock}`);
  options.stdout.push(`Network '${name}' updated successfully.`);
  return 0;
}

function runRemove(options: RunNetworkCommandOptions, name: string): number {
  removeNetwork(name);

  options.stdout.push(`Network '${name}' removed.`);
  return 0;
}

function runDefault(options: RunNetworkCommandOptions, name: string): number {
  setDefaultNetwork(name);

  options.stdout.push(`Default network set to '${name}'.`);
  return 0;
}

function runDefaultShow(options: RunNetworkCommandOptions): number {
  const registry = loadNetworks();
  options.stdout.push(`Default network: ${registry.default ?? 'mainnet'}`);
  return 0;
}

async function runDoctor(options: RunNetworkCommandOptions, requestedName: string | undefined): Promise<number> {
  let name: string;
  const registry = loadNetworks();
  try {
    name = requestedName ?? resolveNetworkFromRegistry(undefined, registry).name;
  } catch (error) {
    options.stderr.push(formatUnknownError(error));
    return 2;
  }

  const network = registry.networks[name];
  if (!network) {
    options.stderr.push(networkCommandMessages.networkNotFound(name));
    return 1;
  }

  writeNetworkDetails(options.stdout, name, network);
  options.stdout.push('', `Checking ${network.grpc.host}:${network.grpc.port}...`);

  const connection = await autoDetectConnection(network.grpc.host, network.grpc.port);

  if (connection.genesisBlock.toLowerCase() !== network.genesisHash) {
    options.stderr.push(networkCommandMessages.genesisMismatch(network.genesisHash, connection.genesisBlock, 'doctor'));
    return 1;
  }

  options.stdout.push('Network endpoint looks healthy.');
  return 0;
}

function writeNetworkDetails(stdout: string[], name: string, network: NetworkConfig): void {
  const builtIn = (BUILTIN_NETWORKS as readonly string[]).includes(name);
  stdout.push(`Network: ${name}${builtIn ? ' (built-in)' : ''}`);
  stdout.push(`CAIP-2:  ${network.caip2}`);
  stdout.push(`Genesis: ${network.genesisHash}`);
  stdout.push(`gRPC:    ${network.grpc.host}:${network.grpc.port} (${network.grpc.ssl ? 'tls' : 'no-tls'})`);
}

function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
