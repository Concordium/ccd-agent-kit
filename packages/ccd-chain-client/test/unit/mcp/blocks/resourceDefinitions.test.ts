import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TransactionKindString } from '@concordium/web-sdk';
import type { BlockTransactionEventsDTO, TransactionEffectsDTO } from '../../../../src/concordium/dto.js';
import { blockResourceFamilies } from '../../../../src/mcp/blocks/resourceDefinitions.js';
import { readDomainResource } from '../../../helpers/domainResources.js';
import { FakeConcordiumClient, makeContext } from '../../../helpers/fakes.js';

const mocks = vi.hoisted(() => ({
  parseBlockReference: vi.fn((value: string) => ({ type: 'hash', hash: value })),
}));

vi.mock('../../../../src/mcp/toolPlumbing/toolSchemas.js', () => ({ parseBlockReference: mocks.parseBlockReference }));

describe('blockResourceFamilies', () => {
  beforeEach(() => vi.clearAllMocks());

  it('projects numeric block heights without invoking the general reference parser', async () => {
    const block = {
      hash: 'hash',
      height: '12',
      slotTime: '2026-01-01T00:00:00.000Z',
      era: 0,
      transactionsCount: '0',
      finalized: true,
    };
    const client = new FakeConcordiumClient({ blocks: { '0:12': block } });
    const getBlockInfo = vi.spyOn(client, 'getBlockInfo');
    const ctx = makeContext(client);

    await expect(readDomainResource(blockResourceFamilies(), 'block', ctx, {
      parameters: { id: '12' },
    })).resolves.toEqual(block);
    expect(getBlockInfo).toHaveBeenCalledWith({ type: 'height', height: 12n });
    expect(mocks.parseBlockReference).not.toHaveBeenCalled();
  });

  it('parses block references and forwards the client event DTO unchanged', async () => {
    const events = {
      hash: 'block',
      height: '12',
      events: [
        {
          type: 'accountTransaction',
          summary: {
            transactionType: TransactionKindString.TokenUpdate,
            sender: 'sender',
            cost: '1',
            energyCost: '2',
            hash: 'transaction',
            index: '3',
            tokenEvents: [{ type: 'extension', __type: 'v2' }],
          },
        },
      ],
    } satisfies BlockTransactionEventsDTO;
    const client = new FakeConcordiumClient({
      blocks: {
        deadbeef: {
          hash: 'block',
          height: '12',
          slotTime: '2026-01-01T00:00:00.000Z',
          era: 0,
          transactionsCount: '1',
          finalized: true,
        },
      },
    });
    const getBlockTransactionEvents = vi.spyOn(client, 'getBlockTransactionEvents').mockResolvedValue(events);
    const ctx = makeContext(client);

    await expect(readDomainResource(blockResourceFamilies(), 'block-events', ctx, {
      parameters: { id: 'deadbeef' },
    })).resolves.toEqual(events);
    expect(mocks.parseBlockReference).toHaveBeenCalledWith('deadbeef');
    expect(getBlockTransactionEvents).toHaveBeenCalledWith({ type: 'hash', hash: 'deadbeef' });
  });

  it('forwards the client effects DTO and block item unchanged', async () => {
    const effects = {
      transactionHash: 'tx',
      status: 'finalized',
      blockHash: 'block',
      effects: [
        {
          type: 'accountTransaction',
          summary: {
            transactionType: TransactionKindString.TokenUpdate,
            sender: 'sender',
            cost: '1',
            energyCost: '2',
            hash: 'transaction',
            index: '3',
            tokenEvents: [{ type: 'extension', __type: 'v2' }],
          },
        },
      ],
    } satisfies TransactionEffectsDTO;
    const item = { transactionHash: 'tx', status: 'finalized' as const, blockHash: 'block', blockItemHex: '00' };
    const client = new FakeConcordiumClient({ transactionEffects: { tx: effects }, blockItems: { tx: item } });
    const getBlockItem = vi.spyOn(client, 'getBlockItem');
    const ctx = makeContext(client);

    await expect(readDomainResource(blockResourceFamilies(), 'block-item-effects', ctx, {
      parameters: { id: 'tx' },
    })).resolves.toEqual(effects);
    await expect(readDomainResource(blockResourceFamilies(), 'block-item', ctx, {
      network: 'mainnet', parameters: { id: 'tx' },
    })).resolves.toEqual(item);
    expect(getBlockItem).toHaveBeenCalledWith('tx');
  });

});
