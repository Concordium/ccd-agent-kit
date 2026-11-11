import { describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import {
  loadAccountCredentials,
  setAccountCredentialObservation,
  type AccountCredentialObservation,
} from '@ccd-agent-kit/config-utils';
import { buildUpdateCredentialKeys } from '../../../../../src/mcp/transactions/internal/builders.js';
import { FakeConcordiumClient, makeContext } from '../../../../helpers/fakes.js';
import { makeTestTempDir } from '../../../../helpers/tempDir.js';
import { MAINNET_REF, SENDER } from '../../../../mcp/transactions/internal/builders.fixtures.js';
import { CREDENTIAL_PUBLIC_KEY, UPDATED_PUBLIC_KEY } from '../../../../helpers/keys.js';

describe('buildUpdateCredentialKeys', () => {
  const observedCredential: AccountCredentialObservation['credentials'][string] = {
    credentialId: 'ab'.repeat(48),
    threshold: '1',
    keys: { '0': { scheme: 'Ed25519', publicKey: CREDENTIAL_PUBLIC_KEY } },
  };

  function observation(credentials: AccountCredentialObservation['credentials']): AccountCredentialObservation {
    return {
      accountThreshold: '1',
      sourceBlock: { hash: '00'.repeat(32), height: '99', time: '2026-09-25T00:00:00.000Z' },
      credentials: structuredClone(credentials),
    };
  }

  function clientWithObservation(credentials: AccountCredentialObservation['credentials']) {
    return new FakeConcordiumClient({
      sequenceNumbers: { [SENDER]: { sequenceNumber: '5', allFinal: true } },
      signingRequirements: { [SENDER]: { accountThreshold: 1, credentialSignThresholds: [1] } },
      accountCredentialObservations: { [SENDER]: { canonicalAddress: SENDER, observation: observation(credentials) } },
    });
  }

  function withTempConfig<T>(run: () => Promise<T>): Promise<T> {
    const previousConfigHome = process.env.XDG_CONFIG_HOME;
    const previousStateHome = process.env.XDG_STATE_HOME;
    const configHome = makeTestTempDir('ccd-update-credential-keys-');
    process.env.XDG_CONFIG_HOME = configHome;
    process.env.XDG_STATE_HOME = configHome;
    return run().finally(() => {
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
      rmSync(configHome, { recursive: true, force: true });
    });
  }

  it('persists refreshed finalized credentials while building an exact replacement', async () =>
    withTempConfig(async () => {
      const client = clientWithObservation({ '0': observedCredential });

      const result = await buildUpdateCredentialKeys(makeContext(client), {
        sender: SENDER,
        credentialIndex: '0',
        keys: { '0': { scheme: 'Ed25519', publicKey: UPDATED_PUBLIC_KEY } },
        threshold: 1,
      });

      expect(result.transactionHex).toMatch(/^[0-9a-f]+$/);
      expect(result.transactionType).toBe('updateCredentialKeys');
      expect(result.payload).toMatchObject({
        credentialIndex: '0',
        credentialId: 'ab'.repeat(48),
        before: { threshold: '1', keys: { '0': { scheme: 'Ed25519', publicKey: 'cd'.repeat(32) } } },
        after: { threshold: '1', keys: { '0': { scheme: 'Ed25519', publicKey: UPDATED_PUBLIC_KEY } } },
      });
      expect(client.calls.getFinalizedAccountCredentials).toBe(1);
      expect(loadAccountCredentials(MAINNET_REF)[SENDER]?.credentials['0']?.credentialId).toBe('ab'.repeat(48));
    }));

  it('records refresh failure details for an already cached sender observation', async () =>
    withTempConfig(async () => {
      setAccountCredentialObservation(
        SENDER,
        {
          ...observation({ '0': observedCredential }),
          sourceBlock: { hash: '00'.repeat(32), height: '1', time: '2020-01-01T00:00:00.000Z' },
        },
        MAINNET_REF,
      );
      const client = new FakeConcordiumClient({
        sequenceNumbers: { [SENDER]: { sequenceNumber: '5', allFinal: true } },
        signingRequirements: { [SENDER]: { accountThreshold: 1, credentialSignThresholds: [1] } },
      });

      await expect(
        buildUpdateCredentialKeys(makeContext(client), {
          sender: SENDER,
          credentialIndex: '0',
          keys: { '0': { scheme: 'Ed25519', publicKey: UPDATED_PUBLIC_KEY } },
          threshold: 1,
        }),
      ).rejects.toMatchObject({ kind: 'invalid-argument' });

      expect(loadAccountCredentials(MAINNET_REF)[SENDER]?.refreshError).toMatchObject({
        kind: 'not_found',
        message: `Unknown account credentials: ${SENDER}`,
      });
    }));
});
