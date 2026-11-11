import { describe, expect, it } from 'vitest';
import { Cbor } from '@concordium/web-sdk';
import { ConcordiumNodeQueries } from '../../src/concordium/client.js';
import { sdkLockInfo } from '../helpers/sdkFixtures.js';

describe('ConcordiumNodeQueries lock decoding', () => {
  const address = '32dZpZpu929J81XPFPbBxhwdig3v18U8KnBTXK3vrwdhUAk1Bp';
  it('decodes node CBOR before applying the unit-owned lock serializer', async () => {
    const raw = sdkLockInfo(address, Uint8Array.from([0xaa, 0xbb]));
    const client = new ConcordiumNodeQueries({ getLockInfo: async () => ({ lockInfo: Cbor.encode(raw) }) } as never);
    await expect(client.getLockInfo(raw.lock.toString())).resolves.toMatchObject({
      lockId: raw.lock.toString(),
      recipients: [address],
      memoHex: 'aabb',
    });
  });
});
