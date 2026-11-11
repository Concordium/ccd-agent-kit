import { describe, expect, it } from 'vitest';
import { guard, type ConcordiumClientError } from '../../../src/concordium/errors.js';
import type { ChainCapabilityError } from '../../../src/concordium/protocol.js';

describe('guard', () => {
  it('preserves chain-capability error identity', async () => {
    const error = {
      kind: 'chain-capability' as const,
      message: 'Protocol 11 is required',
      capability: 'plt.lock.create',
      network: 'testnet',
    } satisfies ChainCapabilityError;

    const rejection = guard(async () => {
      throw error;
    });

    await expect(rejection).rejects.toBe(error);
  });

  it('preserves invalid-argument error identity', async () => {
    const error = {
      kind: 'invalid-argument',
      message: 'bad account',
    } satisfies ConcordiumClientError;

    const rejection = guard(async () => {
      throw error;
    });

    await expect(rejection).rejects.toBe(error);
  });

  it('preserves the node error code without reflecting its message', async () => {
    const error = Object.assign(new Error('failed at /Users/operator/private/node.json'), { code: 14 });

    const rejection = guard(async () => {
      throw error;
    });

    await expect(rejection).rejects.toEqual({ kind: 'node', message: 'Concordium node request failed.', code: 14 });
  });

  it('wraps a thrown primitive without reflecting it', async () => {
    const rejection = guard(async () => {
      throw 'connection closed';
    });

    await expect(rejection).rejects.toEqual({ kind: 'node', message: 'Concordium node request failed.' });
  });

  it('omits a non-numeric node code without reflecting private fields', async () => {
    const rejection = guard(async () => {
      throw {
        code: '14',
        message: 'failed at /Users/operator/private/node.json',
        details: { token: 'secret' },
      };
    });

    await expect(rejection).rejects.toEqual({ kind: 'node', message: 'Concordium node request failed.' });
  });
});
