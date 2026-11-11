import { signAsync } from '@noble/ed25519';
import {
  ENCRYPTED_FILE_STORAGE_MODULE_ID,
  SOFTWARE_SIGNER_MODULE_ID,
  isEncryptedFileStorageUnlocked,
  loadEncryptedEd25519PrivateKey,
  parseSoftwareBackend,
} from '@ccd-agent-kit/config-utils';
import type { SignerInventoryBackendEntry } from '@ccd-agent-kit/config-utils';
import {
  getSoftwareSchemeEnabledInConfig,
  getSoftwareStorageModuleEnabledInConfig,
} from './softwareSignerConfig.js';
import {
  type SignerBackendStatus,
  type SignerModule,
} from './types.js';

/** Built-in software Ed25519 signing module. */
export const softwareSignerModule: SignerModule = {
  controls: [
    {
      command: 'ccd-config-manager service signer unlock --instance <instance-id>',
      description: 'Unlock encrypted software key storage in a running signer MCP process.',
      type: 'unlock',
    },
    {
      command: 'ccd-config-manager service signer lock --instance <instance-id>',
      description: 'Lock encrypted software key storage in a running signer MCP process.',
      type: 'lock',
    },
  ],
  defaultEnabled: true,
  id: SOFTWARE_SIGNER_MODULE_ID,
  isBackendVisible(entry: SignerInventoryBackendEntry, scheme: string, config): boolean {
    const backend = parseSoftwareBackend(entry.backend);
    return backend !== undefined && getSoftwareSchemeEnabledInConfig(scheme, config) && getSoftwareStorageModuleEnabledInConfig(backend.storageModule, config);
  },
  getBackendStatus(entry: SignerInventoryBackendEntry): SignerBackendStatus {
    const backend = parseSoftwareBackend(entry.backend);
    if (backend === undefined || backend.storageModule !== ENCRYPTED_FILE_STORAGE_MODULE_ID) return 'unavailable';
    return isEncryptedFileStorageUnlocked() ? 'unlocked' : 'locked';
  },
  async handleControlRequest({ request }) {
    if (request.type === 'lock') {
      const { lockEncryptedFileStorage } = await import('@ccd-agent-kit/config-utils');
      lockEncryptedFileStorage();
      return { ok: true, status: 'locked' };
    }
    if (request.type === 'unlock') {
      if (typeof request.password !== 'string' || request.password.length === 0) {
        return { ok: false, error: 'missing-password' };
      }
      const { unlockEncryptedFileStorage } = await import('@ccd-agent-kit/config-utils');
      unlockEncryptedFileStorage(request.password);
      return { ok: true, status: 'unlocked' };
    }
    return undefined;
  },
  async signEd25519Digest(input): Promise<string> {
    const backend = parseSoftwareBackend(input.backendEntry.backend);
    if (backend === undefined) throw new Error(`Software key ${input.publicKey} has malformed backend metadata.`);
    if (backend.storageModule !== ENCRYPTED_FILE_STORAGE_MODULE_ID) {
      throw new Error(`Software key ${input.publicKey} uses an unsupported storage module.`);
    }
    const privateKeyBytes = loadEncryptedEd25519PrivateKey(backend.keyRef, input.publicKey);
    return Buffer.from(await signAsync(input.digest, privateKeyBytes)).toString('hex');
  },
};
