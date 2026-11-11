import { describe, expect, it, vi } from 'vitest';
import { guard } from '../../../../src/concordium/errors.js';
import { accountResourceFamilies } from '../../../../src/mcp/accounts/resourceDefinitions.js';
import { blockResourceFamilies } from '../../../../src/mcp/blocks/resourceDefinitions.js';
import { contractResourceFamilies } from '../../../../src/mcp/contracts/resourceDefinitions.js';
import { lockResourceFamilies } from '../../../../src/mcp/locks/resourceDefinitions.js';
import {
  createChainNetworkResourceCatalog,
  readRequiredChainResource,
} from '../../../../src/mcp/resourcePlumbing/networkResources.js';
import { stakingResourceFamilies } from '../../../../src/mcp/staking/resourceDefinitions.js';
import { pltResourceFamilies } from '../../../../src/mcp/tokens/resourceDefinitions.js';
import { readDomainResource } from '../../../helpers/domainResources.js';
import { FakeConcordiumClient, makeContext } from '../../../helpers/fakes.js';
import { useTestXdg, useUnsetEnv } from '../../../helpers/xdg.js';

const ADDRESS = '32dZpZpu929J81XPFPbBxhwdig3v18U8KnBTXK3vrwdhUAk1Bp';
const HASH = '11'.repeat(32);

useTestXdg('network-resource-errors-', ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME']);
useUnsetEnv('CCD_NETWORK');

const missingCases = [
  ['account', 'account', accountResourceFamilies, { account: ADDRESS },
    (client: FakeConcordiumClient) => vi.spyOn(client, 'getAccountInfo')],
  ['block item', 'block-item', blockResourceFamilies, { id: HASH },
    (client: FakeConcordiumClient) => vi.spyOn(client, 'getBlockItem')],
  ['effects', 'block-item-effects', blockResourceFamilies, { id: HASH },
    (client: FakeConcordiumClient) => vi.spyOn(client, 'getTransactionEffects')],
  ['contract instance', 'contract-instance', contractResourceFamilies, { addressOrLabel: '0,0' },
    (client: FakeConcordiumClient) => vi.spyOn(client, 'getInstanceInfo')],
  ['module', 'module', contractResourceFamilies, { moduleRef: HASH },
    (client: FakeConcordiumClient) => vi.spyOn(client, 'getModuleInterface')],
  ['lock', 'lock', lockResourceFamilies, { lockId: 'missing' },
    (client: FakeConcordiumClient) => vi.spyOn(client, 'getLockInfo')],
  ['pool', 'pool-delegation', stakingResourceFamilies, { poolId: '42' },
    (client: FakeConcordiumClient) => vi.spyOn(client, 'getPoolInfo')],
  ['token', 'plt', pltResourceFamilies, { tokenId: 'MISSING' },
    (client: FakeConcordiumClient) => vi.spyOn(client, 'getTokenInfo')],
] as const;

function reader(
  families: () => ReturnType<typeof accountResourceFamilies>,
  familyName: string,
  client: FakeConcordiumClient,
  parameters: Readonly<Record<string, string>>,
) {
  return readDomainResource(families(), familyName, makeContext(client), { network: 'mainnet', parameters });
}

describe('chain network resource errors', () => {
  it('translates chain-domain failures at the shared resource adapter boundary', async () => {
    const cases: Array<[unknown, string, string]> = [
      [{ kind: 'node', code: 5, message: 'Missing chain value.' }, 'RESOURCE_NOT_FOUND', 'Missing chain value.'],
      [{ kind: 'node', code: 14, message: 'Node unavailable.' }, 'NODE_REQUEST_FAILED', 'Node unavailable.'],
      [{ kind: 'invalid-argument', message: 'Invalid chain selector.' }, 'RESOURCE_READ_FAILED', 'Invalid chain selector.'],
      [{ kind: 'chain-capability', message: 'Capability unavailable.' }, 'RESOURCE_READ_FAILED', 'Capability unavailable.'],
      [new Error('private /Users/operator/state'), 'RESOURCE_READ_FAILED', 'The resource could not be read.'],
      ['private primitive', 'RESOURCE_READ_FAILED', 'The resource could not be read.'],
    ];
    let failure: unknown;
    const resource = createChainNetworkResourceCatalog(makeContext(new FakeConcordiumClient()), [{
      name: 'probe', title: 'Probe', description: 'Probe.', path: 'probe',
      read: async () => { throw failure; },
    }])[0]!;

    for (const [thrown, code, message] of cases) {
      failure = thrown;
      const caught = await Promise.resolve().then(() => resource.read('ccd://probe')).catch((error: unknown) => error);
      expect(caught).toMatchObject({ code, message });
      if (String(thrown).includes('private')) expect(JSON.stringify(caught)).not.toContain('private');
    }
  });

  it.each(missingCases)(
    'classifies a missing %s domain response as not found',
    async (_name, familyName, families, parameters, spy) => {
      const client = new FakeConcordiumClient();
      spy(client).mockRejectedValue({ kind: 'invalid-argument', message: 'The selected resource does not exist.' });

      await expect(reader(families, familyName, client, parameters))
        .rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    },
  );

  it('classifies a missing account node response as not found', async () => {
    const client = new FakeConcordiumClient();
    vi.spyOn(client, 'getAccountInfo').mockImplementation(() =>
      guard<never>(async () => {
        throw Object.assign(new Error('private node detail'), { code: 5 });
      }),
    );

    await expect(reader(accountResourceFamilies, 'account', client, { account: ADDRESS }))
      .rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
  });

  it('preserves unexpected chain failures for the public adapter to sanitize', async () => {
    const failure = new Error('node transport unavailable');

    await expect(readRequiredChainResource(async () => { throw failure; })).rejects.toBe(failure);
  });
});
