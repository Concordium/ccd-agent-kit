import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  getSignerYubiKeyConfigPath,
  loadYubiKeyConfig,
  resetYubiKeyGenerationDefaults,
  resolveYubiKeyGenerationDefaults,
  saveYubiKeyConfig,
  setYubiKeyGenerationDefaults,
} from '../../src/index.js';
import { useConfigSandbox } from '../helpers/configSandbox.js';

describe('shared YubiKey provisioning defaults', () => {
  useConfigSandbox();

  it('uses secure built-in defaults and resolves explicit over device over global settings', () => {
    expect(loadYubiKeyConfig()).toEqual({});
    expect(resolveYubiKeyGenerationDefaults({})).toEqual({ slot: '9c', pinPolicy: 'once', touchPolicy: 'never' });
    setYubiKeyGenerationDefaults({ defaults: { slot: '82', touchPolicy: 'cached' } });
    setYubiKeyGenerationDefaults({ serial: '123', defaults: { slot: '83', pinPolicy: 'always' } });
    expect(resolveYubiKeyGenerationDefaults({ serial: '123', overrides: { pinPolicy: 'never' } })).toEqual({
      slot: '83', pinPolicy: 'never', touchPolicy: 'cached',
    });
  });

  it('resets global and per-device defaults independently', () => {
    setYubiKeyGenerationDefaults({ defaults: { slot: '82' } });
    setYubiKeyGenerationDefaults({ serial: '123', defaults: { slot: '83' } });
    setYubiKeyGenerationDefaults({ serial: '456', defaults: { slot: '84' } });
    resetYubiKeyGenerationDefaults('123');
    expect(loadYubiKeyConfig()).toEqual({ defaults: { slot: '82' }, devices: { '456': { slot: '84' } } });
    resetYubiKeyGenerationDefaults('456');
    resetYubiKeyGenerationDefaults();
    expect(loadYubiKeyConfig()).toEqual({});
    resetYubiKeyGenerationDefaults('missing');
    expect(loadYubiKeyConfig()).toEqual({});
  });

  it('preserves typed saved input and rejects invalid mutation serials before replacement', () => {
    saveYubiKeyConfig({ defaults: { slot: '82', pinPolicy: 'once' }, devices: { '123': { touchPolicy: 'always' } } });
    const before = loadYubiKeyConfig();
    expect(() => setYubiKeyGenerationDefaults({ serial: 'bad', defaults: { slot: '82' } })).toThrow();
    expect(loadYubiKeyConfig()).toEqual(before);
  });

  it('treats malformed persisted JSON as absent and rejects invalid persisted settings', () => {
    mkdirSync(dirname(getSignerYubiKeyConfigPath()), { recursive: true });
    chmodSync(dirname(dirname(getSignerYubiKeyConfigPath())), 0o700);
    chmodSync(dirname(getSignerYubiKeyConfigPath()), 0o700);
    writeFileSync(getSignerYubiKeyConfigPath(), '{bad', { mode: 0o600 });
    expect(loadYubiKeyConfig()).toEqual({});
    writeFileSync(getSignerYubiKeyConfigPath(), JSON.stringify({ devices: { bad: { slot: '82' } } }), { mode: 0o600 });
    expect(loadYubiKeyConfig()).toEqual({});
  });
});
