import type { P256Agreement, PivPinPolicy, PivPinStatus, PivTouchPolicy } from './types.js';

/** Public device facts; never a native reader handle or sensitive local path. */
export interface IdentityDeviceSummary {
  /** Public PC/SC reader name. */
  readerName: string;
  /** Decimal YubiKey serial, when available. */
  serial?: string;
  /** Observed firmware version. */
  firmwareVersion?: string;
  /** Observed hardware model. */
  model?: string;
  /** Observed hardware form factor. */
  formFactor?: string;
}

/** Read-only public observation of the dedicated identity root slot. */
export interface IdentityRootInspection extends IdentityDeviceSummary {
  /** Required decimal serial; names are not identity selectors. */
  serial: string;
  /** Fixed identity key-agreement slot. */
  slot: '9d';
  /** Unknown metadata never authorizes provisioning. */
  status: 'empty' | 'occupied' | 'unknown';
  /** Observed algorithm, without treating other schemes as P-256. */
  algorithm?: string;
  /** Validated canonical uncompressed 65-byte P-256 public key, in hex. */
  publicKey?: string;
  /** Observed generation/import origin. */
  origin?: string;
  /** Observed PIN policy, if known. */
  pinPolicy?: PivPinPolicy;
  /** Observed touch policy, if known. */
  touchPolicy?: PivTouchPolicy;
  /** Fresh device-wide PIV PIN security status. */
  pinStatus: PivPinStatus;
}

/** Trusted CLI-only interaction; secrets are transient and never command arguments. */
export interface IdentityHardwareInteraction {
  /** Request hidden PIN input when authentication requires it. */
  promptPin(): Promise<string>;
  /** Request hidden management-key input when authentication requires it. */
  promptManagementKey(): Promise<string>;
  /** Confirm typed destructive replacement inline, before authentication. */
  confirm(message: string): Promise<boolean>;
}

/** Explicit root generation authorization; there are no implicit policy defaults. */
export interface IdentityRootGenerationInput {
  /** Required decimal device serial. */
  serial: string;
  /** Explicit PIN policy. */
  pinPolicy: PivPinPolicy;
  /** Explicit touch policy. */
  touchPolicy: PivTouchPolicy;
  /** Permit replacement only with an additional destructive confirmation. */
  force: boolean;
  /** CLI-only authentication and confirmation callbacks. */
  interaction: IdentityHardwareInteraction;
}

/** Explicit P-256 root import authorization; private material is transient. */
export interface IdentityRootImportInput extends IdentityRootGenerationInput {
  /** Exactly 32 bytes of hexadecimal P-256 private scalar material. */
  privateKeyHex: string;
}

/** Verified generation facts, not a persisted trust pin or identity root secret. */
export interface IdentityRootGenerationResult extends IdentityRootInspection {
  /** Successful generation is verified occupied. */
  status: 'occupied';
  /** Validated response key matching post-generation metadata. */
  publicKey: string;
  /** Whether generation replaced an existing key. */
  replacedExistingKey: boolean;
}

/** Internal identity hardware service; no account-signing or raw-command surface. */
export interface IdentityYubiKeyService {
  /** Discover public device facts without mutating hardware. */
  listDevices(): Promise<IdentityDeviceSummary[]>;
  /** Inspect fixed slot 9d for a required decimal serial. */
  inspectRoot(serial: string): Promise<IdentityRootInspection>;
  /** Generate P-256 only after explicit guards; never retry mutation. */
  generateRoot(input: IdentityRootGenerationInput): Promise<IdentityRootGenerationResult>;
  /** Import a validated P-256 scalar after explicit guards; never retry mutation. */
  importRoot(input: IdentityRootImportInput): Promise<IdentityRootGenerationResult>;
  /** Query device-wide PIV PIN security status. */
  pinStatus(serial: string): Promise<PivPinStatus>;
  /** Verify a transient PIN for the device-wide PIV application. */
  pinUnlock(serial: string, promptPin: () => Promise<string>): Promise<void>;
  /** Clear device-wide PIV PIN verification without changing retries. */
  pinLock(serial: string): Promise<void>;
  /** Bind each agreement operation to an explicit copied public-key pin. */
  createAgreement(input: {
    /** Required decimal device serial. */
    serial: string;
    /** Canonical uncompressed P-256 public key; missing pins never imply trust. */
    expectedPublicKey: Uint8Array;
    /** Optional CLI-only PIN prompt; absence must never trigger implicit prompting. */
    promptPin?: () => Promise<string>;
  }): P256Agreement;
  /** Release retained shared card connections. */
  close?(): Promise<void>;
}
