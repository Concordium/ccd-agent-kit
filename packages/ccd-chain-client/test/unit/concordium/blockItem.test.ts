import { describe, expect, it, vi } from 'vitest';
import { ConcordiumNodeQueries } from '../../../src/concordium/client.js';

function asyncItems<T>(items: T[]): AsyncIterable<T> {
  return {
    async *[Symbol.asyncIterator]() {
      yield* items;
    },
  };
}

const transactionHash = 'ab'.repeat(32);
const payload = Uint8Array.from([0xde, 0xad, 0xbe, 0xef]);
const senderBytes = new Uint8Array(32).fill(0x11);
const sponsorBytes = new Uint8Array(32).fill(0x22);
const signatureBytes = Uint8Array.from({ length: 64 }, () => 0xab);
const sponsorSignatureBytes = Uint8Array.from({ length: 64 }, () => 0xcd);
// Golden wire fragments: one credential/key signature, followed by the fixed
// sender/nonce/energy/payload-size/expiry header. Independent of SDK serializers.
const senderSignatureHex = '010001000040' + 'ab'.repeat(64);
const sponsorSignatureHex = '010001000040' + 'cd'.repeat(64);
const headerHex = '11'.repeat(32) + '0000000000000005' + '00000000000000c8' + '00000004' + '0000000000000064';

function envelope(blockItem: Record<string, unknown>, hash = transactionHash) {
  return { hash: { value: Uint8Array.from(Buffer.from(hash, 'hex')) }, blockItem };
}

function finalizedStatus(label = 'block-hash') {
  return {
    status: 'finalized' as const,
    outcome: { blockHash: { buffer: new Uint8Array(32).fill(0x09), toString: () => label } },
  };
}

function queriesWith(items: unknown[], status: unknown = finalizedStatus()) {
  return new ConcordiumNodeQueries({
    getBlockItemStatus: async () => status,
    client: { getBlockItems: () => ({ responses: asyncItems(items) }) },
  } as never);
}

describe('ConcordiumNodeQueries block item reconstruction', () => {
  it('maps received and committed statuses without fetching block item bytes', async () => {
    const getBlockItems = vi.fn(() => ({ responses: asyncItems([]) }));

    const received = new ConcordiumNodeQueries({
      getBlockItemStatus: async () => ({ status: 'received' }),
      client: { getBlockItems },
    } as never);
    await expect(received.getBlockItem(transactionHash)).resolves.toEqual({
      transactionHash,
      status: 'received',
      blockHash: null,
    });

    const committed = new ConcordiumNodeQueries({
      getBlockItemStatus: async () => ({ status: 'committed', outcomes: [] }),
      client: { getBlockItems },
    } as never);
    await expect(committed.getBlockItem(transactionHash)).resolves.toEqual({
      transactionHash,
      status: 'committed',
      blockHash: null,
    });

    expect(getBlockItems).not.toHaveBeenCalled();
  });

  it('reconstructs raw block items byte-for-byte', async () => {
    const client = queriesWith([
      envelope({ oneofKind: 'rawBlockItem', rawBlockItem: Uint8Array.from([0x01, 0x02, 0x03]) }),
    ]);

    await expect(client.getBlockItem(transactionHash)).resolves.toEqual({
      transactionHash,
      status: 'finalized',
      blockHash: 'block-hash',
      blockItemKind: 'rawBlockItem',
      blockItemHex: '010203',
    });
  });

  it('reconstructs credential deployment block item hex from split node fields', async () => {
    const client = queriesWith([
      envelope({
        oneofKind: 'credentialDeployment',
        credentialDeployment: {
          messageExpiry: { value: 0x0102030405060708n },
          payload: { oneofKind: 'rawPayload', rawPayload: Uint8Array.from([0xaa, 0xbb, 0xcc]) },
        },
      }),
    ]);

    await expect(client.getBlockItem(transactionHash)).resolves.toEqual({
      transactionHash,
      status: 'finalized',
      blockHash: 'block-hash',
      blockItemKind: 'credentialDeployment',
      blockItemHex: '010102030405060708aabbcc',
    });
  });

  it('reconstructs account transaction V0 block items from split node fields', async () => {
    const client = queriesWith([
      envelope({
        oneofKind: 'accountTransaction',
        accountTransaction: {
          signature: { signatures: { 0: { signatures: { 0: { value: signatureBytes } } } } },
          header: {
            sender: { value: senderBytes },
            sequenceNumber: { value: 5n },
            energyAmount: { value: 200n },
            expiry: { value: 100n },
          },
          payload: { payload: { oneofKind: 'rawPayload', rawPayload: payload } },
        },
      }),
    ]);

    const result = await client.getBlockItem(transactionHash);
    expect(result.blockItemKind).toBe('accountTransaction');
    expect(result.blockItemHex).toMatch(/^00[0-9a-f]+$/);
    expect(result.blockItemHex?.endsWith(Buffer.from(payload).toString('hex'))).toBe(true);
    expect(result.blockItemHex).toContain('11'.repeat(32));
    expect(result.blockItemHex).toContain('ab'.repeat(64));
    expect(result.blockItemHex).toBe('00' + senderSignatureHex + headerHex + 'deadbeef');
  });

  it('reconstructs account transaction V1 block items without a sponsor', async () => {
    const client = queriesWith([
      envelope({
        oneofKind: 'accountTransactionV1',
        accountTransactionV1: {
          signatures: { senderSignatures: { signatures: { 0: { signatures: { 0: { value: signatureBytes } } } } } },
          header: {
            sender: { value: senderBytes },
            sequenceNumber: { value: 5n },
            energyAmount: { value: 200n },
            expiry: { value: 100n },
          },
          payload: { payload: { oneofKind: 'rawPayload', rawPayload: payload } },
        },
      }),
    ]);

    const result = await client.getBlockItem(transactionHash);
    expect(result.blockItemKind).toBe('accountTransactionV1');
    expect(result.blockItemHex).toMatch(/^03[0-9a-f]+$/);
    expect(result.blockItemHex?.endsWith(Buffer.from(payload).toString('hex'))).toBe(true);
    expect(result.blockItemHex).not.toContain('22'.repeat(32));
    expect(result.blockItemHex).toBe('03' + senderSignatureHex + '00' + '0000' + headerHex + 'deadbeef');
  });

  it('reconstructs account transaction V1 block items with a sponsor', async () => {
    const client = queriesWith([
      envelope({
        oneofKind: 'accountTransactionV1',
        accountTransactionV1: {
          signatures: {
            senderSignatures: { signatures: { 0: { signatures: { 0: { value: signatureBytes } } } } },
            sponsorSignatures: { signatures: { 0: { signatures: { 0: { value: sponsorSignatureBytes } } } } },
          },
          header: {
            sender: { value: senderBytes },
            sequenceNumber: { value: 5n },
            energyAmount: { value: 200n },
            expiry: { value: 100n },
            sponsor: { value: sponsorBytes },
          },
          payload: { payload: { oneofKind: 'rawPayload', rawPayload: payload } },
        },
      }),
    ]);

    const result = await client.getBlockItem(transactionHash);
    expect(result.blockItemKind).toBe('accountTransactionV1');
    expect(result.blockItemHex).toContain('22'.repeat(32));
    expect(result.blockItemHex).toContain('cd'.repeat(64));
    expect(result.blockItemHex).toBe(
      '03' + senderSignatureHex + sponsorSignatureHex + '0001' + headerHex + '22'.repeat(32) + 'deadbeef',
    );
  });

  it('maps update instruction block items without serialized bytes', async () => {
    const client = queriesWith([envelope({ oneofKind: 'updateInstruction' })]);

    await expect(client.getBlockItem(transactionHash)).resolves.toEqual({
      transactionHash,
      status: 'finalized',
      blockHash: 'block-hash',
      blockItemKind: 'updateInstruction',
    });
  });

  it('skips node stream items that do not match the requested transaction hash', async () => {
    const client = queriesWith([
      envelope({ oneofKind: 'rawBlockItem', rawBlockItem: Uint8Array.from([0xff]) }, 'cd'.repeat(32)),
      envelope({ oneofKind: 'rawBlockItem', rawBlockItem: Uint8Array.from([0x01, 0x02]) }),
    ]);

    await expect(client.getBlockItem(transactionHash)).resolves.toMatchObject({
      blockItemKind: 'rawBlockItem',
      blockItemHex: '0102',
    });
  });

  it('reconstructs block items for committed outcomes', async () => {
    const status = {
      status: 'committed',
      outcomes: [{ blockHash: { buffer: new Uint8Array(32), toString: () => 'committed-block' } }],
    };
    const client = queriesWith(
      [envelope({ oneofKind: 'rawBlockItem', rawBlockItem: Uint8Array.from([0x0a]) })],
      status,
    );

    await expect(client.getBlockItem(transactionHash)).resolves.toMatchObject({
      status: 'committed',
      blockHash: 'committed-block',
      blockItemKind: 'rawBlockItem',
      blockItemHex: '0a',
    });
  });

  it('skips node stream items that do not match the requested transaction hash before reporting absence', async () => {
    const client = queriesWith([
      envelope({ oneofKind: 'rawBlockItem', rawBlockItem: Uint8Array.from([0xff]) }, 'cd'.repeat(32)),
    ]);

    await expect(client.getBlockItem(transactionHash)).rejects.toMatchObject({
      kind: 'node',
      message: 'Concordium node request failed.',
    });
  });

  it('reports unsupported block item kinds from the node stream', async () => {
    const client = queriesWith([envelope({ oneofKind: 'someFutureKind' })]);

    await expect(client.getBlockItem(transactionHash)).rejects.toMatchObject({
      kind: 'node',
      message: 'Concordium node request failed.',
    });
  });

  it('reports an undefined block item kind from the node stream', async () => {
    const client = queriesWith([envelope({})]);

    await expect(client.getBlockItem(transactionHash)).rejects.toMatchObject({
      kind: 'node',
      message: 'Concordium node request failed.',
    });
  });

  const missingFieldCases: Array<{ name: string; blockItem: Record<string, unknown> }> = [
    {
      name: 'raw block item without bytes',
      blockItem: { oneofKind: 'rawBlockItem' },
    },
    {
      name: 'account transaction without a payload object',
      blockItem: { oneofKind: 'accountTransaction' },
    },
    {
      name: 'account transaction without header or signature',
      blockItem: {
        oneofKind: 'accountTransaction',
        accountTransaction: {
          payload: { payload: { oneofKind: 'rawPayload', rawPayload: payload } },
        },
      },
    },
    {
      name: 'account transaction V1 without sender signatures',
      blockItem: {
        oneofKind: 'accountTransactionV1',
        accountTransactionV1: {
          signatures: {},
          header: {},
          payload: { payload: { oneofKind: 'rawPayload', rawPayload: payload } },
        },
      },
    },
    {
      name: 'credential deployment without message expiry',
      blockItem: {
        oneofKind: 'credentialDeployment',
        credentialDeployment: {
          payload: { oneofKind: 'rawPayload', rawPayload: payload },
        },
      },
    },
  ];

  it.each(missingFieldCases)('reports a safe node error for $name', async ({ blockItem }) => {
    const client = queriesWith([envelope(blockItem)]);

    await expect(client.getBlockItem(transactionHash)).rejects.toMatchObject({
      kind: 'node',
      message: 'Concordium node request failed.',
    });
  });
});

describe('ConcordiumNodeQueries block item submission', () => {
  it('submits serialized block item hex through the low-level client', async () => {
    const sendBlockItem = vi.fn<(input: unknown) => { response: Promise<{ value: Uint8Array }> }>(() => ({
      response: Promise.resolve({ value: Uint8Array.from([0xbe, 0xef]) }),
    }));
    const client = new ConcordiumNodeQueries({ client: { sendBlockItem } } as never);

    await expect(client.submitBlockItem('0102')).resolves.toBe('beef');

    expect(sendBlockItem).toHaveBeenCalledTimes(1);
    const input = sendBlockItem.mock.calls[0]?.[0] as {
      blockItem: { oneofKind: string; rawBlockItem: Uint8Array };
    };
    expect(input.blockItem.oneofKind).toBe('rawBlockItem');
    expect(Array.from(input.blockItem.rawBlockItem)).toEqual([0x01, 0x02]);
  });

  it('wraps low-level submit failures as node errors', async () => {
    const client = new ConcordiumNodeQueries({
      client: {
        sendBlockItem: () => ({
          response: Promise.reject(Object.assign(new Error('submit failed'), { code: 13 })),
        }),
      },
    } as never);

    await expect(client.submitBlockItem('00')).rejects.toMatchObject({
      kind: 'node',
      message: 'Concordium node request failed.',
      code: 13,
    });
  });
});
