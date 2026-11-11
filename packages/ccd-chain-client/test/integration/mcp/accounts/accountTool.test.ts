import { rmSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadAccountCredentials, setAccountCredentialObservation } from '@ccd-agent-kit/config-utils';

import { syncAccountCredentialsHandler } from '../../../../src/mcp/accounts/handlers.js';
import { FakeConcordiumClient, makeContext } from '../../../helpers/fakes.js';
import { FIXTURE_PUBLIC_KEY } from '../../../helpers/keys.js';
import { makeTestTempDir } from '../../../helpers/tempDir.js';

const MAINNET_REF = '9dd9ca4d19e9393877d2c44b70f89acb';
const ADDRESS = '3DPgLSmDKt7tvAybE95obMXANrUChv5aBpzGPU3qjaG7ERG6JC';

describe('account tools', () => {
  let tempDir: string;
  let originalStateHome: string | undefined;

  beforeEach(() => {
    originalStateHome = process.env.XDG_STATE_HOME;
    tempDir = makeTestTempDir('mcp-account-tool-');
    process.env.XDG_STATE_HOME = tempDir;
  });

  afterEach(() => {
    if (originalStateHome === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = originalStateHome;
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('refreshes finalized account credentials into shared config state', async () => {
    const observation = {
      accountThreshold: '1',
      credentials: {
        '0': { keys: { '0': { publicKey: FIXTURE_PUBLIC_KEY, scheme: 'Ed25519' as const } }, threshold: '1' },
      },
      sourceBlock: { hash: 'cd'.repeat(32), height: '123', time: '2026-09-24T00:00:00.000Z' },
    };
    const client = new FakeConcordiumClient({
      accountCredentialObservations: { [ADDRESS]: { canonicalAddress: ADDRESS, observation } },
    });

    const result = await syncAccountCredentialsHandler(makeContext(client), { address: ADDRESS });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({ address: ADDRESS, credentialCount: 1, keyCount: 1 });
    expect(loadAccountCredentials(MAINNET_REF)).toEqual({ [ADDRESS]: observation });
  });

  it('records refresh errors when finalized account credentials are unavailable', async () => {
    setAccountCredentialObservation(
      ADDRESS,
      {
        accountThreshold: '1',
        credentials: {
          '0': { keys: { '0': { publicKey: FIXTURE_PUBLIC_KEY, scheme: 'Ed25519' as const } }, threshold: '1' },
        },
        sourceBlock: { hash: 'cd'.repeat(32), height: '123', time: '2026-09-24T00:00:00.000Z' },
      },
      MAINNET_REF,
    );
    const client = new FakeConcordiumClient();

    const result = await syncAccountCredentialsHandler(makeContext(client), { address: ADDRESS });

    expect(result).toMatchObject({
      isError: true,
      structuredContent: { error: { kind: 'invalid-argument' } },
    });

    expect(loadAccountCredentials(MAINNET_REF)).toMatchObject({
      [ADDRESS]: {
        refreshError: {
          kind: 'not_found',
          message: 'Account was not found.',
        },
      },
    });
  });
});
