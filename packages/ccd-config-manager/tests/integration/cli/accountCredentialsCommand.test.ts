import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadAccountCredentials } from '@ccd-agent-kit/config-utils';
import { ed25519PublicKey } from '@ccd-agent-kit/sdk-utils';
import { runAccountCredentialsCommand } from '../../../src/cli/accountCredentialsCommand.js';
import { setupCliTestEnv, type CliTestEnv } from '../../helpers/testEnv.js';

const ADDRESS = '3DPgLSmDKt7tvAybE95obMXANrUChv5aBpzGPU3qjaG7ERG6JC';
const MAINNET_REF = '9dd9ca4d19e9393877d2c44b70f89acb';

describe('account credentials command integration', () => {
  let env: CliTestEnv;

  beforeEach(() => {
    env = setupCliTestEnv('ccd-config-manager-account-credentials-');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    env.restore();
  });

  it('refreshes, shows, and removes a finalized observation', async () => {
    const queryAccountCredentials = vi.fn(async () => ({
      canonicalAddress: ADDRESS,
      observation: {
        accountThreshold: '1',
        credentials: {
          '0': {
            keys: { '0': { publicKey: ed25519PublicKey.require('ab'.repeat(32)), scheme: 'Ed25519' as const } },
            threshold: '1',
          },
        },
        sourceBlock: { hash: 'cd'.repeat(32), height: '123', time: '2026-09-24T00:00:00.000Z' },
      },
    }));

    expect(await run({ kind: 'refresh', address: ADDRESS }, queryAccountCredentials)).toBe(0);
    expect(loadAccountCredentials(MAINNET_REF)).toHaveProperty(ADDRESS);

    env.stdout.length = 0;
    expect(await run({ kind: 'show', address: ADDRESS })).toBe(0);
    expect(env.stdout.join('\n')).toContain(`Key 0: Ed25519 ${'ab'.repeat(32)}`);

    expect(await run({ kind: 'remove', address: ADDRESS })).toBe(0);
    expect(loadAccountCredentials(MAINNET_REF)).toEqual({});
  });

  function run(
    request: Parameters<typeof runAccountCredentialsCommand>[0]['request'],
    queryAccountCredentials?: Parameters<typeof runAccountCredentialsCommand>[0]['queryAccountCredentials'],
  ) {
    return runAccountCredentialsCommand({ request, queryAccountCredentials, stdout: env.stdout, stderr: env.stderr });
  }
});
