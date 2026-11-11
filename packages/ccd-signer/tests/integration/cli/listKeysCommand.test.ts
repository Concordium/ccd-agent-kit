import { rmSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runListKeysCommand } from '../../../src/cli/listKeysCommand.js';
import { runCliWithOutput } from '../../cli/runCliWithOutput.js';
import { upsertSignerInventoryKey } from '@ccd-agent-kit/config-utils';
import { makeTestTempDir } from '../../helpers/tempDir.js';
import { FAKE_VERIFY_KEY_HEX } from '../../helpers/syntheticWallet.js';

describe('runListKeysCommand', () => {
  let tempDir: string;
  let originalData: string | undefined;
  let originalState: string | undefined;
  let originalConfig: string | undefined;

  beforeEach(() => {
    originalData = process.env.XDG_DATA_HOME;
    originalState = process.env.XDG_STATE_HOME;
    originalConfig = process.env.XDG_CONFIG_HOME;
    tempDir = makeTestTempDir('list-keys-command-test-');
    process.env.XDG_DATA_HOME = join(tempDir, 'data');
    process.env.XDG_STATE_HOME = join(tempDir, 'state');
    process.env.XDG_CONFIG_HOME = join(tempDir, 'config');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    if (originalData !== undefined) process.env.XDG_DATA_HOME = originalData;
    else delete process.env.XDG_DATA_HOME;
    if (originalState !== undefined) process.env.XDG_STATE_HOME = originalState;
    else delete process.env.XDG_STATE_HOME;
    if (originalConfig !== undefined) process.env.XDG_CONFIG_HOME = originalConfig;
    else delete process.env.XDG_CONFIG_HOME;
  });

  it('prints signer keys as JSON', async () => {
    upsertSignerInventoryKey({
      backend: { devices: [{ kind: 'yubikey', serial: '39713352', slot: '82' }] },
      label: 'hardware-key',
      publicKey: FAKE_VERIFY_KEY_HEX,
      scheme: 'Ed25519',
      signingModule: 'yubikey-piv',
    });

    const stdout: string[] = [];
    const stderr: string[] = [];
    const exitCode = await runListKeysCommand({ stderr, stdout });

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(JSON.parse(stdout.join('\n'))).toEqual({
      keys: [
        {
          label: 'hardware-key',
          publicKey: FAKE_VERIFY_KEY_HEX,
          scheme: 'Ed25519',
          status: 'unknown',
        },
      ],
    });
  });

  it('rejects unexpected arguments', async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];

    const exitCode = await runCliWithOutput(['list-keys', '--bogus'], { stderr, stdout });

    expect(exitCode).toBe(2);
    expect(stdout).toEqual([]);
    expect(stderr.join('\n')).toContain("unknown option '--bogus'");
  });
});
