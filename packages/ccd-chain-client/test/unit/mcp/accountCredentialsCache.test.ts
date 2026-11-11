import type { AccountCredentialObservation } from '@ccd-agent-kit/config-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  accountVerificationInfoFromObservation,
  getAccountVerificationInfoCacheFirst,
  getCompleteAccountCredentials,
} from '../../../src/mcp/accountCredentialsCache.js';
import { FakeConcordiumClient } from '../../helpers/fakes.js';
import { SENDER, accountInfo, accountObservation, keyPair } from '../../mcp/transactions/internal/helpers.js';

const config = vi.hoisted(() => ({
  get: vi.fn<() => AccountCredentialObservation | undefined>(),
  set: vi.fn(),
}));

vi.mock('@ccd-agent-kit/config-utils', () => ({
  getAccountCredentialObservation: config.get,
  resolveNetwork: () => ({ config: { caip2: 'ccd:9dd9ca4d19e9393877d2c44b70f89acb' } }),
  setAccountCredentialObservation: config.set,
}));

describe('account credential cache decisions', () => {
  beforeEach(() => vi.clearAllMocks());

  it('uses a complete cached observation without a query', async () => {
    const keys = await keyPair('1');
    const observation = accountObservation(keys.verifyKey);
    config.get.mockReturnValue(observation);
    const client = new FakeConcordiumClient();

    await expect(getCompleteAccountCredentials(client, 'mainnet', SENDER)).resolves.toEqual({
      canonicalAddress: SENDER,
      observation,
      source: 'cache',
    });
    expect(client.calls.getFinalizedAccountCredentials ?? 0).toBe(0);
  });

  it('refreshes an incomplete cached observation', async () => {
    const keys = await keyPair('2');
    const observation = accountObservation(keys.verifyKey);
    const incomplete = structuredClone(observation);
    delete incomplete.credentials['0']!.threshold;
    config.get.mockReturnValue(incomplete);
    const client = new FakeConcordiumClient({
      accountCredentialObservations: { [SENDER]: { canonicalAddress: SENDER, observation } },
    });

    await expect(getCompleteAccountCredentials(client, 'mainnet', SENDER)).resolves.toMatchObject({
      source: 'refresh',
    });
    expect(config.set).toHaveBeenCalledWith(SENDER, observation, '9dd9ca4d19e9393877d2c44b70f89acb');
  });

  it('rejects an incomplete refresh without replacing cached state', async () => {
    const keys = await keyPair('7');
    const cached = accountObservation(keys.verifyKey);
    const incomplete = structuredClone(cached) as Partial<typeof cached>;
    delete incomplete.accountThreshold;
    config.get.mockReturnValue(cached);
    const client = new FakeConcordiumClient({
      accountCredentialObservations: {
        [SENDER]: { canonicalAddress: SENDER, observation: incomplete as typeof cached },
      },
    });

    await expect(getCompleteAccountCredentials(client, 'mainnet', SENDER, true)).rejects.toMatchObject({
      kind: 'node',
    });
    expect(client.calls.getFinalizedAccountCredentials).toBe(1);
    expect(config.set).not.toHaveBeenCalled();
  });

  it('force refreshes complete cached observations', async () => {
    const cachedKeys = await keyPair('8');
    const refreshedKeys = await keyPair('9');
    const cached = accountObservation(cachedKeys.verifyKey);
    const refreshed = accountObservation(refreshedKeys.verifyKey);
    config.get.mockReturnValue(cached);
    const client = new FakeConcordiumClient({
      accountCredentialObservations: { [SENDER]: { canonicalAddress: SENDER, observation: refreshed } },
    });

    await expect(getCompleteAccountCredentials(client, 'mainnet', SENDER, true)).resolves.toMatchObject({
      observation: refreshed,
      source: 'refresh',
    });
    expect(config.set).toHaveBeenCalledWith(SENDER, refreshed, '9dd9ca4d19e9393877d2c44b70f89acb');
  });

  it('uses exact chain state for non-finalized block references', async () => {
    const keys = await keyPair('3');
    const info = accountInfo(SENDER, keys.verifyKey);
    const client = new FakeConcordiumClient({ accountVerificationInfos: { [SENDER]: info } });

    await expect(getAccountVerificationInfoCacheFirst(client, 'mainnet', SENDER, { type: 'best' })).resolves.toEqual({
      info,
      source: 'chain',
    });
    expect(config.get).not.toHaveBeenCalled();
  });

  it('rejects observations without verification thresholds', async () => {
    const keys = await keyPair('4');
    const observation = accountObservation(keys.verifyKey);
    delete observation.credentials['0']!.threshold;
    expect(() => accountVerificationInfoFromObservation(SENDER, observation)).toThrowError(
      expect.objectContaining({ kind: 'invalid-argument' }),
    );
  });
});
