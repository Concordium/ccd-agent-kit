import { Buffer } from 'node:buffer';

import { describe, expect, it } from 'vitest';

import type { AccountInfoDTO } from '../../../../src/concordium/dto.js';
import { simulateContractHandler } from '../../../../src/mcp/contracts/handlers.js';
import { installAccountLabelsFixture, installContractInstanceLabelsFixture } from '../../../helpers/accountLabels.js';
import { FakeConcordiumClient, makeContext } from '../../../helpers/fakes.js';
import { schemaFunction, schemaMap, schemaOption } from '../../../helpers/schema.js';

const ACCOUNT: AccountInfoDTO = {
  address: '32dZpZpu929J81XPFPbBxhwdig3v18U8KnBTXK3vrwdhUAk1Bp',
  'CCD Balance': { value: '123456789', decimals: 6, display: '123.456789 CCD' },
  sequenceNumber: '5',
  index: '42',
  accountType: 'Account',
  keys: { threshold: 1, credentialCount: 2, credentialIds: ['cred-1', 'cred-2'] },
  PLTs: [],
};

const TYPE_BOOL = Buffer.from([1]);
const MODULE_REF = 'ab'.repeat(32);
const INSTANCE = {
  index: '1',
  subindex: '0',
  moduleRef: MODULE_REF,
  owner: ACCOUNT.address,
  amount: '0',
  name: 'demo',
  methods: ['demo.view', 'demo.update'],
};

function schemaHex(withReceiveOutput: boolean): string {
  const receive = (parameter: Buffer, output: Buffer) =>
    withReceiveOutput ? schemaFunction(2, parameter, output) : schemaFunction(0, parameter);
  const contract = Buffer.concat([
    schemaOption(schemaFunction(0, TYPE_BOOL)),
    schemaMap([
      ['view', receive(TYPE_BOOL, TYPE_BOOL)],
      ['update', withReceiveOutput ? schemaFunction(4, TYPE_BOOL, TYPE_BOOL) : schemaFunction(0, TYPE_BOOL)],
    ]),
    schemaOption(),
  ]);
  return Buffer.concat([Buffer.from([255, 255, 3]), schemaMap([['demo', contract]])]).toString('hex');
}

describe('simulateContractHandler', () => {
  it.each([
    ['return', { tag: 'success', usedEnergy: '100', returnValueHex: 'zz', eventCount: 0 }, 'returnValueJson'],
    [
      'error',
      { tag: 'failure', usedEnergy: '100', reason: '{"tag":"RejectedReceive"}', errorHex: 'zz', eventCount: 0 },
      'errorJson',
    ],
  ] as const)('preserves %s hex when the receive output schema is absent', async (_kind, invoke, decodedKey) => {
    const result = await simulateContractHandler(
      makeContext(
        new FakeConcordiumClient({
          instances: { '1,0': INSTANCE },
          moduleSchemas: { [MODULE_REF]: schemaHex(false) },
          invokes: [invoke],
        }),
      ),
      { contract: '1,0', method: invoke.tag === 'success' ? 'demo.view' : 'demo.update', parameterHex: '00' },
    );

    expect(result.structuredContent).toMatchObject(invoke);
    expect(result.structuredContent).not.toHaveProperty(decodedKey);
  });

  it('preserves return hex when fallback instance discovery fails', async () => {
    const result = await simulateContractHandler(
      makeContext(
        new FakeConcordiumClient({
          invokes: [{ tag: 'success', usedEnergy: '100', returnValueHex: '01', eventCount: 0 }],
        }),
      ),
      { contract: '1,0', method: 'demo.view', parameterHex: '00' },
    );

    expect(result.structuredContent).toMatchObject({ tag: 'success', returnValueHex: '01' });
    expect(result.structuredContent).not.toHaveProperty('returnValueJson');
  });

  it.each([
    ['return value', { tag: 'success', usedEnergy: '100', returnValueHex: 'zz', eventCount: 0 }, 'demo.view'],
    [
      'error',
      { tag: 'failure', usedEnergy: '100', reason: '{"tag":"RejectedReceive"}', errorHex: 'zz', eventCount: 0 },
      'demo.update',
    ],
  ] as const)('rejects malformed %s bytes instead of hiding the decode failure', async (_kind, invoke, method) => {
    await expect(
      simulateContractHandler(
        makeContext(
          new FakeConcordiumClient({
            instances: { '1,0': INSTANCE },
            moduleSchemas: { [MODULE_REF]: schemaHex(true) },
            invokes: [invoke],
          }),
        ),
        { contract: '1,0', method, parameterHex: '00' },
      ),
    ).rejects.toThrow('Invalid hex string');
  });

  it('forwards optional simulation arguments after resolving account labels', async () => {
    const calls: unknown[] = [];
    const client = new FakeConcordiumClient({ invokes: [{ tag: 'success', usedEnergy: '25', eventCount: 0 }] });
    client.simulateContract = async (input) => {
      calls.push(input);
      return { tag: 'success', usedEnergy: '25', eventCount: 0 };
    };
    const restore = installAccountLabelsFixture('4221332d34e1694168c2a0c0b3fd0f27', { invoker: ACCOUNT.address });
    try {
      await simulateContractHandler(makeContext(client, { network: 'testnet' }), {
        contract: '2,1',
        method: 'view',
        parameterHex: '00ff',
        amountMicroCcd: '123',
        energy: '456',
        invoker: 'invoker',
        block: 'best',
        network: 'testnet',
      });

      expect(calls).toEqual([
        {
          contract: { index: 2n, subindex: 1n },
          method: 'view',
          parameterHex: '00ff',
          amountMicroCcd: 123n,
          energy: 456n,
          invoker: ACCOUNT.address,
          block: { type: 'best' },
        },
      ]);
    } finally {
      restore();
    }
  });

  it('treats direct contract labels literally rather than URI-decoding them', async () => {
    const restore = installContractInstanceLabelsFixture('4221332d34e1694168c2a0c0b3fd0f27', {
      'pool-50': { index: '2', subindex: '1' },
    });
    try {
      const calls: unknown[] = [];
      const client = new FakeConcordiumClient({ invokes: [{ tag: 'success', usedEnergy: '25', eventCount: 0 }] });
      client.simulateContract = async (input) => {
        calls.push(input);
        return { tag: 'success', usedEnergy: '25', eventCount: 0 };
      };

      await expect(
        simulateContractHandler(makeContext(client, { network: 'testnet' }), {
          contract: 'pool%2D50',
          method: 'view',
          network: 'testnet',
        }),
      ).rejects.toMatchObject({ kind: 'invalid-argument' });

      expect(calls).toEqual([]);
    } finally {
      restore();
    }
  });
});
