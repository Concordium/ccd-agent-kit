import { deriveIdentityMaterial, type IdentityMaterial } from './identityMaterial.js';
import { deriveIdentityRoot } from './identityRoot.js';
import { deriveIdentityStorageMaterial, type IdentityStorageMaterial } from './identityStorageCrypto.js';
import { IdentityWorkflowError, workflowFailure } from './workflowErrors.js';
import { IdentitySourceError } from '@ccd-agent-kit/config-utils';
import type { IdentitySourceService } from './sources/types.js';
import type { IdentitySelection } from './workflowTypes.js';
import { IdentityHardwareError } from '@ccd-agent-kit/piv-utils';
import { withIdentityHardwareQueue } from './hardwareQueue.js';

/**
 * Run one identity operation inside the existing serialized derivation and zeroization scope.
 * This package-internal boundary does not expose material through any CLI or MCP API.
 */
export async function withIdentityMaterial<T>(input: {
  selection: IdentitySelection;
  sourceId: string;
  sources: IdentitySourceService;
  promptPin?: () => Promise<string>;
}, callback: (seed: Buffer, material: IdentityMaterial, storage: IdentityStorageMaterial) => Promise<T> | T): Promise<T> {
  let seed: Buffer | undefined;
  let material: IdentityMaterial | undefined;
  let storage: IdentityStorageMaterial | undefined;
  let authorizationRequired = false;
  try {
    const agreement = await (input.promptPin === undefined
      ? input.sources.createAgreement(input.sourceId)
      : input.sources.createAgreement(input.sourceId, { promptPin: input.promptPin }));
    seed = await deriveIdentityRoot({
      network: input.selection.sdkNetwork,
      identityProviderIndex: input.selection.identityProviderIndex,
      identityIndex: input.selection.identityIndex,
      expectedPublicKey: Buffer.from(input.selection.rootPublicKey, 'hex'),
      agreement: { async agree(peer) {
        try { return await withIdentityHardwareQueue(() => agreement.agree(peer)); }
        catch (error) {
          authorizationRequired = error instanceof IdentityHardwareError && error.code === 'AUTHORIZATION_REQUIRED';
          throw error;
        }
      } },
    });
    material = deriveIdentityMaterial({
      seed, network: input.selection.sdkNetwork,
      identityProviderIndex: input.selection.identityProviderIndex, identityIndex: input.selection.identityIndex,
    });
    storage = deriveIdentityStorageMaterial(seed);
    return await callback(seed, material, storage);
  } catch (error) {
    if (error instanceof IdentitySourceError) throw error;
    throw authorizationRequired ? new IdentityWorkflowError('AUTHORIZATION_REQUIRED') : workflowFailure(error, 'CRYPTO_FAILED');
  } finally {
    seed?.fill(0);
    storage?.encryptionKey.fill(0);
    if (material) for (const buffer of Object.values(material)) buffer.fill(0);
  }
}
