import type { Ed25519PublicKeyHex } from '@ccd-agent-kit/sdk-utils';
import type { YubiKeyInteractionProvider, YubiKeyService } from '@ccd-agent-kit/piv-utils';
import type { SignerConfigFile, SignerInventoryBackendEntry, SignerInventoryKeyScheme } from '@ccd-agent-kit/config-utils';

/** Current process availability for a policy-visible signer inventory backend. */
export type SignerBackendStatus = 'unknown' | 'unlocked' | 'locked' | 'unavailable';

/** Policy-visible module backend passed to opaque module activation hooks. */
export interface SignerBackendDescriptor {
  /** Validated canonical Ed25519 public key for the inventory entry. */
  publicKey: Ed25519PublicKeyHex;
  /** Public signing-key scheme. */
  scheme: SignerInventoryKeyScheme;
  /** Policy-visible inventory backend owned by this module. */
  backendEntry: SignerInventoryBackendEntry;
}

/** Static module-owned control metadata used by guidance and local control routing. */
export interface SignerModuleControlDefinition {
  /** Stable local control request type. */
  type: string;
  /** Short user-facing control description. */
  description: string;
  /** Optional copyable CLI command template for guidance. */
  command?: string;
}

/** Runtime object returned by an activated signer module. */
export interface ActivatedSignerModule {
  /** Replaces the inventory snapshot and refreshes readiness without changing local authorization. */
  refresh?(backends: SignerBackendDescriptor[]): void | Promise<void>;
  /** Releases module-owned runtime resources. */
  close(): void | Promise<void>;
}

/** Input for opaque module activation. */
export interface SignerModuleActivationInput {
  /** Policy-visible backends owned by this module when activation starts. */
  backends: SignerBackendDescriptor[];
  /** Optional host-provided services. */
  services?: SignerModuleServices;
  /** Optional callback modules may call after status changes. */
  notifyChanged?: () => void;
}

/** Input for module-owned local control handling. */
export interface SignerModuleControlInput {
  /** Parsed authenticated local control request. */
  request: Record<string, unknown>;
  /** Optional host-provided services. */
  services?: SignerModuleServices;
  /** Optional callback modules may call after status changes. */
  notifyChanged?: () => void;
}

/** Runtime services that can be injected into signing modules for tests and alternate hosts. */
export interface SignerModuleServices {
  /** Optional YubiKey service used by the built-in YubiKey PIV module. */
  yubiKeyService?: YubiKeyService;
  /** Optional YubiKey interaction callbacks used by interactive CLI signing. */
  yubiKeyInteraction?: Pick<YubiKeyInteractionProvider, 'promptPin'>;
}

/** Input for module-owned Ed25519 digest signing. */
export interface SignerModuleSignInput {
  /** Validated canonical expected Ed25519 public key. */
  publicKey: Ed25519PublicKeyHex;
  /** Exact digest bytes to sign. */
  digest: Uint8Array;
  /** Policy-visible inventory backend owned by this module. */
  backendEntry: SignerInventoryBackendEntry;
  /** Optional host-provided services. */
  services?: SignerModuleServices;
}

/** Built-in signer module contract used by signer core for registry lookup. */
export interface SignerModule {
  /** Stable module identifier stored in inventory and signer config. */
  id: string;
  /** Default signer-owned enablement policy for this module. */
  defaultEnabled: boolean;
  /** Static module-owned local control request metadata. */
  controls?: SignerModuleControlDefinition[];
  /** Returns whether a module-owned inventory backend is visible under module-owned policy in a config snapshot. */
  isBackendVisible(entry: SignerInventoryBackendEntry, scheme: SignerInventoryKeyScheme, config: SignerConfigFile): boolean;
  /** Returns whether a policy-visible backend can currently attempt signing in this process. */
  getBackendStatus?(entry: SignerInventoryBackendEntry, scheme: SignerInventoryKeyScheme): SignerBackendStatus;
  /** Optionally activates module-owned process runtime for visible backends. */
  activate?(input: SignerModuleActivationInput): Promise<ActivatedSignerModule | undefined>;
  /** Optionally handles a module-owned authenticated local control request. */
  handleControlRequest?(input: SignerModuleControlInput): Promise<Record<string, unknown> | undefined>;
  /** Signs an Ed25519 digest using a module-owned, policy-visible inventory entry. */
  signEd25519Digest(input: SignerModuleSignInput): Promise<string>;
}
