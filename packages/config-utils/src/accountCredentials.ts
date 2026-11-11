import { ed25519PublicKey, publicKeyScheme, sameAccount, type Ed25519PublicKeyHex, type PublicKeyScheme } from '@ccd-agent-kit/sdk-utils';
import { AccountAddress } from '@concordium/web-sdk';

import { isStringRecord, readJsonFile, writeJsonFile } from './jsonFile.js';
import { getAccountCredentialsPathForNetwork } from './paths.js';

/** Ed25519 public key observed for one account credential key index. */
export interface AccountCredentialPublicKey {
  /** Public key scheme. */
  scheme: PublicKeyScheme;
  /** Validated canonical 32-byte Ed25519 public key; serialized as a JSON string. */
  publicKey: Ed25519PublicKeyHex;
}

/** Public keys observed for one account credential index. */
export interface AccountCredentialEntry {
  /** Credential registration ID when observed from chain state. */
  credentialId?: string;
  /** Credential signature threshold when available. */
  threshold?: string;
  /** Account public keys keyed by credential key index. */
  keys: Record<string, AccountCredentialPublicKey>;
}

/** Finalized block that sourced an account credential observation. */
export interface AccountCredentialSourceBlock {
  /** Finalized block slot time as an ISO timestamp. */
  time: string;
  /** Finalized block hash. */
  hash: string;
  /** Finalized block height. */
  height: string;
}

/** Sanitized record of a failed account-credential refresh attempt. */
export interface AccountCredentialRefreshError {
  /** ISO timestamp when the refresh was attempted. */
  attempted: string;
  /** Stable category for the refresh failure. */
  kind: 'node' | 'not_found' | 'network' | 'unknown';
  /** Short sanitized failure message. */
  message: string;
}

/** Finalized-chain observation of one account's credential public keys. */
export interface AccountCredentialObservation {
  /** Account signature threshold when observed from chain state. */
  accountThreshold: string;
  /** Finalized source block for this observation. */
  sourceBlock: AccountCredentialSourceBlock;
  /** Credentials keyed by credential index. */
  credentials: Record<string, AccountCredentialEntry>;
  /** Most recent failed refresh attempt, when newer than the last successful observation. */
  refreshError?: AccountCredentialRefreshError;
}

/** Network-specific observations keyed by valid account addresses; stored aliases remain supported. */
export type AccountCredentialsMap = Record<string, AccountCredentialObservation>;

function isAccountCredentialPublicKey(value: unknown): value is AccountCredentialPublicKey {
  const candidate = value as Partial<AccountCredentialPublicKey> | undefined;
  if (candidate === undefined) return false;
  const publicKey = ed25519PublicKey.from(candidate.publicKey);
  const scheme = publicKeyScheme.from(candidate.scheme);
  if (publicKey === undefined || scheme === undefined) return false;
  candidate.scheme = scheme;
  candidate.publicKey = publicKey;
  return true;
}

function isAccountCredentialEntry(value: unknown): value is AccountCredentialEntry {
  const candidate = value as Partial<AccountCredentialEntry> | undefined;
  return (
    candidate !== undefined &&
    (candidate.credentialId === undefined || /^[0-9a-fA-F]{96}$/.test(candidate.credentialId)) &&
    (candidate.threshold === undefined || typeof candidate.threshold === 'string') &&
    isStringRecord(candidate.keys) &&
    Object.values(candidate.keys).every(isAccountCredentialPublicKey)
  );
}

function isCredentialIndex(value: string): boolean {
  return /^(?:0|[1-9]\d{0,2})$/.test(value) && Number(value) <= 255;
}

function isAccountAddress(value: string): boolean {
  try {
    AccountAddress.fromBase58(value);
    return true;
  } catch {
    return false;
  }
}

function isAccountCredentialObservation(value: unknown): value is AccountCredentialObservation {
  const candidate = value as Partial<AccountCredentialObservation> | undefined;
  const sourceBlock = candidate?.sourceBlock as Partial<AccountCredentialSourceBlock> | undefined;
  return (
    candidate !== undefined &&
    typeof candidate.accountThreshold === 'string' &&
    typeof sourceBlock?.time === 'string' &&
    typeof sourceBlock.hash === 'string' &&
    typeof sourceBlock.height === 'string' &&
    isStringRecord(candidate.credentials) &&
    Object.entries(candidate.credentials).every(([index, credential]) =>
      isCredentialIndex(index) && isAccountCredentialEntry(credential))
  );
}

function isAccountCredentialsMap(value: unknown): value is AccountCredentialsMap {
  return isStringRecord(value) && Object.entries(value).every(([address, observation]) =>
    isAccountAddress(address) && isAccountCredentialObservation(observation));
}

function cleanObservation(observation: AccountCredentialObservation): AccountCredentialObservation {
  const cleaned = { ...observation };
  delete cleaned.refreshError;
  return cleaned;
}

function sortAccountCredentials(credentials: AccountCredentialsMap): AccountCredentialsMap {
  return Object.fromEntries(Object.entries(credentials).sort(([left], [right]) => left.localeCompare(right)));
}

/** Loads finalized account credential observations for a network. */
export function loadAccountCredentials(caip2Ref: string): AccountCredentialsMap {
  return readJsonFile(getAccountCredentialsPathForNetwork(caip2Ref), (parsed) =>
    isAccountCredentialsMap(parsed) ? parsed : undefined,
  ) ?? {};
}

/** Saves finalized account credential observations for a network. */
export function saveAccountCredentials(credentials: AccountCredentialsMap, caip2Ref: string): void {
  if (!isAccountCredentialsMap(credentials)) throw new Error('Invalid account credential observations');
  writeJsonFile(getAccountCredentialsPathForNetwork(caip2Ref), sortAccountCredentials(credentials));
}

/** Returns one account credential observation, matching aliases when needed. */
export function getAccountCredentialObservation(address: string, caip2Ref: string): AccountCredentialObservation | undefined {
  const credentials = loadAccountCredentials(caip2Ref);
  const key = findAccountCredentialKey(credentials, address);
  return key === undefined ? undefined : credentials[key];
}

/** Stores one account credential observation under a canonical account address. */
export function setAccountCredentialObservation(
  canonicalAddress: string,
  observation: AccountCredentialObservation,
  caip2Ref: string,
): void {
  const credentials = loadAccountCredentials(caip2Ref);
  for (const storedAddress of Object.keys(credentials)) {
    if (storedAddress !== canonicalAddress && sameAccount(storedAddress, canonicalAddress)) {
      delete credentials[storedAddress];
    }
  }
  credentials[canonicalAddress] = cleanObservation(observation);
  saveAccountCredentials(credentials, caip2Ref);
}

/** Records a failed account-credential refresh for an existing cached observation. */
export function setAccountCredentialRefreshError(
  address: string,
  refreshError: AccountCredentialRefreshError,
  caip2Ref: string,
): boolean {
  const credentials = loadAccountCredentials(caip2Ref);
  const key = findAccountCredentialKey(credentials, address);
  if (key === undefined) return false;
  credentials[key] = { ...credentials[key]!, refreshError };
  saveAccountCredentials(credentials, caip2Ref);
  return true;
}

/** Removes one account credential observation, matching aliases when needed. */
export function removeAccountCredentialObservation(address: string, caip2Ref: string): boolean {
  const credentials = loadAccountCredentials(caip2Ref);
  const key = findAccountCredentialKey(credentials, address);
  if (key === undefined) return false;
  delete credentials[key];
  saveAccountCredentials(credentials, caip2Ref);
  return true;
}

function findAccountCredentialKey(credentials: AccountCredentialsMap, address: string): string | undefined {
  return credentials[address] === undefined ? Object.keys(credentials).find((stored) => sameAccount(stored, address)) : address;
}
