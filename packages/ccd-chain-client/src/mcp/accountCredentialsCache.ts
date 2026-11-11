import { AccountAddress, type VerifyKey } from '@concordium/web-sdk';
import {
  getAccountCredentialObservation,
  resolveNetwork,
  setAccountCredentialObservation,
  type AccountCredentialObservation,
  type ResolvedNetwork,
} from '@ccd-agent-kit/config-utils';
import { caip2Reference } from '@ccd-agent-kit/sdk-utils';
import type { AccountVerificationInfo, BlockIdentifier, ConcordiumQueryClient } from '../concordium/client.js';

type CompleteAccountCredentialObservation = AccountCredentialObservation & {
  credentials: Record<string, AccountCredentialObservation['credentials'][string] & { threshold: string }>;
};

/** Complete finalized credential observation resolved for one account. */
export interface ResolvedAccountCredentials {
  /** Canonical account address used when a refresh occurred, or the requested address for cache hits. */
  canonicalAddress: string;
  /** Finalized public credential observation. */
  observation: AccountCredentialObservation;
  /** Whether the observation came from local cache or a node refresh. */
  source: 'cache' | 'refresh';
}

/** Account verification information plus the source used to construct it. */
export interface ResolvedAccountVerificationInfo {
  /** SDK-compatible account verification information. */
  info: AccountVerificationInfo;
  /** Source of the verification information. */
  source: 'cache' | 'refresh' | 'chain';
}

/** Returns whether an observation contains thresholds required for local verification. */
export function isCompleteAccountCredentialObservation(
  observation: AccountCredentialObservation,
): observation is CompleteAccountCredentialObservation {
  return (
    parsePositiveInteger(observation.accountThreshold) !== undefined &&
    Object.values(observation.credentials).every(
      (credential) => parsePositiveInteger(credential.threshold) !== undefined,
    )
  );
}

/** Converts a finalized credential observation into SDK-compatible account verification information. */
export function accountVerificationInfoFromObservation(
  address: string,
  observation: AccountCredentialObservation,
): AccountVerificationInfo {
  if (!isCompleteAccountCredentialObservation(observation)) throw incompleteObservation(address);
  return {
    accountAddress: AccountAddress.fromBase58(address),
    accountThreshold: Number(observation.accountThreshold),
    accountCredentials: Object.fromEntries(
      Object.entries(observation.credentials).map(([credentialIndex, credential]) => {
        return [
          credentialIndex,
          {
            v: 0,
            value: {
              type: 'normal',
              contents: {
                credentialPublicKeys: {
                  threshold: Number(credential.threshold),
                  keys: Object.fromEntries<VerifyKey>(
                    Object.entries(credential.keys).map(([keyIndex, key]) => [
                      keyIndex,
                      { schemeId: key.scheme, verifyKey: key.publicKey },
                    ]),
                  ),
                },
              },
            },
          },
        ];
      }),
    ) as AccountVerificationInfo['accountCredentials'],
  };
}

/** Reads credentials in a current selector scope or an immutable resolved-network scope. */
export async function getCompleteAccountCredentials(
  client: ConcordiumQueryClient,
  network: string | ResolvedNetwork,
  address: string,
  forceRefresh = false,
): Promise<ResolvedAccountCredentials> {
  const selectedNetwork = typeof network === 'object' ? network : resolveNetwork(network);
  const caip2Ref = caip2Reference(selectedNetwork.config.caip2);
  if (!forceRefresh) {
    const cached = getAccountCredentialObservation(address, caip2Ref);
    if (cached !== undefined && isCompleteAccountCredentialObservation(cached)) {
      return { canonicalAddress: address, observation: cached, source: 'cache' };
    }
  }

  const refreshed = await client.getFinalizedAccountCredentials(address);
  if (!isCompleteAccountCredentialObservation(refreshed.observation)) {
    throw { kind: 'node', message: 'The node returned an incomplete account credential observation.' };
  }
  setAccountCredentialObservation(refreshed.canonicalAddress, refreshed.observation, caip2Ref);
  return { canonicalAddress: refreshed.canonicalAddress, observation: refreshed.observation, source: 'refresh' };
}

/** Resolves verification data in a current selector scope or immutable resolved-network scope. */
export async function getAccountVerificationInfoCacheFirst(
  client: ConcordiumQueryClient,
  network: string | ResolvedNetwork,
  address: string,
  block?: BlockIdentifier,
  forceRefresh = false,
): Promise<ResolvedAccountVerificationInfo> {
  if (!isFinalizedDefaultBlock(block)) {
    return { info: await client.getAccountVerificationInfo(address, block), source: 'chain' };
  }
  const credentials = await getCompleteAccountCredentials(client, network, address, forceRefresh);
  return {
    info: accountVerificationInfoFromObservation(credentials.canonicalAddress, credentials.observation),
    source: credentials.source,
  };
}

function isFinalizedDefaultBlock(block?: BlockIdentifier): boolean {
  return block === undefined || block.type === 'last_final';
}

function parsePositiveInteger(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function incompleteObservation(address: string): { kind: 'invalid-argument'; message: string } {
  return { kind: 'invalid-argument', message: `Incomplete account credential observation for ${address}.` };
}
