import { getAccountCredentialObservation, setAccountCredentialObservation } from '@ccd-agent-kit/config-utils';
import { rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getCompleteAccountCredentials } from '../../../src/mcp/accountCredentialsCache.js';
import { FakeConcordiumClient } from '../../helpers/fakes.js';
import { makeTestTempDir } from '../../helpers/tempDir.js';
import { MAINNET_REF, SENDER, accountObservation, keyPair } from '../../mcp/transactions/internal/helpers.js';

describe('accountCredentialsCache', () => {
  let stateHome: string;
  let previousStateHome: string | undefined;

  beforeEach(() => {
    previousStateHome = process.env.XDG_STATE_HOME;
    stateHome = makeTestTempDir('account-credentials-cache-');
    process.env.XDG_STATE_HOME = stateHome;
  });

  afterEach(() => {
    if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previousStateHome;
    rmSync(stateHome, { recursive: true, force: true });
  });

  it('stores typed refreshed account credential observations', async () => {
    const keys = await keyPair('4');
    const observation = accountObservation(keys.verifyKey);
    const client = new FakeConcordiumClient({
      accountCredentialObservations: {
        [SENDER]: {
          canonicalAddress: SENDER,
          observation,
        },
      },
    });

    await expect(getCompleteAccountCredentials(client, 'mainnet', SENDER, true)).resolves.toMatchObject({
      canonicalAddress: SENDER,
      observation,
      source: 'refresh',
    });
    expect(getAccountCredentialObservation(SENDER, MAINNET_REF)).toEqual(observation);
  });

  it('preserves cached state when a forced refresh is incomplete', async () => {
    const keys = await keyPair('5');
    const cached = accountObservation(keys.verifyKey);
    const incomplete = structuredClone(cached);
    delete incomplete.credentials['0']!.threshold;
    setAccountCredentialObservation(SENDER, cached, MAINNET_REF);
    const client = new FakeConcordiumClient({
      accountCredentialObservations: {
        [SENDER]: { canonicalAddress: SENDER, observation: incomplete },
      },
    });

    await expect(getCompleteAccountCredentials(client, 'mainnet', SENDER, true)).rejects.toMatchObject({
      kind: 'node',
    });
    expect(getAccountCredentialObservation(SENDER, MAINNET_REF)).toEqual(cached);
  });
});
