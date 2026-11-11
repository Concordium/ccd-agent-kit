import { AttributesKeys, ConcordiumHdWallet, type Network } from '@concordium/web-sdk';

/** Stable classifications for local guards and sanitized SDK failures. */
export type IdentityMaterialErrorCode =
  | 'INVALID_SEED'
  | 'INVALID_NETWORK'
  | 'INVALID_INDEX'
  | 'INVALID_ATTRIBUTE'
  | 'DERIVATION_FAILED';

const messages: Record<IdentityMaterialErrorCode, string> = {
  INVALID_SEED: 'Identity derivation requires a 64-byte seed.',
  INVALID_NETWORK: 'Identity derivation requires Mainnet or Testnet.',
  INVALID_INDEX: 'Identity derivation index is outside the supported bounds.',
  INVALID_ATTRIBUTE: 'Attribute must be a numeric SDK attribute tag.',
  DERIVATION_FAILED: 'Identity material derivation failed.',
};

/** Sanitized identity derivation error with no retained SDK cause or secret values. */
export class IdentityMaterialError extends Error {
  /** Construct an error using only a stable classification. */
  constructor(public readonly code: IdentityMaterialErrorCode) {
    super(messages[code]);
    this.name = 'IdentityMaterialError';
  }
}

/** Identity-only SDK derivation parameters; seed ownership stays with the caller. */
export interface IdentityMaterialInput {
  /** Exactly 64 seed bytes; never modified by derivation. */
  seed: Uint8Array;
  /** Exact SDK network name, not a registry or CAIP-2 selector. */
  network: Network;
  /** IDP index, bounded to 0..2^31-1. */
  identityProviderIndex: number;
  /** Identity index, bounded to 0..2^31-1. */
  identityIndex: number;
}

/** Caller-owned identity secret buffers; each must be cleared after use. */
export interface IdentityMaterial {
  /** Identity credential secret. */
  idCredSec: Buffer;
  /** Identity PRF key. */
  prfKey: Buffer;
  /** Identity signature blinding randomness. */
  signatureBlindingRandomness: Buffer;
}

/** Per-credential attribute opening selection, not an issued credential allowance. */
export interface AttributeRandomnessInput extends IdentityMaterialInput {
  /** Credential counter, locally bounded to 0..255. */
  credentialIndex: number;
  /** Numeric member of the current SDK attribute enum. */
  attribute: AttributesKeys;
}

/** Inputs for deriving one public credential registration identifier. */
export interface CredentialRegistrationIdInput extends IdentityMaterialInput {
  /** Credential counter, locally bounded to 0..255. */
  credentialIndex: number;
  /** Complete on-chain commitment key from the verified global context. */
  onChainCommitmentKey: string;
}

function validateIndex(value: number, maximum: number): void {
  if (!Number.isInteger(value) || value < 0 || value > maximum) {
    throw new IdentityMaterialError('INVALID_INDEX');
  }
}

function validateIdentityInput(input: IdentityMaterialInput): void {
  if (!(input.seed instanceof Uint8Array) || input.seed.length !== 64) {
    throw new IdentityMaterialError('INVALID_SEED');
  }
  if (input.network !== 'Mainnet' && input.network !== 'Testnet') {
    throw new IdentityMaterialError('INVALID_NETWORK');
  }
  validateIndex(input.identityProviderIndex, 0x7fffffff);
  validateIndex(input.identityIndex, 0x7fffffff);
}

function walletFor(input: IdentityMaterialInput): ConcordiumHdWallet {
  const seed = Buffer.from(input.seed);
  try {
    // The SDK retains a hex string; neither it nor WASM/runtime copies can be erased.
    return ConcordiumHdWallet.fromHex(seed.toString('hex'), input.network);
  } finally {
    seed.fill(0);
  }
}

function takeSdkBuffer(value: Uint8Array): Buffer {
  try {
    // SDK buffers use a Buffer polyfill; expose independent native Node buffers.
    return Buffer.from(value);
  } finally {
    value.fill(0);
  }
}

/**
 * Derive only identity secrets, never account or verifiable-credential signing keys.
 * Returned buffers belong to the caller; partial outputs are cleared on failure.
 * SDK strings and runtime copies cannot be guaranteed erased.
 */
export function deriveIdentityMaterial(input: IdentityMaterialInput): IdentityMaterial {
  validateIdentityInput(input);
  const outputs: Buffer[] = [];
  try {
    const wallet = walletFor(input);
    const { identityProviderIndex, identityIndex } = input;
    const idCredSec = takeSdkBuffer(wallet.getIdCredSec(identityProviderIndex, identityIndex));
    outputs.push(idCredSec);
    const prfKey = takeSdkBuffer(wallet.getPrfKey(identityProviderIndex, identityIndex));
    outputs.push(prfKey);
    const signatureBlindingRandomness = takeSdkBuffer(
      wallet.getSignatureBlindingRandomness(identityProviderIndex, identityIndex),
    );
    outputs.push(signatureBlindingRandomness);
    return { idCredSec, prfKey, signatureBlindingRandomness };
  } catch {
    for (const output of outputs) output.fill(0);
    throw new IdentityMaterialError('DERIVATION_FAILED');
  }
}

/**
 * Derive a caller-owned attribute commitment opening without account-key derivation.
 * The caller must clear the output; SDK strings cannot be guaranteed erased.
 */
export function deriveAttributeRandomness(input: AttributeRandomnessInput): Buffer {
  validateIdentityInput(input);
  validateIndex(input.credentialIndex, 255);
  if (typeof input.attribute !== 'number' || !Object.values(AttributesKeys).includes(input.attribute)) {
    throw new IdentityMaterialError('INVALID_ATTRIBUTE');
  }
  try {
    return takeSdkBuffer(
      walletFor(input).getAttributeCommitmentRandomness(
        input.identityProviderIndex,
        input.identityIndex,
        input.credentialIndex,
        input.attribute,
      ),
    );
  } catch {
    throw new IdentityMaterialError('DERIVATION_FAILED');
  }
}

/** Derive only the public credential registration identifier, never an account signing key. */
export function deriveCredentialRegistrationId(input: CredentialRegistrationIdInput): string {
  validateIdentityInput(input);
  validateIndex(input.credentialIndex, 255);
  try {
    return Buffer.from(walletFor(input).getCredentialId(
      input.identityProviderIndex,
      input.identityIndex,
      input.credentialIndex,
      { onChainCommitmentKey: input.onChainCommitmentKey },
    )).toString('hex');
  } catch {
    throw new IdentityMaterialError('DERIVATION_FAILED');
  }
}
