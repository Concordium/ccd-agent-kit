import type { AccountCredential, AccountInfo } from '@concordium/web-sdk';
import { ed25519PublicKey, keySchemes, publicKeyScheme, type Ed25519PublicKeyHex } from './keys.js';

/** Public credential data, independent of persistence and resource presentation formats. */
export interface AccountCredentialPublicData {
  credentialId: string;
  threshold: string;
  keys: Record<string, { publicKey: Ed25519PublicKeyHex; scheme: typeof keySchemes.Ed25519 }>;
}

/** The SDK names initial credential IDs `regId` and normal credential IDs `credId`. */
export function credentialIdOf(credential: AccountCredential): string {
  const { value } = credential;
  return value.type === 'initial' ? value.contents.regId : value.contents.credId;
}

/** Read the required SDK signing threshold independently of public-key filtering. */
export function credentialSigningThreshold(credential: AccountCredential): number {
  return credential.value.contents.credentialPublicKeys.threshold;
}

/** Normalize SDK public keys, skipping unknown schemes (including SDK `null` entries) and malformed keys. */
export function credentialPublicData(credential: AccountCredential): AccountCredentialPublicData {
  const publicKeys = credential.value.contents.credentialPublicKeys;
  const keys: AccountCredentialPublicData['keys'] = {};
  for (const [index, key] of Object.entries(publicKeys.keys)) {
    if (key === null) continue;
    const publicKey = ed25519PublicKey.from(key.verifyKey);
    if (publicKeyScheme.from(key.schemeId) === keySchemes.Ed25519 && publicKey !== undefined) {
      keys[index] = { publicKey, scheme: keySchemes.Ed25519 };
    }
  }
  return { keys, credentialId: credentialIdOf(credential), threshold: publicKeys.threshold.toString() };
}

/** Extract public observations from SDK account info; callers choose their own JSON/persistence presentation. */
export function extractAccountCredentials(
  raw: Pick<AccountInfo, 'accountCredentials'>,
): Record<string, AccountCredentialPublicData> {
  return Object.fromEntries(
    Object.entries(raw.accountCredentials).map(([index, credential]) => [index, credentialPublicData(credential)]),
  );
}
