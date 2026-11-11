import {
  getAccountCredentialObservation,
  resolveNetwork,
  setAccountCredentialObservation,
  type AccountCredentialObservation,
} from '@ccd-agent-kit/config-utils';
import { hexStringSchema, roleSeparatedSignaturesSchema } from '@ccd-agent-kit/mcp-utils';
import {
  countSignatureEntries,
  caip2Reference,
  parseUnsignedAccountTransactionHex,
  verifyAccountTransactionSignatureSlot,
  type NormalizedRoleSeparatedSignatureMaps,
  type ParsedUnsignedAccountTransaction,
} from '@ccd-agent-kit/sdk-utils';
import type { AccountTransactionSignature } from '@concordium/web-sdk';
import { z } from 'zod';
import { isCompleteAccountCredentialObservation } from '../../accountCredentialsCache.js';
import { networkNameSchema } from '../../toolPlumbing/toolSchemas.js';
import type { ToolContext } from '../../toolPlumbing/toolTypes.js';

export const combineTransactionSignaturesArgsSchema = z.object({
  transactionHex: hexStringSchema.describe('Expected unsigned account transaction hex emitted by a builder.'),
  signatureSets: z
    .array(roleSeparatedSignaturesSchema)
    .min(1)
    .describe('Role-separated detached signature sets to merge and verify.'),
  network: networkNameSchema,
});
export type CombineTransactionSignaturesArgs = z.infer<typeof combineTransactionSignaturesArgsSchema>;

export type BadSignatureReason =
  'malformed-signature' | 'unknown-credential' | 'unknown-key' | 'invalid-signature' | 'unexpected-sponsor-signature';

export interface BadSignaturesEntry {
  reason: BadSignatureReason;
  sender?: Record<string, Record<string, string[]>>;
  sponsor?: Record<string, Record<string, string[]>>;
}

export interface CombineTransactionSignaturesResult {
  network: string;
  transactionVersion: 'v0' | 'v1';
  sender: string;
  sponsor?: string;
  signatures: NormalizedRoleSeparatedSignatureMaps;
  badSignatures: BadSignaturesEntry[];
  hasRejectedSignatures: boolean;
  acceptedSignatureCount: number;
  rejectedSignatureCount: number;
  missingSignatures: { sender: number; sponsor: number };
  isFullySigned: boolean;
}

/** Verifies candidate signatures and returns independently owned accepted maps without mutating input sets. */
export async function combineTransactionSignatures(
  ctx: ToolContext,
  args: CombineTransactionSignaturesArgs,
): Promise<CombineTransactionSignaturesResult> {
  let unsigned: ParsedUnsignedAccountTransaction;
  try {
    unsigned = parseUnsignedAccountTransactionHex(args.transactionHex);
  } catch {
    throw { kind: 'invalid-argument', message: 'transactionHex is not a valid unsigned account transaction.' };
  }
  return combineParsedTransactionSignatures(ctx, unsigned, args.signatureSets, args.network);
}

/** Verifies candidate signatures for producer-parsed unsigned transaction bytes. */
export async function combineParsedTransactionSignatures(
  ctx: ToolContext,
  unsigned: ParsedUnsignedAccountTransaction,
  signatureSets: NormalizedRoleSeparatedSignatureMaps[],
  network: string | undefined,
): Promise<CombineTransactionSignaturesResult> {
  const { client, networkName } = ctx.clients.getClient(network);
  const caip2Ref = caip2Reference(resolveNetwork(networkName).config.caip2);
  const accountCache = new Map<string, AccountCredentialObservation>();
  const refreshedAccounts = new Set<string>();
  const badCollector = new BadSignatureCollector();
  const candidates = collectSignatureCandidates(signatureSets);
  const accepted: NormalizedRoleSeparatedSignatureMaps = { sender: {}, sponsor: {} };

  const resolveObservation = async (address: string, forceRefresh = false): Promise<AccountCredentialObservation> => {
    if (!forceRefresh) {
      const memoized = accountCache.get(address);
      if (memoized !== undefined) return memoized;
      const cached = getAccountCredentialObservation(address, caip2Ref);
      if (cached !== undefined && isCompleteAccountCredentialObservation(cached)) {
        accountCache.set(address, cached);
        return cached;
      }
    }

    if (forceRefresh || !refreshedAccounts.has(address)) {
      const refreshed = await client.getFinalizedAccountCredentials(address);
      setAccountCredentialObservation(refreshed.canonicalAddress, refreshed.observation, caip2Ref);
      accountCache.set(address, refreshed.observation);
      refreshedAccounts.add(address);
      return refreshed.observation;
    }

    const cached = accountCache.get(address);
    if (cached !== undefined) return cached;
    throw { kind: 'invalid-argument', message: `No complete account credential observation for ${address}.` };
  };

  const verifyCandidate = async (
    role: 'sender' | 'sponsor',
    credentialIndex: string,
    keyIndex: string,
    signature: string,
  ): Promise<BadSignatureReason | undefined> => {
    const address = role === 'sender' ? unsigned.sender : unsigned.version === 1 ? unsigned.sponsor : undefined;
    if (address === undefined) return 'unexpected-sponsor-signature';
    if (!isSignatureHex(signature)) return 'malformed-signature';

    let observation = await resolveObservation(address);
    let reason = await verifyAgainstObservation(unsigned, observation, credentialIndex, keyIndex, signature);
    if (reason !== undefined && !refreshedAccounts.has(address)) {
      observation = await resolveObservation(address, true);
      reason = await verifyAgainstObservation(unsigned, observation, credentialIndex, keyIndex, signature);
    }
    return reason;
  };

  for (const role of ['sender', 'sponsor'] as const) {
    for (const [credentialIndex, keyCandidates] of Object.entries(candidates[role])) {
      for (const [keyIndex, signatures] of Object.entries(keyCandidates)) {
        const validSignatures: string[] = [];
        for (const signature of signatures) {
          const reason = await verifyCandidate(role, credentialIndex, keyIndex, signature);
          if (reason === undefined) validSignatures.push(signature);
          else badCollector.add(reason, role, credentialIndex, keyIndex, signature);
        }

        const distinctValid = [...new Set(validSignatures)];
        if (distinctValid.length > 1) {
          throw {
            kind: 'invalid-argument',
            message: `Multiple different signatures validated for ${role} credential ${credentialIndex} key ${keyIndex}.`,
          };
        }
        if (distinctValid[0] !== undefined) addSignature(accepted[role], credentialIndex, keyIndex, distinctValid[0]);
      }
    }
  }

  const senderObservation = await resolveObservation(unsigned.sender);
  const sponsorObservation =
    unsigned.version === 1 && unsigned.sponsor !== undefined ? await resolveObservation(unsigned.sponsor) : undefined;
  const missingSignatures = {
    sender: computeMissingSignatures(senderObservation, accepted.sender),
    sponsor: sponsorObservation === undefined ? 0 : computeMissingSignatures(sponsorObservation, accepted.sponsor),
  };
  const badSignatures = badCollector.entries();

  return {
    network: networkName,
    transactionVersion: unsigned.version === 0 ? 'v0' : 'v1',
    sender: unsigned.sender,
    ...(unsigned.version === 1 && unsigned.sponsor !== undefined ? { sponsor: unsigned.sponsor } : {}),
    signatures: accepted,
    badSignatures,
    hasRejectedSignatures: badCollector.count > 0,
    acceptedSignatureCount: countSignatureEntries(accepted.sender) + countSignatureEntries(accepted.sponsor),
    rejectedSignatureCount: badCollector.count,
    missingSignatures,
    isFullySigned: missingSignatures.sender === 0 && missingSignatures.sponsor === 0,
  };
}

function collectSignatureCandidates(signatureSets: NormalizedRoleSeparatedSignatureMaps[]): {
  sender: Record<string, Record<string, string[]>>;
  sponsor: Record<string, Record<string, string[]>>;
} {
  const candidates = { sender: {}, sponsor: {} } as {
    sender: Record<string, Record<string, string[]>>;
    sponsor: Record<string, Record<string, string[]>>;
  };
  for (const signatureSet of signatureSets) {
    collectRoleCandidates(candidates.sender, signatureSet.sender);
    collectRoleCandidates(candidates.sponsor, signatureSet.sponsor);
  }
  return candidates;
}

function collectRoleCandidates(
  target: Record<string, Record<string, string[]>>,
  signatures: AccountTransactionSignature,
): void {
  for (const [credentialIndex, keys] of Object.entries(signatures)) {
    const targetCredential = (target[credentialIndex] ??= {});
    for (const [keyIndex, signature] of Object.entries(keys)) {
      const targetSignatures = (targetCredential[keyIndex] ??= []);
      const normalized = signature.toLowerCase();
      if (!targetSignatures.includes(normalized)) targetSignatures.push(normalized);
    }
  }
}

function addSignature(
  target: AccountTransactionSignature,
  credentialIndex: string,
  keyIndex: string,
  signature: string,
): void {
  (target[Number(credentialIndex)] ??= {})[Number(keyIndex)] = signature;
}

async function verifyAgainstObservation(
  unsigned: ParsedUnsignedAccountTransaction,
  observation: AccountCredentialObservation,
  credentialIndex: string,
  keyIndex: string,
  signature: string,
): Promise<BadSignatureReason | undefined> {
  const credential = observation.credentials[credentialIndex];
  if (credential === undefined) return 'unknown-credential';
  const key = credential.keys[keyIndex];
  if (key === undefined) return 'unknown-key';
  return (await verifyAccountTransactionSignatureSlot({ publicKey: key.publicKey, signature, unsigned }))
    ? undefined
    : 'invalid-signature';
}

function computeMissingSignatures(
  observation: AccountCredentialObservation,
  signatures: AccountTransactionSignature,
): number {
  const accountThreshold = parsePositiveInteger(observation.accountThreshold) ?? 1;
  const deficits = Object.entries(observation.credentials).map(([credentialIndex, credential]) => {
    const threshold = parsePositiveInteger(credential.threshold) ?? 1;
    const validCount = Object.keys(signatures[Number(credentialIndex)] ?? {}).length;
    return Math.max(threshold - validCount, 0);
  });
  const completeCredentialCount = deficits.filter((deficit) => deficit === 0).length;
  const missingCredentialCount = Math.max(accountThreshold - completeCredentialCount, 0);
  if (missingCredentialCount === 0) return 0;
  return deficits
    .filter((deficit) => deficit > 0)
    .sort((left, right) => left - right)
    .slice(0, missingCredentialCount)
    .reduce((sum, deficit) => sum + deficit, 0);
}

function parsePositiveInteger(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function isSignatureHex(signature: string): boolean {
  return /^[0-9a-f]{128}$/.test(signature);
}

class BadSignatureCollector {
  public count = 0;
  private readonly byReason = new Map<
    BadSignatureReason,
    { sender?: Record<string, Record<string, string[]>>; sponsor?: Record<string, Record<string, string[]>> }
  >();

  public add(
    reason: BadSignatureReason,
    role: 'sender' | 'sponsor',
    credentialIndex: string,
    keyIndex: string,
    signature: string,
  ): void {
    const entry = this.byReason.get(reason) ?? {};
    const roleMap = (entry[role] ??= {});
    const credentialMap = (roleMap[credentialIndex] ??= {});
    const signatures = (credentialMap[keyIndex] ??= []);
    if (!signatures.includes(signature)) {
      signatures.push(signature);
      this.count += 1;
    }
    this.byReason.set(reason, entry);
  }

  public entries(): BadSignaturesEntry[] {
    return [...this.byReason.entries()].map(([reason, entry]) => ({ reason, ...entry }));
  }
}
