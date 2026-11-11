/** Supported YubiKey PIV PIN policies for generated signing keys. */
export type YubiKeyPinPolicy = 'never' | 'once' | 'always';

/** Supported YubiKey PIV touch policies for generated signing keys. */
export type YubiKeyTouchPolicy = 'never' | 'cached' | 'always';

/** PIV slots allowed for Concordium Ed25519 signing keys. */
export type YubiKeySigningSlot =
  | '9c'
  | '82'
  | '83'
  | '84'
  | '85'
  | '86'
  | '87'
  | '88'
  | '89'
  | '8a'
  | '8b'
  | '8c'
  | '8d'
  | '8e'
  | '8f'
  | '90'
  | '91'
  | '92'
  | '93'
  | '94'
  | '95';

/** Defaults used when neither CLI flags nor persisted config provide a value. */
export const BUILTIN_YUBIKEY_DEFAULTS = {
  pinPolicy: 'once' as YubiKeyPinPolicy,
  slot: '9c' as YubiKeySigningSlot,
  touchPolicy: 'never' as YubiKeyTouchPolicy,
};

/** PIV slots allowed for Concordium Ed25519 signing-key generation. */
export const ALLOWED_YUBIKEY_SIGNING_SLOTS: readonly YubiKeySigningSlot[] = [
  '9c',
  '82',
  '83',
  '84',
  '85',
  '86',
  '87',
  '88',
  '89',
  '8a',
  '8b',
  '8c',
  '8d',
  '8e',
  '8f',
  '90',
  '91',
  '92',
  '93',
  '94',
  '95',
];

/** Normalize a PIV slot name by trimming whitespace and converting it to lowercase. */
export function normalizeYubiKeySlot(slot: string): string {
  return slot.trim().toLowerCase();
}

/** Normalize a PIV slot name and return whether it is allowed for Concordium signing-key generation. */
export function isAllowedYubiKeySigningSlot(slot: string): slot is YubiKeySigningSlot {
  return (ALLOWED_YUBIKEY_SIGNING_SLOTS as readonly string[]).includes(normalizeYubiKeySlot(slot));
}

/** Normalize and parse a PIV slot allowed for Concordium signing-key use. */
export function parseAllowedYubiKeySigningSlot(slot: string): YubiKeySigningSlot | undefined {
  const normalized = normalizeYubiKeySlot(slot);
  return (ALLOWED_YUBIKEY_SIGNING_SLOTS as readonly string[]).includes(normalized) ? normalized as YubiKeySigningSlot : undefined;
}

/** Validates a PIV slot against the Concordium signing-key slot policy. */
export function assertAllowedYubiKeySigningSlot(slot: string): YubiKeySigningSlot {
  const normalized = parseAllowedYubiKeySigningSlot(slot);
  if (normalized === undefined) {
    throw new Error('Slot must be 9c or one of 82-95.');
  }
  return normalized;
}

/** Validates a PIN policy value. */
export function assertYubiKeyPinPolicy(policy: string): YubiKeyPinPolicy {
  if (policy === 'never' || policy === 'once' || policy === 'always') {
    return policy;
  }
  throw new Error('PIN policy must be never, once, or always.');
}

/** Validates a touch policy value. */
export function assertYubiKeyTouchPolicy(policy: string): YubiKeyTouchPolicy {
  if (policy === 'never' || policy === 'cached' || policy === 'always') {
    return policy;
  }
  throw new Error('Touch policy must be never, cached, or always.');
}
