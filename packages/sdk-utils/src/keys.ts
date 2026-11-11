const ED25519_KEY_BYTES = 32;

/** Canonical lower-case hex string with an even number of nibbles. */
export type HexString = string & { readonly __brandHexString: 'HexString' };

/** Canonical hex-encoded 32-byte Ed25519 public verification key. */
export type Ed25519PublicKeyHex = HexString & { readonly __brandEd25519PublicKeyHex: 'Ed25519PublicKeyHex' };

/** Canonical hex-encoded 32-byte Ed25519 private signing key. */
export type Ed25519PrivateKeyHex = HexString & {
  readonly __brandEd25519PrivateKeyHex: 'Ed25519PrivateKeyHex';
};

interface HexStringParseOptions {
  /** Allow the empty string as valid zero-length hex. Defaults to false. */
  allowEmpty?: boolean;
}

/** Parser for canonical lower-case hex strings. */
export const hexString = {
  from(value: unknown, options: HexStringParseOptions = {}): HexString | undefined {
    if (typeof value !== 'string') return undefined;
    const normalized = value.trim().toLowerCase();
    if (!options.allowEmpty && normalized.length === 0) return undefined;
    if (normalized.length % 2 !== 0) return undefined;
    if (!/^[0-9a-f]*$/.test(normalized)) return undefined;
    return normalized as HexString;
  },
  require(value: unknown, options: HexStringParseOptions = {}): HexString {
    const parsed = hexString.from(value, options);
    if (parsed === undefined) throw new Error(`Invalid hex string: ${String(value)}`);
    return parsed;
  },
} as const;

/** Parser for canonical hex-encoded Ed25519 public keys. */
export const ed25519PublicKey = {
  from(value: unknown): Ed25519PublicKeyHex | undefined {
    return parseFixedLengthHex(value, ED25519_KEY_BYTES) as Ed25519PublicKeyHex | undefined;
  },
  require(value: unknown): Ed25519PublicKeyHex {
    const parsed = ed25519PublicKey.from(value);
    if (parsed === undefined) throw new Error('Invalid Ed25519 public key hex.');
    return parsed;
  },
} as const;

/** Parser for canonical hex-encoded 32-byte Ed25519 private signing keys. */
export const ed25519PrivateKey = {
  from(value: unknown): Ed25519PrivateKeyHex | undefined {
    return parseFixedLengthHex(value, ED25519_KEY_BYTES) as Ed25519PrivateKeyHex | undefined;
  },
  require(value: unknown): Ed25519PrivateKeyHex {
    const parsed = ed25519PrivateKey.from(value);
    if (parsed === undefined) throw new Error('Invalid Ed25519 private key hex.');
    return parsed;
  },
} as const;

function parseFixedLengthHex(value: unknown, byteLength: number): HexString | undefined {
  const parsed = hexString.from(value);
  return parsed !== undefined && parsed.length === byteLength * 2 ? parsed : undefined;
}

/** Canonical public key schemes recognized by CCD tools. */
export const keySchemes = { Ed25519: 'Ed25519' } as const;

/** Canonical public key scheme names recognized by CCD tools. */
export type PublicKeyScheme = (typeof keySchemes)[keyof typeof keySchemes];

const publicKeySchemeAliases = new Map<string, PublicKeyScheme>([['ed25519', keySchemes.Ed25519]]);

/** Parser for public key scheme names that canonicalizes supported aliases. */
export const publicKeyScheme = {
  from(value: unknown): PublicKeyScheme | undefined {
    if (typeof value !== 'string') return undefined;
    return publicKeySchemeAliases.get(value.trim().toLowerCase());
  },
  require(value: unknown): PublicKeyScheme {
    const parsed = publicKeyScheme.from(value);
    if (parsed === undefined) throw new Error(`Unsupported public key scheme: ${String(value)}`);
    return parsed;
  },
  values(): PublicKeyScheme[] {
    return Object.values(keySchemes);
  },
} as const;
