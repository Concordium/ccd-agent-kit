import type { PivPinStatus } from './types.js';
import {
  type YubiKeyPinPolicy,
  type YubiKeySigningSlot,
  type YubiKeyTouchPolicy,
  assertAllowedYubiKeySigningSlot,
  assertYubiKeyPinPolicy,
  assertYubiKeyTouchPolicy,
} from './yubikeyPolicy.js';

/** Canonical lowercase 32-byte Ed25519 public key encoded as hexadecimal. */
export type Ed25519PublicKeyHex = string & {
  readonly __brandHexString: 'HexString';
  readonly __brandEd25519PublicKeyHex: 'Ed25519PublicKeyHex';
};

/** Canonical lowercase 32-byte Ed25519 private key encoded as hexadecimal. */
export type Ed25519PrivateKeyHex = string & {
  readonly __brandHexString: 'HexString';
  readonly __brandEd25519PrivateKeyHex: 'Ed25519PrivateKeyHex';
};

/** Connected YubiKey summary. */
export interface YubiKeyDeviceSummary {
  /** Human-readable PC/SC reader name reported by the operating system. */
  readerName: string;
  /** Human-readable YubiKey model when available. */
  model?: string;
  /** Human-readable YubiKey form factor when available. */
  formFactor?: string;
  /** Decimal YubiKey serial number when available. */
  serial?: string;
  /** Firmware version when available. */
  firmwareVersion?: string;
}

/** PIV slot status for a connected YubiKey. */
export interface YubiKeySlotInspection {
  /** PIV slot, e.g. `9c` or `82`. */
  slot: YubiKeySigningSlot;
  /** Whether the slot contains a key. */
  status: 'empty' | 'occupied' | 'unknown';
  /** Stored key algorithm when available. */
  algorithm?: string;
  /** Validated canonical Ed25519 public key when the slot exposes one. */
  publicKey?: Ed25519PublicKeyHex;
  /** PIN policy when available. */
  pinPolicy?: YubiKeyPinPolicy;
  /** Touch policy when available. */
  touchPolicy?: YubiKeyTouchPolicy;
  /** Origin when available. */
  origin?: 'generated' | 'imported' | 'unknown';
}

/** Detailed YubiKey PIV inspection. */
export interface YubiKeyInspection {
  /** Human-readable PC/SC reader name reported by the operating system. */
  readerName: string;
  /** Human-readable YubiKey model when available. */
  model?: string;
  /** Human-readable YubiKey form factor when available. */
  formFactor?: string;
  /** Decimal YubiKey serial number when available. */
  serial?: string;
  /** Firmware version when available. */
  firmwareVersion?: string;
  /** Whether Ed25519 generation is supported. */
  ed25519Supported: boolean;
  /** Whether touch policy support is known. */
  touchPolicySupported: 'supported' | 'unsupported' | 'unknown';
  /** Fresh device-wide PIV PIN security status. */
  pinStatus: PivPinStatus;
  /** Inspected PIV slots. */
  slots: YubiKeySlotInspection[];
}

/** Result of listing connected PIV devices and inspecting selected YubiKey serials in one discovery pass. */
export interface YubiKeyDeviceInspectionResult {
  /** All connected PIV device summaries, including devices without a readable serial. */
  devices: YubiKeyDeviceSummary[];
  /** Detailed inspections for connected devices selected for inspection. */
  inspections: YubiKeyInspection[];
}

/** Secret and confirmation callbacks for YubiKey operations. */
export interface YubiKeyInteractionProvider {
  /** Prompts for the PIV PIN. */
  promptPin: () => Promise<string>;
  /** Prompts for the PIV management key. */
  promptManagementKey: () => Promise<string>;
  /** Prompts for destructive confirmation. */
  confirm: (message: string) => Promise<boolean>;
}

/** Input for generating a PIV Ed25519 key. */
export interface GenerateYubiKeyInput {
  /** Optional decimal YubiKey serial selector. */
  serial?: string;
  /** PIV slot. */
  slot: YubiKeySigningSlot;
  /** PIV PIN policy. */
  pinPolicy: YubiKeyPinPolicy;
  /** PIV touch policy. */
  touchPolicy: YubiKeyTouchPolicy;
  /** Whether occupied allowed slots may be replaced after confirmation. */
  force: boolean;
  /** Interaction callbacks for secrets and confirmation. */
  interaction: YubiKeyInteractionProvider;
}

/** Result of generating a PIV Ed25519 key. */
export interface GenerateYubiKeyResult {
  /** Decimal YubiKey serial number. */
  serial: string;
  /** Human-readable PC/SC reader name reported by the operating system. */
  readerName: string;
  /** Human-readable YubiKey model when available. */
  model?: string;
  /** PIV slot. */
  slot: YubiKeySigningSlot;
  /** Validated canonical Ed25519 public key. */
  publicKey: Ed25519PublicKeyHex;
  /** PIV PIN policy used for generation. */
  pinPolicy: YubiKeyPinPolicy;
  /** PIV touch policy used for generation. */
  touchPolicy: YubiKeyTouchPolicy;
  /** Whether an existing slot was replaced. */
  replacedExistingKey: boolean;
  /** Previous slot public key when an occupied slot was replaced and the key was readable. */
  replacedPublicKey?: Ed25519PublicKeyHex;
}

/** Input for importing a PIV Ed25519 private key. */
export interface ImportYubiKeyInput {
  /** Optional decimal YubiKey serial selector. */
  serial?: string;
  /** PIV slot. */
  slot: YubiKeySigningSlot;
  /** Validated canonical Ed25519 private signing key. */
  privateKeyHex: Ed25519PrivateKeyHex;
  /** Validated canonical Ed25519 public key derived by the caller. */
  publicKey: Ed25519PublicKeyHex;
  /** PIV PIN policy. */
  pinPolicy: YubiKeyPinPolicy;
  /** PIV touch policy. */
  touchPolicy: YubiKeyTouchPolicy;
  /** Whether occupied allowed slots may be replaced after confirmation. */
  force: boolean;
  /** Interaction callbacks for secrets and confirmation. */
  interaction: YubiKeyInteractionProvider;
}

/** Result of importing a PIV Ed25519 private key. */
export interface ImportYubiKeyResult {
  /** Decimal YubiKey serial number. */
  serial: string;
  /** Human-readable PC/SC reader name reported by the operating system. */
  readerName: string;
  /** Human-readable YubiKey model when available. */
  model?: string;
  /** PIV slot. */
  slot: YubiKeySigningSlot;
  /** Validated canonical Ed25519 public key. */
  publicKey: Ed25519PublicKeyHex;
  /** PIV PIN policy used for import. */
  pinPolicy: YubiKeyPinPolicy;
  /** PIV touch policy used for import. */
  touchPolicy: YubiKeyTouchPolicy;
  /** Whether an existing slot was replaced. */
  replacedExistingKey: boolean;
  /** Previous slot public key when an occupied slot was replaced and the key was readable. */
  replacedPublicKey?: Ed25519PublicKeyHex;
}

/** Input for verifying the PIV PIN on a connected YubiKey. */
export interface UnlockYubiKeyInput {
  /** Optional decimal YubiKey serial selector. */
  serial?: string;
  /** Interaction callbacks for prompting for the PIV PIN. */
  interaction: Pick<YubiKeyInteractionProvider, 'promptPin'>;
}

/** Result of verifying the PIV PIN on a connected YubiKey. */
export interface UnlockYubiKeyResult {
  /** Decimal YubiKey serial number. */
  serial: string;
  /** Human-readable PC/SC reader name reported by the operating system. */
  readerName: string;
  /** Human-readable YubiKey model when available. */
  model?: string;
}

/** Input for dropping current PIV PIN verification state for a connected YubiKey. */
export interface LockYubiKeyInput {
  /** Optional decimal YubiKey serial selector. */
  serial?: string;
}

/** Result of dropping current PIV PIN verification state for a connected YubiKey. */
export interface LockYubiKeyResult {
  /** Decimal YubiKey serial number. */
  serial: string;
  /** Human-readable PC/SC reader name reported by the operating system. */
  readerName: string;
  /** Human-readable YubiKey model when available. */
  model?: string;
}

/** A PIV-backed Ed25519 signing-key locator. */
export interface PivSigningDeviceLocator {
  /** Hardware family discriminator. */
  kind: 'yubikey' | 'generic_piv';
  /** PIN policy when known from signer inventory. */
  pinPolicy?: YubiKeyPinPolicy;
  /** Decimal YubiKey serial number when known. */
  serial?: string;
  /** PIV slot containing the signing key. */
  slot: YubiKeySigningSlot;
}

/** Input for PIV Ed25519 digest signing. */
export interface SignYubiKeyDigestInput {
  /** Validated canonical expected Ed25519 public key. */
  publicKey: Ed25519PublicKeyHex;
  /** Candidate PIV devices that may contain the key. */
  devices: PivSigningDeviceLocator[];
  /** Exact digest bytes to sign. */
  digest: Uint8Array;
  /** Optional interaction callbacks for CLI signing. MCP callers must omit this. */
  interaction?: Pick<YubiKeyInteractionProvider, 'promptPin'>;
}

/** Result of PIV Ed25519 digest signing. */
export interface SignYubiKeyDigestResult {
  /** Hex-encoded Ed25519 signature. */
  signatureHex: string;
}

/** Runtime watcher for connected YubiKey/card-reader state changes. */
export interface YubiKeyDeviceWatcher {
  /** Releases watcher resources and stops future change callbacks. */
  close(): void | Promise<void>;
}

/** Input for watching connected YubiKey/card-reader state changes. */
export interface WatchYubiKeyDevicesInput {
  /** Called when PC/SC reader or inserted-card state may have changed. */
  onChanged(): void;
  /** Called when PC/SC emits a reader or service error. */
  onError?(error: Error): void;
}

/** Mockable YubiKey service boundary. */
export interface YubiKeyService {
  /** Lists connected YubiKeys. */
  listDevices(): Promise<YubiKeyDeviceSummary[]>;
  /** Inspects one connected YubiKey selected by serial or, when omitted, the only connected YubiKey. */
  inspectDevice(serial?: string): Promise<YubiKeyInspection>;
  /**
   * Lists all connected PIV devices and inspects selected YubiKey serials using one hardware discovery pass.
   *
   * When `serials` is omitted, every connected PIV device with a readable serial is inspected. When `serials`
   * is supplied, only connected devices whose readable serial appears in the list are inspected; summaries for
   * all connected PIV devices are still returned so callers can distinguish unavailable requested serials from
   * unrelated connected devices. Devices without a readable serial are never inspected by this batch API.
   */
  listAndInspectDeviceKeys(serials?: readonly string[]): Promise<YubiKeyDeviceInspectionResult>;
  /** Generates a PIV Ed25519 key; unknown slot occupancy fails before authentication or mutation. */
  generateEd25519Key(input: GenerateYubiKeyInput): Promise<GenerateYubiKeyResult>;
  /** Imports a PIV Ed25519 private key; unknown slot occupancy fails before authentication or mutation. */
  importEd25519Key(input: ImportYubiKeyInput): Promise<ImportYubiKeyResult>;
  /** Verifies the device-wide PIV PIN without retaining it. */
  unlockDevice(input: UnlockYubiKeyInput): Promise<UnlockYubiKeyResult>;
  /** Clears device-wide PIV PIN verification without changing retries. */
  lockDevice?(input: LockYubiKeyInput): Promise<LockYubiKeyResult>;
  /** Watches connected reader/card state changes when the backend supports live notifications. */
  watchDevices?(input: WatchYubiKeyDevicesInput): Promise<YubiKeyDeviceWatcher>;
  /** Signs exact digest bytes with a PIV Ed25519 key without prompting for secrets. */
  signEd25519Digest(input: SignYubiKeyDigestInput): Promise<SignYubiKeyDigestResult>;
  /** Releases retained sessions and other service-owned runtime resources. */
  close?(): void | Promise<void>;
}

/** Validates and normalizes generation input before it reaches a backend. */
export function normalizeGenerateYubiKeyInput(input: Omit<GenerateYubiKeyInput, 'interaction' | 'pinPolicy' | 'slot' | 'touchPolicy'> & {
  pinPolicy: string;
  slot: string;
  touchPolicy: string;
}): Omit<GenerateYubiKeyInput, 'interaction'> {
  return {
    ...input,
    pinPolicy: assertYubiKeyPinPolicy(input.pinPolicy),
    slot: assertAllowedYubiKeySigningSlot(input.slot),
    touchPolicy: assertYubiKeyTouchPolicy(input.touchPolicy),
  };
}
