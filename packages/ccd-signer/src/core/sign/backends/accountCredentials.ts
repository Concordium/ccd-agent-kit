import type { AccountTransactionSignature } from '@concordium/web-sdk';
import type { AccountCredentialObservation } from '@ccd-agent-kit/config-utils';
import type { Ed25519PublicKeyHex } from '@ccd-agent-kit/sdk-utils';

import { getVisibleSignerInventoryEntry, listVisibleSignerInventoryKeys, type VisibleSignerInventoryKey } from '../../modules/keyVisibility.js';
import { signInventoryEntryEd25519Digest } from '../../modules/signing.js';
import {
  createNativePivYubiKeyService,
  type YubiKeyInteractionProvider,
  type YubiKeyService,
} from '@ccd-agent-kit/piv-utils';
import type { TransactionSigningBackend, TransactionSigningRequest } from '../transactionSigningBackend.js';

interface ObservedSigningKey {
  credentialIndex: string;
  keyIndex: string;
  publicKey: Ed25519PublicKeyHex;
}

/** Signs account transactions by matching chain-observed credential keys to local signer inventory keys. */
export class AccountCredentialsSigningBackend implements TransactionSigningBackend {
  private readonly signingKeys: ObservedSigningKey[];

  public constructor(
    observation: AccountCredentialObservation,
    private readonly yubiKeyService: YubiKeyService = createNativePivYubiKeyService(),
    private readonly yubiKeyInteraction?: Pick<YubiKeyInteractionProvider, 'promptPin'>,
  ) {
    this.signingKeys = extractObservedSigningKeys(observation);
  }

  public async createSignature(request: TransactionSigningRequest): Promise<AccountTransactionSignature> {
    if (request.missingSignatures === 0 && request.keys === undefined) return {};

    const keys = selectSigningKeys(this.signingKeys, request, visibleKeysByPublicKey());
    const signature: AccountTransactionSignature = {};
    for (const key of keys) {
      const signatureHex = await this.signKey(key, request.digest);
      const credentialIndex = Number(key.credentialIndex);
      signature[credentialIndex] ??= {};
      signature[credentialIndex]![Number(key.keyIndex)] = signatureHex;
    }

    if (keys.length === 0) {
      throw new Error('No available signing keys remain for this account.');
    }

    return signature;
  }

  private async signKey(key: ObservedSigningKey, digest: Uint8Array): Promise<string> {
    const entry = getVisibleSignerInventoryEntry(key.publicKey);
    if (entry === undefined) {
      throw new Error(`Observed account key ${key.publicKey} is not available in the signer inventory.`);
    }
    return signInventoryEntryEd25519Digest({
      digest,
      entry,
      publicKey: key.publicKey,
      yubiKeyInteraction: this.yubiKeyInteraction,
      yubiKeyService: this.yubiKeyService,
    });
  }
}

/** Returns whether any observed account credential key is present in the signer inventory. */
export function hasAvailableObservedCredentialKey(observation: AccountCredentialObservation): boolean {
  const visibleKeys = visibleKeysByPublicKey();
  return extractObservedSigningKeys(observation).some((key) => visibleKeys.has(key.publicKey));
}

function extractObservedSigningKeys(observation: AccountCredentialObservation): ObservedSigningKey[] {
  return Object.entries(observation.credentials).flatMap(([credentialIndex, credential]) =>
    Object.entries(credential.keys).map(([keyIndex, key]) => ({ credentialIndex, keyIndex, publicKey: key.publicKey })),
  );
}

function selectSigningKeys(
  keys: ObservedSigningKey[],
  request: TransactionSigningRequest,
  visibleKeys: ReadonlyMap<Ed25519PublicKeyHex, VisibleSignerInventoryKey>,
): ObservedSigningKey[] {
  const availableKeys = keys.filter((key) => visibleKeys.has(key.publicKey));
  if (request.keys !== undefined) {
    return request.keys.map((requestedKey) => findRequestedSigningKey(availableKeys, request, requestedKey));
  }

  const limit = Math.min(request.maxSignatures ?? 1, request.missingSignatures);
  return availableKeys
    .filter((key) => request.existingSignatures[Number(key.credentialIndex)]?.[Number(key.keyIndex)] === undefined)
    .slice(0, limit);
}

function findRequestedSigningKey(
  keys: ObservedSigningKey[],
  request: TransactionSigningRequest,
  requestedKey: string,
): ObservedSigningKey {
  const [credentialIndex, keyIndex, extra] = requestedKey.split(':');
  if (!credentialIndex || !keyIndex || extra !== undefined) {
    throw new Error(`Requested signing key ${requestedKey} is not a valid credential/key pair.`);
  }
  if (request.existingSignatures[Number(credentialIndex)]?.[Number(keyIndex)] !== undefined) {
    throw new Error(`Requested signing key ${requestedKey} already has a signature.`);
  }
  const key = keys.find((candidate) => candidate.credentialIndex === credentialIndex && candidate.keyIndex === keyIndex);
  if (key === undefined) {
    throw new Error(`Requested signing key ${requestedKey} is not available for this account.`);
  }
  return key;
}

function visibleKeysByPublicKey(): Map<Ed25519PublicKeyHex, VisibleSignerInventoryKey> {
  return new Map(listVisibleSignerInventoryKeys().map((key) => [key.publicKey, key]));
}
