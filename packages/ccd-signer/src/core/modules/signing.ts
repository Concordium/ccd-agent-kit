import type { Ed25519PublicKeyHex } from '@ccd-agent-kit/sdk-utils';
import { ed25519SignerKeyRef, loadSignerInventory, type SignerInventoryBackendEntry, type SignerInventoryKeyEntry } from '@ccd-agent-kit/config-utils';
import type { YubiKeyInteractionProvider, YubiKeyService } from '@ccd-agent-kit/piv-utils';
import { getVisibleSignerInventoryBackends, listVisibleSignerInventoryBackends } from './keyVisibility.js';
import { loadModuleConfig } from '@ccd-agent-kit/config-utils';
import { getSignerModule } from './registry.js';

/** Signs an Ed25519 digest with the visible module-owned key for a public key. */
export async function signVisibleInventoryEd25519Digest(input: {
  /** Validated canonical expected Ed25519 public key. */
  publicKey: Ed25519PublicKeyHex;
  /** Exact digest bytes to sign. */
  digest: Uint8Array;
  /** Optional injected YubiKey service for tests. */
  yubiKeyService?: YubiKeyService;
  /** Optional YubiKey interaction callbacks for interactive CLI signing. */
  yubiKeyInteraction?: Pick<YubiKeyInteractionProvider, 'promptPin'>;
}): Promise<string> {
  const backends = getVisibleSignerInventoryBackends(input.publicKey);
  if (backends.length === 0) {
    throw new Error(`Signer key ${input.publicKey} is not available.`);
  }
  return signInventoryBackendsEd25519Digest({ ...input, backends });
}

/** Signs an Ed25519 digest using a policy-visible inventory entry. */
export async function signInventoryEntryEd25519Digest(input: {
  /** Validated canonical expected Ed25519 public key. */
  publicKey: Ed25519PublicKeyHex;
  /** Exact digest bytes to sign. */
  digest: Uint8Array;
  /** Policy-visible inventory entry. */
  entry: SignerInventoryKeyEntry;
  /** Optional injected YubiKey service for tests. */
  yubiKeyService?: YubiKeyService;
  /** Optional YubiKey interaction callbacks for interactive CLI signing. */
  yubiKeyInteraction?: Pick<YubiKeyInteractionProvider, 'promptPin'>;
}): Promise<string> {
  const config = loadModuleConfig();
  return signInventoryBackendsEd25519Digest({
    digest: input.digest,
    backends: listVisibleSignerInventoryBackends(input.entry, config),
    publicKey: input.publicKey,
    yubiKeyInteraction: input.yubiKeyInteraction,
    yubiKeyService: input.yubiKeyService,
  });
}

/** Signs an Ed25519 digest by trying visible inventory backends in order. */
export async function signInventoryBackendsEd25519Digest(input: {
  /** Validated canonical expected Ed25519 public key. */
  publicKey: Ed25519PublicKeyHex;
  /** Exact digest bytes to sign. */
  digest: Uint8Array;
  /** Policy-visible inventory backend entries. */
  backends: SignerInventoryBackendEntry[];
  /** Optional injected YubiKey service for tests. */
  yubiKeyService?: YubiKeyService;
  /** Optional YubiKey interaction callbacks for interactive CLI signing. */
  yubiKeyInteraction?: Pick<YubiKeyInteractionProvider, 'promptPin'>;
}): Promise<string> {
  let lastError: unknown;
  for (const backendEntry of input.backends) {
    const freshBackendEntry = getFreshVisibleBackendForAttempt(input.publicKey, backendEntry);
    if (freshBackendEntry === undefined) {
      lastError = new Error(`Signer key ${input.publicKey} is not available.`);
      continue;
    }
    const module = getSignerModule(freshBackendEntry.signingModule);
    if (module === undefined) {
      lastError = new Error(`Signer key ${input.publicKey} uses an unsupported signing module.`);
      continue;
    }
    try {
      return await module.signEd25519Digest({
        digest: input.digest,
        backendEntry: freshBackendEntry,
        publicKey: input.publicKey,
        services: { yubiKeyInteraction: input.yubiKeyInteraction, yubiKeyService: input.yubiKeyService },
      });
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError instanceof Error) throw lastError;
  throw new Error(`Signer key ${input.publicKey} is not available.`);
}

function getFreshVisibleBackendForAttempt(
  publicKey: Ed25519PublicKeyHex,
  candidate: SignerInventoryBackendEntry,
): SignerInventoryBackendEntry | undefined {
  const inventory = loadSignerInventory();
  const config = loadModuleConfig();
  const entry = inventory.keys[ed25519SignerKeyRef(publicKey)];
  if (entry === undefined) return undefined;
  return listVisibleSignerInventoryBackends(entry, config).find(
    (backendEntry) => backendEntry.signingModule === candidate.signingModule,
  );
}
