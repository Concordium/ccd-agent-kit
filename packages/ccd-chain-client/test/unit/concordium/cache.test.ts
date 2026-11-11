import { describe, expect, it } from 'vitest';
import { ConcordiumNodeQueries } from '../../../src/concordium/client.js';

const accountAddress = '4StnMEQCKtfDRuHJfsY6eZL9KJWqdYoqRVRoDSSAz35LsmHcmg';
const moduleRef = 'ab'.repeat(32);

function rawAccountInfo(amount: bigint = 0n) {
  return {
    accountAddress: { address: accountAddress },
    accountAmount: { microCcdAmount: amount },
    accountNonce: 1n,
    accountIndex: 7n,
    accountThreshold: 1,
    accountCredentials: {},
    accountTokens: [],
    type: 0,
  };
}

describe('ConcordiumNodeQueries caches', () => {
  it('caches stable account identity without caching mutable account state', async () => {
    let calls = 0;
    const client = new ConcordiumNodeQueries({
      getAccountInfo: async () => rawAccountInfo(BigInt(++calls)),
    } as never);

    const first = await client.getAccountInfoByIndex(7n);
    await expect(client.getAccountAddressByIndex(7n)).resolves.toBe(accountAddress);
    expect(calls).toBe(1);
    const second = await client.getAccountInfoByIndex(7n);
    expect(calls).toBe(2);
    expect(second).not.toEqual(first);
  });

  it('learns account identity from address-based reads', async () => {
    let calls = 0;
    const client = new ConcordiumNodeQueries({
      getAccountInfo: async () => {
        calls += 1;
        return rawAccountInfo();
      },
    } as never);

    await client.getAccountInfo(accountAddress);
    await expect(client.getAccountAddressByIndex(7n)).resolves.toBe(accountAddress);
    expect(calls).toBe(1);
  });

  it('deduplicates concurrent module source reads and retries rejected reads', async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const client = new ConcordiumNodeQueries({
      getModuleSource: async () => {
        calls += 1;
        await gate;
        return { version: 1, source: new Uint8Array([0x01]) };
      },
    } as never);

    const first = client.getModuleSource(moduleRef);
    const second = client.getModuleSource(moduleRef);
    expect(calls).toBe(1);
    release();
    await expect(Promise.all([first, second])).resolves.toEqual([
      { moduleRef, version: 1, source: new Uint8Array([0x01]) },
      { moduleRef, version: 1, source: new Uint8Array([0x01]) },
    ]);
    expect(calls).toBe(1);

    let failingCalls = 0;
    const failing = new ConcordiumNodeQueries({
      getModuleSource: async () => {
        failingCalls += 1;
        throw new Error('source unavailable');
      },
    } as never);
    await expect(failing.getModuleSource(moduleRef)).rejects.toMatchObject({ kind: 'node' });
    await expect(failing.getModuleSource(moduleRef)).rejects.toMatchObject({ kind: 'node' });
    expect(failingCalls).toBe(2);
  });

  it('shares source work across cached interface and absent-schema reads', async () => {
    let sourceCalls = 0;
    const client = new ConcordiumNodeQueries({
      getModuleSource: async () => {
        sourceCalls += 1;
        return { version: 1, source: Uint8Array.from(Buffer.from('0061736d01000000', 'hex')) };
      },
    } as never);

    await expect(client.getModuleInterface(moduleRef)).resolves.toMatchObject({
      moduleRef,
      schemaAvailable: false,
      contracts: [],
    });
    await expect(client.getModuleInterface(moduleRef)).resolves.toMatchObject({ moduleRef });
    await expect(client.getModuleSchema(moduleRef)).resolves.toBeUndefined();
    expect(sourceCalls).toBe(1);
  });
});
