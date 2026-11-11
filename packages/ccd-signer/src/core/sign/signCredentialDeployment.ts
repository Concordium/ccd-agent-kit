import { createHash } from 'node:crypto';
import type { CredentialSignature } from '@concordium/web-sdk';
import { hexString, type Ed25519PublicKeyHex } from '@ccd-agent-kit/sdk-utils';
import { resolveNetwork } from '@ccd-agent-kit/config-utils';

import { getVisibleSignerInventoryEntry } from '../modules/keyVisibility.js';
import { signInventoryEntryEd25519Digest } from '../modules/signing.js';
import { parseTransaction } from '../parser/parseTransaction.js';
import type { ParsedCredentialDeploymentSigningTransaction } from '../model/parsedTransaction.js';
import {
  createNativePivYubiKeyService,
  type YubiKeyInteractionProvider,
  type YubiKeyService,
} from '@ccd-agent-kit/piv-utils';

export type CredentialDeploymentSigningErrorCode = 'invalid_input' | 'key_not_available' | 'unsupported_backend';

export class CredentialDeploymentSigningError extends Error {
  public constructor(
    public readonly code: CredentialDeploymentSigningErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CredentialDeploymentSigningError';
  }
}

export interface CredentialDeploymentSigningBackend {
  /** Signs a digest for a validated canonical Ed25519 credential public key. */
  signDigest(publicKey: Ed25519PublicKeyHex, digest: Uint8Array): Promise<string>;
}

/**
 * Credential deployment handoff and flat SDK signature maps used when signing.
 * Existing signatures must be 64-byte hex values keyed by a canonical credential key
 * index present in the handoff.
 */
export interface SignCredentialDeploymentOptions {
  /** Target-bound unsigned credential deployment handoff bytes. */
  credDeploymentHex: string;
  backend: CredentialDeploymentSigningBackend;
  signatures?: CredentialSignature;
  keys?: string[];
  maxSignatures?: number;
}

/**
 * Detached credential deployment signatures and structural threshold completion state.
 * `isFullySigned` does not cryptographically verify caller-supplied signatures.
 */
export interface SignedCredentialDeploymentResult {
  kind: 'credentialDeploymentSigning';
  target: ParsedCredentialDeploymentSigningTransaction['target'];
  digestHex: string;
  newSignatures: CredentialSignature;
  signatures: CredentialSignature;
  isFullySigned: boolean;
  signatureThreshold: number;
  missingSignatures: number;
  credentialPublicKeys: ParsedCredentialDeploymentSigningTransaction['credentialPublicKeys'];
}

/** Signs a credential-deployment signing handoff transaction. */
export async function signCredentialDeployment(
  options: SignCredentialDeploymentOptions,
): Promise<SignedCredentialDeploymentResult> {
  validateKeySelection(options);
  const parsed = parseCredentialDeploymentSigning(options.credDeploymentHex);
  const existingSignatures = { ...(options.signatures ?? {}) };
  validateCredentialSignatures(parsed, existingSignatures);
  const digest = computeCredentialDeploymentSigningDigest(parsed);
  const selectedKeys = selectCredentialSigningKeys(parsed, existingSignatures, options);
  const newSignatures: CredentialSignature = {};

  for (const keyIndex of selectedKeys) {
    const publicKey = parsed.credentialPublicKeys.keys[keyIndex]!;
    newSignatures[Number(keyIndex)] = await options.backend.signDigest(publicKey, digest);
  }
  validateCredentialSignatures(parsed, newSignatures);

  const signatures = { ...existingSignatures, ...newSignatures };
  const missingSignatures = Math.max(parsed.credentialPublicKeys.threshold - Object.keys(signatures).length, 0);
  return {
    credentialPublicKeys: parsed.credentialPublicKeys,
    digestHex: Buffer.from(digest).toString('hex'),
    isFullySigned: missingSignatures === 0,
    kind: 'credentialDeploymentSigning',
    missingSignatures,
    newSignatures,
    signatureThreshold: parsed.credentialPublicKeys.threshold,
    signatures,
    target: parsed.target,
  };
}

/** Creates a signer inventory backed credential-deployment signing backend. */
export function createManagedCredentialDeploymentSigningBackend(
  network?: string,
  yubiKeyService: YubiKeyService = createNativePivYubiKeyService(),
  yubiKeyInteraction?: Pick<YubiKeyInteractionProvider, 'promptPin'>,
): CredentialDeploymentSigningBackend {
  resolveNetwork(network);
  return {
    async signDigest(publicKey: Ed25519PublicKeyHex, digest: Uint8Array): Promise<string> {
      const keyEntry = getVisibleSignerInventoryEntry(publicKey);
      if (keyEntry === undefined) {
        throw new CredentialDeploymentSigningError('key_not_available', `Signer key ${publicKey} is not in the inventory.`);
      }
      try {
        return await signInventoryEntryEd25519Digest({ digest, entry: keyEntry, publicKey, yubiKeyInteraction, yubiKeyService });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new CredentialDeploymentSigningError('key_not_available', message);
      }
    },
  };
}

function parseCredentialDeploymentSigning(credDeploymentHex: string): ParsedCredentialDeploymentSigningTransaction {
  const parsed = parseTransaction(credDeploymentHex, { format: 'hex' });
  if (parsed.kind !== 'credentialDeploymentSigning') {
    throw new CredentialDeploymentSigningError(
      'invalid_input',
      'credDeploymentHex is not a credential deployment signing handoff.',
    );
  }
  return parsed;
}

function computeCredentialDeploymentSigningDigest(parsed: ParsedCredentialDeploymentSigningTransaction): Uint8Array {
  return createHash('sha256')
    .update(Buffer.from(parsed.unsignedCredentialDeploymentHex, 'hex'))
    .update(Buffer.from(parsed.targetContextHex, 'hex'))
    .digest();
}

function validateKeySelection(options: SignCredentialDeploymentOptions): void {
  if (options.keys !== undefined && options.maxSignatures !== undefined) {
    throw new CredentialDeploymentSigningError('invalid_input', 'Provide either keys or maxSignatures, not both.');
  }
  if (options.keys !== undefined && options.keys.length === 0) {
    throw new CredentialDeploymentSigningError('invalid_input', 'keys must contain at least one credential key index.');
  }
  if (options.maxSignatures !== undefined && (!Number.isInteger(options.maxSignatures) || options.maxSignatures < 1)) {
    throw new CredentialDeploymentSigningError('invalid_input', 'maxSignatures must be a positive integer.');
  }
}

function selectCredentialSigningKeys(
  parsed: ParsedCredentialDeploymentSigningTransaction,
  existingSignatures: CredentialSignature,
  options: SignCredentialDeploymentOptions,
): string[] {
  if (options.keys !== undefined) {
    return options.keys.map((keyIndex) => {
      if (!Object.hasOwn(parsed.credentialPublicKeys.keys, keyIndex)) {
        throw new CredentialDeploymentSigningError('invalid_input', `Credential key ${keyIndex} is not present.`);
      }
      if (existingSignatures[Number(keyIndex)] !== undefined) {
        throw new CredentialDeploymentSigningError(
          'invalid_input',
          `Requested credential key ${keyIndex} already has a signature.`,
        );
      }
      return keyIndex;
    });
  }

  const missing = Math.max(parsed.credentialPublicKeys.threshold - Object.keys(existingSignatures).length, 0);
  return Object.keys(parsed.credentialPublicKeys.keys)
    .sort(compareNumericStrings)
    .filter((keyIndex) => existingSignatures[Number(keyIndex)] === undefined)
    .slice(0, Math.min(options.maxSignatures ?? 1, missing));
}

function validateCredentialSignatures(
  parsed: ParsedCredentialDeploymentSigningTransaction,
  signatures: CredentialSignature,
): void {
  for (const [keyIndex, signature] of Object.entries(signatures)) {
    if (!Object.hasOwn(parsed.credentialPublicKeys.keys, keyIndex)) {
      throw new CredentialDeploymentSigningError('invalid_input', `Credential key ${keyIndex} is not present.`);
    }
    if (hexString.from(signature) === undefined || signature.length !== 128) {
      throw new CredentialDeploymentSigningError(
        'invalid_input',
        `Credential signature ${keyIndex} must be a 64-byte hex string.`,
      );
    }
  }
}

function compareNumericStrings(left: string, right: string): number {
  return Number(left) - Number(right);
}
