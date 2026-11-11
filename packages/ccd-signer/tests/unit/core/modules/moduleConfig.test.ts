import { describe, expect, it } from 'vitest';

import type { SignerConfigFile } from '@ccd-agent-kit/config-utils';
import { isRegisteredSigningModuleEnabledInConfig } from '../../../../src/core/modules/moduleConfig.js';

describe('isRegisteredSigningModuleEnabledInConfig', () => {
  it('uses each registered module default when no explicit policy exists', () => {
    const config = signerConfig({});

    expect(isRegisteredSigningModuleEnabledInConfig('default-on', true, config)).toBe(true);
    expect(isRegisteredSigningModuleEnabledInConfig('default-off', false, config)).toBe(false);
  });

  it('lets explicit signer policy override a module default', () => {
    const config = signerConfig({
      'default-off': { enabled: true },
      'default-on': { enabled: false },
    });

    expect(isRegisteredSigningModuleEnabledInConfig('default-on', true, config)).toBe(false);
    expect(isRegisteredSigningModuleEnabledInConfig('default-off', false, config)).toBe(true);
  });
});

function signerConfig(signingModules: SignerConfigFile['signer']['config']['signingModules']): SignerConfigFile {
  return { moduleConfigs: {}, signer: { config: { signingModules } }, version: 1 };
}
