import { BlockHash, ReturnValue, type ContractContext } from '@concordium/web-sdk';
import { describe, expect, it, vi } from 'vitest';
import { ConcordiumNodeQueries } from '../../../src/concordium/client.js';

const accountAddress = '4StnMEQCKtfDRuHJfsY6eZL9KJWqdYoqRVRoDSSAz35LsmHcmg';

function invocation(result: unknown, finalizedHash?: string) {
  const invokeContract = vi.fn<(context: ContractContext, blockHash?: unknown) => Promise<unknown>>().mockResolvedValue(result);
  const client = new ConcordiumNodeQueries({
    invokeContract,
    getConsensusStatus: async () => ({
      lastFinalizedBlock: finalizedHash === undefined ? undefined : BlockHash.fromHexString(finalizedHash),
    }),
  } as never);
  return { client, invokeContract };
}

describe('ConcordiumNodeQueries contract context', () => {
  it('builds a default simulation context and maps successful results', async () => {
    const { client, invokeContract } = invocation({
      tag: 'success', usedEnergy: 500n, returnValue: ReturnValue.fromHexString('010203'), events: [{}, {}],
    });

    const result = await client.simulateContract({
      contract: { index: 1n, subindex: 2n },
      method: 'CIS2.transfer',
    });

    expect(result).toMatchObject({ tag: 'success', usedEnergy: '500', returnValueHex: '010203', eventCount: 2 });
    const [context, blockHash] = invokeContract.mock.calls[0]!;
    expect(blockHash).toBeUndefined();
    expect(context.contract.index).toBe(1n);
    expect(context.contract.subindex).toBe(2n);
    expect(String(context.method)).toBe('CIS2.transfer');
    expect(Buffer.from(context.parameter!.buffer).toString('hex')).toBe('');
    expect(context.amount).toBeUndefined();
    expect(context.energy).toBeUndefined();
    expect(context.invoker).toBeUndefined();
  });

  it('forwards explicit simulation arguments and resolves a block reference', async () => {
    const blockHashHex = 'ef'.repeat(32);
    const { client, invokeContract } = invocation({ tag: 'success', usedEnergy: 1n }, blockHashHex);

    await client.simulateContract({
      contract: { index: 3n, subindex: 1n },
      method: 'demo.update',
      parameterHex: 'aabb',
      amountMicroCcd: 42n,
      energy: 7n,
      invoker: accountAddress,
      block: { type: 'last_final' },
    });

    const [context, blockHash] = invokeContract.mock.calls[0]!;
    expect(String(blockHash)).toBe(blockHashHex);
    expect(Buffer.from(context.parameter!.buffer).toString('hex')).toBe('aabb');
    expect(context.amount?.microCcdAmount).toBe(42n);
    expect(context.energy?.value).toBe(7n);
    expect(context.invoker).toMatchObject({ address: accountAddress });
  });

  it('maps failed simulation results through the invocation DTO', async () => {
    const { client } = invocation({
      tag: 'failure', usedEnergy: 100n, reason: { tag: 'RejectedReceive', rejectReason: 42 },
      returnValue: ReturnValue.fromHexString('040506'),
    });

    const result = await client.simulateContract({
      contract: { index: 1n, subindex: 0n },
      method: 'demo.fail',
    });

    expect(result).toMatchObject({ tag: 'failure', usedEnergy: '100', errorHex: '040506' });
    expect(result.reason).toBeTruthy();
  });

  it('estimates contract update execution energy with an invoker and no gas override', async () => {
    const { client, invokeContract } = invocation({ tag: 'success', usedEnergy: { value: 12345n } });

    await expect(
      client.estimateContractUpdateExecutionEnergy({
        contract: { index: 1n, subindex: 2n },
        method: 'demo.receive',
        parameterHex: 'abcd',
        amountMicroCcd: 42n,
        invoker: accountAddress,
      }),
    ).resolves.toBe(12345n);

    const [context, blockHash] = invokeContract.mock.calls[0]!;
    expect(blockHash).toBeUndefined();
    expect(String(context.method)).toBe('demo.receive');
    expect(Buffer.from(context.parameter!.buffer).toString('hex')).toBe('abcd');
    expect(context.amount?.microCcdAmount).toBe(42n);
    expect(context.energy).toBeUndefined();
    expect(context.invoker).toMatchObject({ address: accountAddress });
  });

  it.each([
    ['with a reason', { tag: 'failure', reason: { tag: 'RejectedReceive', rejectReason: 42 } },
      expect.stringContaining('Contract update simulation failed')],
    ['without a reason', { tag: 'failure', usedEnergy: 0n }, 'Contract update simulation failed.'],
  ])('reports failed energy simulations %s as invalid arguments', async (_name, result, message) => {
    const { client } = invocation(result);

    await expect(
      client.estimateContractUpdateExecutionEnergy({
        contract: { index: 1n, subindex: 0n },
        method: 'demo.receive',
        invoker: accountAddress,
      }),
    ).rejects.toMatchObject({
      kind: 'invalid-argument',
      message,
    });
  });
});
