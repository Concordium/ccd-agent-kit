import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  loadAccountCredentials,
  resolveNetwork,
  setAccountCredentialObservation,
  type AccountCredentialObservation,
} from '@ccd-agent-kit/config-utils';
import { ed25519PublicKey, type Ed25519PublicKeyHex } from '@ccd-agent-kit/sdk-utils';
import { refreshCachedAccountCredentialsOnStartup } from '../../../src/mcp/startupRefresh.js';
import { createStaticNetworkClientProvider, FakeConcordiumClient } from '../../helpers/fakes.js';
import { UPDATED_PUBLIC_KEY } from '../../helpers/keys.js';
import type { ServerConfig } from '../../../src/config.js';
import type { NetworkClientProvider } from '../../../src/mcp/toolPlumbing/toolTypes.js';
import { makeTestTempDir } from '../../helpers/tempDir.js';

const MAINNET_REF = '9dd9ca4d19e9393877d2c44b70f89acb';
const TESTNET_REF = '4221332d34e1694168c2a0c0b3fd0f27';
const ADDRESS = '4StnMEQCKtfDRuHJfsY6eZL9KJWqdYoqRVRoDSSAz35LsmHcmg';
const OTHER_ADDRESS = '4soVbMFX1vu7evzS4mhLTh1qscPiCgJFztNnHTTKF3yydvKMEm';

function observation(
  time: string,
  publicKey: Ed25519PublicKeyHex = ed25519PublicKey.require('ab'.repeat(32)),
): AccountCredentialObservation {
  return {
    accountThreshold: '1',
    sourceBlock: { hash: '00'.repeat(32), height: '1', time },
    credentials: {
      '0': {
        credentialId: 'cd'.repeat(48),
        threshold: '1',
        keys: { '0': { scheme: 'Ed25519', publicKey } },
      },
    },
  };
}

function config(overrides: Partial<ServerConfig['accountCredentials']['startupRefresh']> = {}): ServerConfig {
  return {
    network: 'mainnet',
    resolvedNetwork: resolveNetwork('mainnet'),
    defaultNetworkSource: 'config',
    grpc: { endpoint: 'grpc.mainnet.concordium.software:20000', tls: true, timeoutMs: 15000 },
    transport: 'stdio',
    accountCredentials: {
      startupRefresh: { enabled: true, maxAgeMs: 86_400_000, failureRetryMs: 300_000, concurrency: 3, ...overrides },
    },
  };
}

describe('refreshCachedAccountCredentialsOnStartup', () => {
  const previousConfigHome = process.env.XDG_CONFIG_HOME;
  const previousStateHome = process.env.XDG_STATE_HOME;
  let root: string;

  beforeEach(() => {
    root = makeTestTempDir('ccd-startup-refresh-');
    process.env.XDG_CONFIG_HOME = join(root, 'config');
    process.env.XDG_STATE_HOME = join(root, 'state');
  });

  afterEach(() => {
    if (previousConfigHome === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = previousConfigHome;
    }
    if (previousStateHome === undefined) {
      delete process.env.XDG_STATE_HOME;
    } else {
      process.env.XDG_STATE_HOME = previousStateHome;
    }
    rmSync(root, { recursive: true, force: true });
  });

  it('refreshes stale cached observations and records successes', async () => {
    setAccountCredentialObservation(ADDRESS, observation('2020-01-01T00:00:00.000Z'), MAINNET_REF);
    const refreshed = observation('2026-09-25T00:00:00.000Z', UPDATED_PUBLIC_KEY);
    const client = new FakeConcordiumClient({
      accountCredentialObservations: { [ADDRESS]: { canonicalAddress: ADDRESS, observation: refreshed } },
    });

    const summary = await refreshCachedAccountCredentialsOnStartup(
      config(),
      createStaticNetworkClientProvider(client, 'mainnet'),
    );

    expect(summary).toEqual({ refreshed: 1, skipped: 0, failed: 0 });
    expect(client.calls.getFinalizedAccountCredentials).toBe(1);
    expect(loadAccountCredentials(MAINNET_REF)[ADDRESS]).toMatchObject(refreshed);
  });

  it('routes each network selector to its client and records sanitized failures', async () => {
    setAccountCredentialObservation(ADDRESS, observation('2020-01-01T00:00:00.000Z'), MAINNET_REF);
    setAccountCredentialObservation(OTHER_ADDRESS, observation('2020-01-01T00:00:00.000Z'), TESTNET_REF);
    const mainnetClient = new FakeConcordiumClient({
      accountCredentialObservations: {
        [ADDRESS]: { canonicalAddress: ADDRESS, observation: observation('2026-09-25T00:00:00.000Z') },
      },
    });
    const testnetClient = new FakeConcordiumClient();
    const selectors: Array<string | undefined> = [];
    const clients: NetworkClientProvider = {
      getClient: (selector) => {
        selectors.push(typeof selector === 'object' ? selector.name : selector);
        return selector === 'testnet'
          ? { client: testnetClient, networkName: 'testnet' }
          : { client: mainnetClient, networkName: 'mainnet' };
      },
    };

    const summary = await refreshCachedAccountCredentialsOnStartup(config(), clients);

    expect(summary).toEqual({ refreshed: 1, skipped: 0, failed: 1 });
    expect(selectors).toEqual(['mainnet', 'testnet']);
    expect(mainnetClient.calls.getFinalizedAccountCredentials).toBe(1);
    expect(testnetClient.calls.getFinalizedAccountCredentials).toBe(1);
    expect(loadAccountCredentials(TESTNET_REF)[OTHER_ADDRESS]?.refreshError).toEqual({
      attempted: expect.any(String),
      kind: 'not_found',
      message: 'Account was not found.',
    });
  });
});
