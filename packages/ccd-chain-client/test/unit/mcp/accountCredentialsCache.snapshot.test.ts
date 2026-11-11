import {
  addNetwork,
  getAccountCredentialObservation,
  resolveNetwork,
  setAccountCredentialObservation,
  updateNetwork,
  type AccountCredentialObservation,
} from '@ccd-agent-kit/config-utils';
import { caip2Reference } from '@ccd-agent-kit/sdk-utils';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  getAccountVerificationInfoCacheFirst,
  getCompleteAccountCredentials,
} from '../../../src/mcp/accountCredentialsCache.js';
import { FakeConcordiumClient } from '../../helpers/fakes.js';
import { snapshotNetworkConfig } from '../../helpers/networkSnapshot.js';
import { useTestXdg } from '../../helpers/xdg.js';
import { SENDER, accountObservation, keyPair } from '../../mcp/transactions/internal/helpers.js';

describe('account credential cache snapshot routing', () => {
  useTestXdg('account-credentials-snapshot-', ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME']);

  beforeEach(() => {
    addNetwork('localnet', snapshotNetworkConfig('a'));
  });

  function reassignedNetwork() {
    const snapshot = resolveNetwork('localnet');
    updateNetwork('localnet', snapshotNetworkConfig('b'));
    return {
      snapshot,
      oldRef: caip2Reference(snapshot.config.caip2),
      replacementRef: caip2Reference(resolveNetwork('localnet').config.caip2),
    };
  }

  it('reads cached credentials from the resolved snapshot chain', async () => {
    const keys = await keyPair('a');
    const observation = accountObservation(keys.verifyKey);
    const { snapshot, oldRef } = reassignedNetwork();
    setAccountCredentialObservation(SENDER, observation, oldRef);
    const client = new FakeConcordiumClient();

    await expect(getCompleteAccountCredentials(client, snapshot, SENDER)).resolves.toMatchObject({
      observation,
      source: 'cache',
    });
    await expect(getAccountVerificationInfoCacheFirst(client, snapshot, SENDER)).resolves.toMatchObject({
      source: 'cache',
    });
    expect(client.calls.getFinalizedAccountCredentials ?? 0).toBe(0);
  });

  it('writes refreshed credentials only to the resolved snapshot chain', async () => {
    const keys = await keyPair('b');
    const observation: AccountCredentialObservation = accountObservation(keys.verifyKey);
    const { snapshot, oldRef, replacementRef } = reassignedNetwork();
    const client = new FakeConcordiumClient({
      accountCredentialObservations: { [SENDER]: { canonicalAddress: SENDER, observation } },
    });

    await getCompleteAccountCredentials(client, snapshot, SENDER, true);

    expect(getAccountCredentialObservation(SENDER, oldRef)).toEqual(observation);
    expect(getAccountCredentialObservation(SENDER, replacementRef)).toBeUndefined();
  });
});
