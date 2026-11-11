import { join } from 'node:path';
import { homedir } from 'node:os';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  getAccountLabelsPath,
  getAccountLabelsPathForNetwork,
  getConfigDir,
  getDataDir,
  getSignerInventoryPath,
  getSignerKeyStorageDir,
  getNetworksFilePath,
  getSignerConfigDir,
  getSignerConfigPath,
  getSignerDataDir,
  getSignerNetworkDir,
  getSignerYubiKeyConfigPath,
  getYubiKeyRegistrationsPath,
  getStateDir,
} from '../../src/index.js';
import { testScratchPath } from '../helpers/tempDir.js';

const originalEnv = { ...process.env };

describe('XDG path helpers', () => {
  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('respects XDG base directories', () => {
    const configHome = testScratchPath('ccd-config');
    const dataHome = testScratchPath('ccd-data');
    const stateHome = testScratchPath('ccd-state');
    process.env.XDG_CONFIG_HOME = configHome;
    process.env.XDG_DATA_HOME = dataHome;
    process.env.XDG_STATE_HOME = stateHome;

    expect(getConfigDir()).toBe(join(configHome, 'ccd-agent-kit'));
    expect(getDataDir()).toBe(join(dataHome, 'ccd-agent-kit'));
    expect(getStateDir()).toBe(join(stateHome, 'ccd-agent-kit'));
    expect(getNetworksFilePath()).toBe(join(configHome, 'ccd-agent-kit', 'networks.json'));
    expect(getAccountLabelsPath()).toBe(join(stateHome, 'ccd-agent-kit', 'account-labels.json'));
    expect(getAccountLabelsPathForNetwork('abcd')).toBe(join(dataHome, 'ccd-agent-kit', 'account-labels', 'abcd.json'));
    expect(getSignerConfigDir()).toBe(join(configHome, 'ccd-agent-kit', 'signer'));
    expect(getSignerConfigPath()).toBe(join(configHome, 'ccd-agent-kit', 'signer', 'config.json'));
    expect(getSignerYubiKeyConfigPath()).toBe(join(configHome, 'ccd-agent-kit', 'signer', 'yubikey.json'));
    expect(getSignerDataDir()).toBe(join(dataHome, 'ccd-agent-kit', 'signer'));
    expect(getSignerNetworkDir('abcd')).toBe(join(dataHome, 'ccd-agent-kit', 'signer', 'abcd'));
    expect(getSignerInventoryPath()).toBe(join(dataHome, 'ccd-agent-kit', 'signer', 'inventory.json'));
    expect(getSignerKeyStorageDir()).toBe(join(dataHome, 'ccd-agent-kit', 'signer', 'key-storage'));
    expect(getYubiKeyRegistrationsPath()).toBe(join(dataHome, 'ccd-agent-kit', 'yubikeys.json'));
  });

  it('uses homedir-compatible defaults when XDG env vars are unset', () => {
    delete process.env.XDG_CONFIG_HOME;
    delete process.env.XDG_DATA_HOME;
    delete process.env.XDG_STATE_HOME;

    expect(getConfigDir()).toBe(join(homedir(), '.config', 'ccd-agent-kit'));
    expect(getDataDir()).toBe(join(homedir(), '.local', 'share', 'ccd-agent-kit'));
    expect(getStateDir()).toBe(join(homedir(), '.local', 'state', 'ccd-agent-kit'));
  });
});
