import type { AccountCredentialObservation } from '@ccd-agent-kit/config-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { syncAccountCredentialsHandler } from '../../../../src/mcp/accounts/handlers.js';
import { FakeConcordiumClient, makeContext } from '../../../helpers/fakes.js';
import { FIXTURE_PUBLIC_KEY } from '../../../helpers/keys.js';

const writes = vi.hoisted(() => ({
  error: vi.fn(),
  observation: vi.fn(),
}));

vi.mock('@ccd-agent-kit/config-utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ccd-agent-kit/config-utils')>()),
  setAccountCredentialObservation: writes.observation,
  setAccountCredentialRefreshError: writes.error,
}));

const ADDRESS = '3DPgLSmDKt7tvAybE95obMXANrUChv5aBpzGPU3qjaG7ERG6JC';
const CANONICAL_ADDRESS = '3DPgLSmDKt7tvAybE95obMXANrUChv5aBpzGPU3qjaG7ERG6JC';
const MAINNET_REF = '9dd9ca4d19e9393877d2c44b70f89acb';
const OBSERVATION: AccountCredentialObservation = {
  accountThreshold: '1',
  credentials: {
    '0': {
      keys: {
        '0': { publicKey: FIXTURE_PUBLIC_KEY, scheme: 'Ed25519' },
        '1': { publicKey: FIXTURE_PUBLIC_KEY, scheme: 'Ed25519' },
      },
      threshold: '1',
    },
    '2': { keys: { '0': { publicKey: FIXTURE_PUBLIC_KEY, scheme: 'Ed25519' } }, threshold: '1' },
  },
  sourceBlock: { hash: 'cd'.repeat(32), height: '123', time: '2026-09-24T00:00:00.000Z' },
};

describe('syncAccountCredentialsHandler', () => {
  beforeEach(() => vi.clearAllMocks());

  it('forwards the account and projects credential counts from the finalized observation', async () => {
    const client = new (class extends FakeConcordiumClient {
      requestedAddress?: string;

      override async getFinalizedAccountCredentials(address: string) {
        this.requestedAddress = address;
        return { canonicalAddress: CANONICAL_ADDRESS, observation: OBSERVATION };
      }
    })();

    const result = await syncAccountCredentialsHandler(makeContext(client), { address: ADDRESS });

    expect(client.requestedAddress).toBe(ADDRESS);
    expect(writes.observation).toHaveBeenCalledWith(CANONICAL_ADDRESS, OBSERVATION, MAINNET_REF);
    expect(result.structuredContent).toEqual({
      address: CANONICAL_ADDRESS,
      credentialCount: 2,
      keyCount: 3,
      network: 'mainnet',
      sourceBlock: OBSERVATION.sourceBlock,
    });
  });

  it('records a stable classified refresh error and returns the original typed tool error', async () => {
    const nodeError = { kind: 'node' as const, message: 'private node detail' };
    const client = new (class extends FakeConcordiumClient {
      override async getFinalizedAccountCredentials(): Promise<never> {
        throw nodeError;
      }
    })();

    const result = await syncAccountCredentialsHandler(makeContext(client), { address: ADDRESS });

    expect(writes.error).toHaveBeenCalledWith(
      ADDRESS,
      expect.objectContaining({ kind: 'node', message: 'Account credential refresh failed at the node.' }),
      MAINNET_REF,
    );
    expect(writes.observation).not.toHaveBeenCalled();
    expect(result).toMatchObject({ isError: true, structuredContent: { error: nodeError } });
  });
});
