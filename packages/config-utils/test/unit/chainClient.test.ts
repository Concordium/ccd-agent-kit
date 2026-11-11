import { describe, expect, it } from 'vitest';

import {
  getChainClientConfigPath, loadChainClientConfig, resetChainClientConfig, updateChainClientStartupRefreshConfig,
} from '../../src/index.js';
import { readJsonFile, writeJsonFile } from '../helpers/jsonFile.js';
import { useConfigSandbox } from '../helpers/configSandbox.js';

describe('chain client configuration', () => {
  useConfigSandbox();
  const defaults = { enabled: true, maxAge: '24h', failureRetry: '5m', concurrency: 3 };

  it('loads, updates, and resets startup settings', () => {
    expect(loadChainClientConfig().accountCredentials.startupRefresh).toEqual(defaults);
    updateChainClientStartupRefreshConfig({ enabled: false, maxAge: '7d', concurrency: 5 });
    expect(loadChainClientConfig().accountCredentials.startupRefresh).toEqual({
      ...defaults, enabled: false, maxAge: '7d', concurrency: 5,
    });
    expect(resetChainClientConfig().accountCredentials.startupRefresh).toEqual(defaults);
    expect(loadChainClientConfig().accountCredentials.startupRefresh).toEqual(defaults);
  });

  it('falls back on malformed structures without rewriting them', () => {
    for (const value of [null, {}, { accountCredentials: {} }, {
      accountCredentials: { startupRefresh: { ...defaults, concurrency: 0 } },
    }]) {
      writeJsonFile(getChainClientConfigPath(), value);
      expect(loadChainClientConfig().accountCredentials.startupRefresh).toEqual(defaults);
      expect(readJsonFile(getChainClientConfigPath())).toEqual(value);
    }
  });

  it('rejects invalid updates without changing saved settings', () => {
    resetChainClientConfig();
    for (const patch of [{ maxAge: 'invalid' }, { failureRetry: '1w' }, { concurrency: 0 }, { concurrency: 1.5 }]) {
      expect(() => updateChainClientStartupRefreshConfig(patch)).toThrow();
      expect(loadChainClientConfig().accountCredentials.startupRefresh).toEqual(defaults);
    }
  });
});
