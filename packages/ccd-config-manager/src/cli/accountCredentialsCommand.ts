import {
  getActiveNetwork,
  getAccountCredentialObservation,
  getNetwork,
  loadAccountCredentials,
  removeAccountCredentialObservation,
  setAccountCredentialObservation,
  setAccountCredentialRefreshError,
  type AccountCredentialObservation,
  type AccountCredentialRefreshError,
  type NetworkConfig,
} from '@ccd-agent-kit/config-utils';
import { z } from 'zod';
import { caip2Reference, queryFinalizedAccountCredentials, type AccountCredentialsQueryResult } from '../core/grpc.js';

const refreshErrorMetadataSchema = z.object({
  kind: z.unknown().optional(),
  message: z.unknown().optional(),
});

export interface RunAccountCredentialsCommandOptions {
  request: AccountCredentialsCommandRequest;
  stdout: string[];
  stderr: string[];
  queryAccountCredentials?: (network: NetworkConfig, address: string) => Promise<AccountCredentialsQueryResult>;
}

/** Operational request for finalized account-credential cache operations after Commander parsing. */
export type AccountCredentialsCommandRequest =
  | { kind: 'refresh'; address: string; network?: string }
  | { kind: 'show'; address: string; network?: string }
  | { kind: 'list'; network?: string }
  | { kind: 'remove'; address: string; network?: string };

const accountCredentialsCommandMessages = {
  accountCredentialsHeader: (network: string) => `Account credentials for ${network}:`,
  credentialsCount: (count: number) => `Credentials: ${count}`,
  networkNotFound: (network: string) => `Network '${network}' not found.`,
  notCached: (network: string, address?: string) =>
    address === undefined ? `No account credentials cached for ${network}.` : `No account credentials cached for ${address} on ${network}.`,
  refreshed: (network: string) => `Refreshed account credentials for ${network}.`,
  removed: (address: string, network: string) => `Removed account credentials for ${address} on ${network}.`,
  sourceBlock: (height: string | number, hash: string) => `Source block: ${height} ${hash}`,
} as const;

/** Runs the human-facing finalized account-credential cache command. */
export async function runAccountCredentialsCommand(options: RunAccountCredentialsCommandOptions): Promise<number> {
  const { request } = options;
  switch (request.kind) {
    case 'refresh':
      return runRefresh(options, request);
    case 'show':
      return runShow(options, request);
    case 'list':
      return runList(options, request);
    case 'remove':
      return runRemove(options, request);
  }
}

async function runRefresh(options: RunAccountCredentialsCommandOptions, request: Extract<AccountCredentialsCommandRequest, { kind: 'refresh' }>): Promise<number> {
  let parsed: { address: string; networkName: string; network: NetworkConfig; caip2Ref: string };
  try {
    parsed = parseAddressCommand(request);
  } catch (error) {
    options.stderr.push(errorMessage(error));
    return 2;
  }

  try {
    const query = options.queryAccountCredentials ?? defaultQueryAccountCredentials;
    const result = await query(parsed.network, parsed.address);
    setAccountCredentialObservation(result.canonicalAddress, result.observation, parsed.caip2Ref);
    options.stdout.push(
      accountCredentialsCommandMessages.refreshed(parsed.networkName),
      `Address: ${result.canonicalAddress}`,
      accountCredentialsCommandMessages.sourceBlock(result.observation.sourceBlock.height, result.observation.sourceBlock.hash),
      accountCredentialsCommandMessages.credentialsCount(Object.keys(result.observation.credentials).length),
    );
    return 0;
  } catch (error) {
    const refreshError = refreshErrorFromUnknown(error);
    setAccountCredentialRefreshError(parsed.address, refreshError, parsed.caip2Ref);
    options.stderr.push(refreshError.message);
    return 1;
  }
}

function runShow(options: RunAccountCredentialsCommandOptions, request: Extract<AccountCredentialsCommandRequest, { kind: 'show' }>): number {
  let parsed: { address: string; networkName: string; caip2Ref: string };
  try {
    parsed = parseAddressCommand(request);
  } catch (error) {
    options.stderr.push(errorMessage(error));
    return 2;
  }

  const observation = getAccountCredentialObservation(parsed.address, parsed.caip2Ref);
  if (observation === undefined) {
    options.stderr.push(accountCredentialsCommandMessages.notCached(parsed.networkName, parsed.address));
    return 1;
  }
  writeObservation(options.stdout, parsed.networkName, parsed.address, observation);
  return 0;
}

function runList(options: RunAccountCredentialsCommandOptions, request: Extract<AccountCredentialsCommandRequest, { kind: 'list' }>): number {
  let networkName: string;
  let caip2Ref: string;
  try {
    const scope = parseNetworkScope(request);
    networkName = scope.networkName;
    caip2Ref = scope.caip2Ref;
  } catch (error) {
    options.stderr.push(errorMessage(error));
    return 2;
  }
  const entries = Object.entries(loadAccountCredentials(caip2Ref));
  options.stdout.push(accountCredentialsCommandMessages.accountCredentialsHeader(networkName));
  if (entries.length === 0) {
    options.stdout.push(accountCredentialsCommandMessages.notCached(networkName));
    return 0;
  }
  for (const [address, observation] of entries) {
    options.stdout.push(
      `  ${address} credentials=${Object.keys(observation.credentials).length}${observation.refreshError ? ' refresh=failed' : ''}`,
    );
  }
  return 0;
}

function runRemove(options: RunAccountCredentialsCommandOptions, request: Extract<AccountCredentialsCommandRequest, { kind: 'remove' }>): number {
  let parsed: { address: string; networkName: string; caip2Ref: string };
  try {
    parsed = parseAddressCommand(request);
  } catch (error) {
    options.stderr.push(errorMessage(error));
    return 2;
  }
  if (!removeAccountCredentialObservation(parsed.address, parsed.caip2Ref)) {
    options.stderr.push(accountCredentialsCommandMessages.notCached(parsed.networkName, parsed.address));
    return 1;
  }
  options.stdout.push(accountCredentialsCommandMessages.removed(parsed.address, parsed.networkName));
  return 0;
}

function parseAddressCommand(request: { address: string; network?: string }) {
  return { address: request.address, ...parseNetworkScope(request) };
}

function parseNetworkScope(request: { network?: string }): { networkName: string; network: NetworkConfig; caip2Ref: string } {
  const networkName = request.network ?? getActiveNetwork().name;
  const network = getNetwork(networkName);
  if (!network) throw new Error(accountCredentialsCommandMessages.networkNotFound(networkName));
  return { caip2Ref: caip2Reference(network.caip2), network, networkName };
}

async function defaultQueryAccountCredentials(
  network: NetworkConfig,
  address: string,
): Promise<AccountCredentialsQueryResult> {
  return queryFinalizedAccountCredentials(network.grpc, address);
}

function writeObservation(
  stdout: string[],
  networkName: string,
  address: string,
  observation: AccountCredentialObservation,
): void {
  stdout.push(accountCredentialsCommandMessages.accountCredentialsHeader(networkName), `Address: ${address}`);
  for (const [credentialIndex, credential] of Object.entries(observation.credentials)) {
    stdout.push(`Credential ${credentialIndex}${credential.threshold ? ` threshold ${credential.threshold}` : ''}:`);
    for (const [keyIndex, key] of Object.entries(credential.keys)) {
      stdout.push(`  Key ${keyIndex}: ${key.scheme} ${key.publicKey}`);
    }
  }
  if (observation.refreshError !== undefined) {
    const error = observation.refreshError;
    stdout.push(`Refresh error: ${error.attempted} ${error.kind}: ${error.message}`);
  }
}

function refreshErrorFromUnknown(error: unknown): AccountCredentialRefreshError {
  const parsed = refreshErrorMetadataSchema.safeParse(error);
  const candidate = parsed.success ? parsed.data : undefined;
  const kind =
    candidate?.kind === 'node' || candidate?.kind === 'not_found' || candidate?.kind === 'network'
      ? candidate.kind
      : 'unknown';
  return {
    attempted: new Date().toISOString(),
    kind,
    message: typeof candidate?.message === 'string' ? candidate.message : String(error),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
