import { hkdfSync } from 'node:crypto';
import type { Network } from '@concordium/web-sdk';
import { hashToCurve, p256 } from '@noble/curves/p256';
import { validateP256PublicKey, type P256Agreement, type P256AgreementResult } from '@ccd-agent-kit/piv-utils';

/** Version-1 context-bound PIV P-256 and HKDF-SHA-256 protocol identifier. */
export const IDENTITY_ROOT_DERIVATION_VERSION = 'piv-p256-hkdf-sha256-v1';

/** Stable, sanitized root derivation failure classifications. */
export type RootDerivationErrorCode =
  | 'INVALID_CONTEXT'
  | 'INVALID_PUBLIC_KEY'
  | 'ROOT_KEY_MISMATCH'
  | 'INVALID_SHARED_SECRET'
  | 'AGREEMENT_FAILED';

const messages: Record<RootDerivationErrorCode, string> = {
  INVALID_CONTEXT: 'Identity root derivation context is invalid.',
  INVALID_PUBLIC_KEY: 'A canonical uncompressed P-256 public key is required.',
  ROOT_KEY_MISMATCH: 'The agreement public key does not match the pinned root key.',
  INVALID_SHARED_SECRET: 'The agreement must return a nonzero 32-byte secret buffer.',
  AGREEMENT_FAILED: 'Identity root agreement failed.',
};

/** Root failure with a stable classification and no retained backend diagnostics. */
export class RootDerivationError extends Error {
  /** Construct a sanitized error from its classification alone. */
  constructor(public readonly code: RootDerivationErrorCode) {
    super(messages[code]);
    this.name = 'RootDerivationError';
  }
}

/** Operation-bound agreement result; secret buffer ownership transfers to the core. */
export type IdentityRootAgreementResult = P256AgreementResult;

/** Injected device agreement boundary; providers clean up failures before transfer. */
export type IdentityRootAgreement = P256Agreement;

/** Root derivation inputs bound to an exact SDK network namespace. */
export interface IdentityRootInput {
  /** Exact SDK network namespace; registry names and genesis hashes are not accepted. */
  network: Network;
  /** IDP index, locally bounded to 0..2^31-1. */
  identityProviderIndex: number;
  /** Identity index, locally bounded to 0..2^31-1. */
  identityIndex: number;
  /** Expected canonical uncompressed P-256 root public key. */
  expectedPublicKey: Uint8Array;
  /** Agreement provider; no private hardware key enters the host core. */
  agreement: IdentityRootAgreement;
}

/** Public context which binds an identity seed to one SDK network, issuer, and identity index. */
export type IdentityRootContext = Pick<
  IdentityRootInput,
  'network' | 'identityProviderIndex' | 'identityIndex'
>;

const ROOT_MESSAGE_PREFIX = 'ccd-id-manager/identity-seed/v1';
const NETWORK_COIN_TYPE = {
  Mainnet: 919,
  Testnet: 1,
} as const satisfies Record<Network, number>;
const ROOT_DST = Buffer.from('ccd-id-manager/identity-seed/v1/P256_XMD:SHA-256_SSWU_RO_');
const HKDF_SALT = Buffer.from('ccd-id-manager/hkdf/v1');
const SDK_SEED_INFO = Buffer.from('ccd-id-manager/identity-sdk-seed/v1');

function validateContext(context: IdentityRootContext): void {
  if (
    !Object.hasOwn(NETWORK_COIN_TYPE, context.network)
    || !Number.isInteger(context.identityProviderIndex)
    || context.identityProviderIndex < 0
    || context.identityProviderIndex > 0x7fffffff
    || !Number.isInteger(context.identityIndex)
    || context.identityIndex < 0
    || context.identityIndex > 0x7fffffff
  ) {
    throw new RootDerivationError('INVALID_CONTEXT');
  }
}

/** Compute the SDK-network-bound RFC 9380 P-256 peer point as canonical uncompressed SEC1 bytes. */
export function identityRootPeerPublicKey(context: IdentityRootContext): Buffer {
  validateContext(context);
  const coinType = NETWORK_COIN_TYPE[context.network].toString(16).padStart(8, '0');
  const idpIndex = context.identityProviderIndex.toString(16).padStart(8, '0');
  const identityIndex = context.identityIndex.toString(16).padStart(8, '0');
  const message = Buffer.from(`${ROOT_MESSAGE_PREFIX}|${coinType}|${idpIndex}|${identityIndex}`, 'utf8');
  return Buffer.from(
    p256.ProjectivePoint.fromAffine(hashToCurve(message, { DST: ROOT_DST }).toAffine()).toRawBytes(false),
  );
}

/** Validate and copy a canonical uncompressed P-256 public key for root pinning and native operations. */
export function validateIdentityRootPublicKey(value: unknown): Buffer {
  try {
    return validateP256PublicKey(value);
  } catch {
    throw new RootDerivationError('INVALID_PUBLIC_KEY');
  }
}

/**
 * Derive a caller-owned 64-byte SDK seed and clear the transferred agreement secret.
 * The caller must clear the returned root; JavaScript clearing is best-effort.
 */
export async function deriveIdentityRoot(input: IdentityRootInput): Promise<Buffer> {
  validateContext(input);
  const expected = validateIdentityRootPublicKey(input.expectedPublicKey);
  const peerPublicKey = identityRootPeerPublicKey(input);
  let sharedSecret: Buffer | undefined;
  try {
    const result: IdentityRootAgreementResult = await input.agreement.agree(peerPublicKey).catch(() => {
      throw new Error();
    });
    sharedSecret = result.sharedSecret;
    if (!expected.equals(result.publicKey)) throw new RootDerivationError('ROOT_KEY_MISMATCH');
    return Buffer.from(
      hkdfSync(
        'sha256',
        sharedSecret,
        HKDF_SALT,
        SDK_SEED_INFO,
        64,
      ),
    );
  } catch (error) {
    if (error instanceof RootDerivationError) throw error;
    throw new RootDerivationError('AGREEMENT_FAILED');
  } finally {
    sharedSecret?.fill(0);
  }
}
