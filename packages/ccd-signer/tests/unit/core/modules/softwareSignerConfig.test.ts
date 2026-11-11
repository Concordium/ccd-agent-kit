import { describe, expect, it } from 'vitest';

import { SOFTWARE_SIGNER_MODULE_ID, type SignerConfigFile } from '@ccd-agent-kit/config-utils';
import {
  getSoftwareSchemeEnabledInConfig,
  getSoftwareStorageModuleEnabledInConfig,
} from '../../../../src/core/modules/softwareSignerConfig.js';

describe('software signer policy', () => {
  it('applies built-in defaults from a normalized producer snapshot', () => {
    const config = softwareConfig({ schemes: {}, storageModules: {} });

    expect(getSoftwareSchemeEnabledInConfig('Ed25519', config)).toBe(true);
    expect(getSoftwareSchemeEnabledInConfig('future', config)).toBe(false);
    expect(getSoftwareStorageModuleEnabledInConfig('encrypted-file', config)).toBe(true);
    expect(getSoftwareStorageModuleEnabledInConfig('future', config)).toBe(false);
  });

  it('honors explicit scheme and storage policy', () => {
    const config = softwareConfig({
      schemes: { Ed25519: { enabled: false } },
      storageModules: { 'encrypted-file': { enabled: false } },
    });

    expect(getSoftwareSchemeEnabledInConfig('Ed25519', config)).toBe(false);
    expect(getSoftwareStorageModuleEnabledInConfig('encrypted-file', config)).toBe(false);
  });
});

function softwareConfig(config: Record<string, unknown>): SignerConfigFile {
  return {
    moduleConfigs: { [SOFTWARE_SIGNER_MODULE_ID]: { config } },
    signer: { config: { signingModules: {} } },
    version: 1,
  };
}
