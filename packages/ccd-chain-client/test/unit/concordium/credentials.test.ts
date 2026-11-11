import { describe, expect, it, vi } from 'vitest';
import { BlockHash } from '@concordium/web-sdk';
import { ConcordiumNodeQueries } from '../../../src/concordium/client.js';
import { accountCredential } from '../../helpers/accountCredentials.js';

const address = '4StnMEQCKtfDRuHJfsY6eZL9KJWqdYoqRVRoDSSAz35LsmHcmg';
const finalizedHash = 'ab'.repeat(32);

describe('ConcordiumNodeQueries credential reads', () => {
  it('anchors credential data and source metadata to the same finalized block', async () => {
    const getBlockInfo = vi.fn(async () => ({
      blockHeight: 789n,
      blockSlotTime: new Date('2026-09-25T12:00:00.000Z'),
    }));
    const getAccountInfo = vi.fn(async () => ({
      accountAddress: { address },
      accountThreshold: 1,
      accountCredentials: {
        0: accountCredential('initial', 'aa'.repeat(48), {
          threshold: 1,
          keys: { 0: { schemeId: 'ed25519', verifyKey: '11'.repeat(32) } },
        }),
      },
    }));
    const client = new ConcordiumNodeQueries({
      getConsensusStatus: async () => ({ lastFinalizedBlock: BlockHash.fromHexString(finalizedHash) }),
      getBlockInfo,
      getAccountInfo,
    } as never);
    await expect(client.getFinalizedAccountCredentials(address)).resolves.toEqual({
      canonicalAddress: address,
      observation: {
        accountThreshold: '1',
        credentials: {
          '0': {
            credentialId: 'aa'.repeat(48),
            keys: { '0': { publicKey: '11'.repeat(32), scheme: 'Ed25519' } },
            threshold: '1',
          },
        },
        sourceBlock: { hash: finalizedHash, height: '789', time: '2026-09-25T12:00:00.000Z' },
      },
    });
    expect(getAccountInfo).toHaveBeenCalledWith(expect.anything(), BlockHash.fromHexString(finalizedHash));
    expect(getBlockInfo).toHaveBeenCalledWith(BlockHash.fromHexString(finalizedHash));
  });

  it('reads signing thresholds from both SDK credential kinds', async () => {
    const client = new ConcordiumNodeQueries({
      getAccountInfo: async () => ({
        accountThreshold: 2,
        accountCredentials: {
          0: accountCredential('initial', 'aa'.repeat(48), { threshold: 3, keys: {} }),
          1: accountCredential('normal', 'bb'.repeat(48), { threshold: 4, keys: {} }),
        },
      }),
    } as never);
    await expect(client.getAccountSigningRequirements(address)).resolves.toEqual({
      accountThreshold: 2,
      credentialSignThresholds: [3, 4],
    });
  });
});
