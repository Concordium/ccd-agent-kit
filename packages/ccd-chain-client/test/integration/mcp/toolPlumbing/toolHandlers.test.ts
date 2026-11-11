import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { getCis2TokenBalanceHandler } from '../../../../src/mcp/tokens/handlers.js';
import { simulateContractHandler } from '../../../../src/mcp/contracts/handlers.js';
import { schemaFunction, schemaMap, schemaOption } from '../../../helpers/schema.js';
import { installContractInstanceLabelsFixture } from '../../../helpers/accountLabels.js';
import { FakeConcordiumClient, makeContext } from '../../../helpers/fakes.js';

const ACCOUNT = '32dZpZpu929J81XPFPbBxhwdig3v18U8KnBTXK3vrwdhUAk1Bp';
const MODULE_REF = 'ab'.repeat(32);
const INSTANCE = {
  index: '1',
  subindex: '0',
  moduleRef: MODULE_REF,
  owner: ACCOUNT,
  amount: '0',
  name: 'demo',
  methods: ['demo.view'],
};

function fixtureSchemaHex(): string {
  const bool = Buffer.from([1]);
  const contract = Buffer.concat([
    schemaOption(schemaFunction(0, bool)),
    schemaMap([['view', schemaFunction(2, bool, bool)]]),
    schemaOption(),
  ]);
  return Buffer.concat([Buffer.from([255, 255, 3]), schemaMap([['demo', contract]])]).toString('hex');
}

describe('tool handler integration', () => {
  it('serializes contract JSON parameters and decodes the typed return value', async () => {
    const calls: unknown[] = [];
    const client = new FakeConcordiumClient({
      instances: { '1,0': INSTANCE },
      moduleSchemas: { [MODULE_REF]: fixtureSchemaHex() },
    });
    client.simulateContract = async (param) => {
      calls.push(param);
      return { tag: 'success', usedEnergy: '100', returnValueHex: '01', eventCount: 0 };
    };

    const result = await simulateContractHandler(makeContext(client), {
      contract: '1,0',
      method: 'demo.view',
      parameterJson: false,
    });

    expect(calls).toEqual([expect.objectContaining({ parameterHex: '00' })]);
    expect(result.structuredContent).toMatchObject({ tag: 'success', returnValueHex: '01', returnValueJson: true });
    expect(JSON.parse(result.content[0]?.type === 'text' ? result.content[0].text : '')).toEqual(
      result.structuredContent,
    );
  });

  it('resolves a configured contract label before a CIS-2 query', async () => {
    const restore = installContractInstanceLabelsFixture('4221332d34e1694168c2a0c0b3fd0f27', {
      tokenContract: { index: '1', subindex: '0' },
    });
    try {
      const client = new FakeConcordiumClient({
        cis2Balances: {
          [`1,0:token-x:${ACCOUNT}`]: {
            contractIndex: '1',
            contractSubindex: '0',
            tokenId: 'token-x',
            address: ACCOUNT,
            balance: '999',
          },
        },
      });

      const result = await getCis2TokenBalanceHandler(makeContext(client, { network: 'testnet' }), {
        contract: 'tokenContract',
        tokenId: 'token-x',
        address: ACCOUNT,
        network: 'testnet',
      });

      expect(result.isError).toBeUndefined();
      expect(result.structuredContent).toEqual({
        contractIndex: '1',
        contractSubindex: '0',
        tokenId: 'token-x',
        address: ACCOUNT,
        balance: '999',
      });
    } finally {
      restore();
    }
  });
});
