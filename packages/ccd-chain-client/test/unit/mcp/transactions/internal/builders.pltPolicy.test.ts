import { AccountAddress } from '@concordium/web-sdk';
import { describe, expect, it, vi } from 'vitest';
import { resolveAccountInput } from '../../../../../src/mcp/accounts/accountLabels.js';
import { buildPlt } from '../../../../../src/mcp/transactions/internal/builders.js';
import type { BuildPltArgs } from '../../../../../src/mcp/transactions/internal/schemas.js';
import { FakeConcordiumClient } from '../../../../helpers/fakes.js';
import { SENDER, TO, makePltContext } from '../../../../mcp/transactions/internal/builders.fixtures.js';

vi.mock('../../../../../src/mcp/accounts/accountLabels.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../../src/mcp/accounts/accountLabels.js')>();
  const administrator = '4soVbMFX1vu7evzS4mhLTh1qscPiCgJFztNnHTTKF3yydvKMEm';
  return {
    ...actual,
    resolveAccountInput: vi.fn((input: string) => (input === 'administrator' ? administrator : input)),
  };
});

describe('PLT protocol transaction mode', () => {
  it('uses tokenUpdate for protocol 10', async () => {
    const result = await buildPlt(makePltContext({ protocolVersion: 10, governanceAccount: SENDER }), {
      sender: SENDER,
      operations: [{ type: 'transfer', tokenId: 'IMT', toAddress: TO, amountUnits: '1000000' }],
    });

    expect(result.transactionType).toBe('tokenUpdate');
  });

  it('uses unscoped tokenUpdate for protocol 11+', async () => {
    const result = await buildPlt(makePltContext({ protocolVersion: 11 }), {
      sender: SENDER,
      operations: [{ type: 'transfer', tokenId: 'IMT', toAddress: TO, amountUnits: '1000000' }],
    });

    expect(result.transactionType).toBe('tokenUpdate');
  });

  it('rejects each protocol 11 lock capability on protocol 10 before token lookup', async () => {
    const cases: Array<[BuildPltArgs['operations'][number], string]> = [
      [
        { type: 'lock_create', recipients: 'any', lockExpiryUnixSeconds: '1787073000', grants: [], tokenIds: ['IMT'] },
        'plt.lock.create',
      ],
      [{ type: 'lock_fund', lockId: 'YGLvYhNvZ9', tokenId: 'IMT', amountUnits: '1' }, 'plt.lock.fund'],
      [
        {
          type: 'lock_send',
          lockId: 'YGLvYhNvZ9',
          tokenId: 'IMT',
          sourceAddress: SENDER,
          toAddress: TO,
          amountUnits: '1',
        },
        'plt.lock.send',
      ],
      [{ type: 'lock_cancel', lockId: 'YGLvYhNvZ9' }, 'plt.lock.cancel'],
      [
        { type: 'lock_release', lockId: 'YGLvYhNvZ9', tokenId: 'IMT', sourceAddress: SENDER, amountUnits: '1' },
        'plt.lock.release',
      ],
    ];

    for (const [operation, capability] of cases) {
      const ctx = makePltContext({ protocolVersion: 10 });
      await expect(buildPlt(ctx, { sender: SENDER, operations: [operation] })).rejects.toMatchObject({
        kind: 'chain-capability',
        capability,
        network: 'mainnet',
      });
      expect((ctx.clients.getClient().client as FakeConcordiumClient).calls.getTokenInfo).toBeUndefined();
    }
  });

  it('rejects protocol 10 multi-token batches before token lookup', async () => {
    const ctx = makePltContext({ protocolVersion: 10, governanceAccount: SENDER });

    await expect(
      buildPlt(ctx, {
        sender: SENDER,
        operations: [
          { type: 'transfer', tokenId: 'IMT', toAddress: TO, amountUnits: '1' },
          { type: 'burn', tokenId: 'tDKK', amountUnits: '1' },
        ],
      }),
    ).rejects.toMatchObject({ kind: 'invalid-argument', message: expect.stringContaining('single token') });
    expect((ctx.clients.getClient().client as FakeConcordiumClient).calls.getTokenInfo).toBeUndefined();
  });
});

describe('protocol 10 PLT governance policy', () => {
  it('rejects non-transfer operations from a sender other than governance', async () => {
    await expect(
      buildPlt(makePltContext({ protocolVersion: 10, governanceAccount: TO }), {
        sender: SENDER,
        operations: [{ type: 'mint', tokenId: 'IMT', amountUnits: '1' }],
      }),
    ).rejects.toMatchObject({
      kind: 'invalid-argument',
      message: expect.stringContaining('to match governance account'),
    });
  });

  it('accepts a sender alias of the governance account', async () => {
    const senderAlias = AccountAddress.getAlias(AccountAddress.fromBase58(SENDER), 1).toString();
    const result = await buildPlt(
      makePltContext({ protocolVersion: 10, governanceAccount: SENDER, senderAddress: senderAlias }),
      {
        sender: senderAlias,
        operations: [{ type: 'mint', tokenId: 'IMT', amountUnits: '1' }],
      },
    );

    expect(result).toMatchObject({ transactionType: 'tokenUpdate', metadata: { sender: senderAlias } });
  });

  it('does not apply governance equality to transfers', async () => {
    const result = await buildPlt(makePltContext({ protocolVersion: 10, governanceAccount: TO }), {
      sender: SENDER,
      operations: [{ type: 'transfer', tokenId: 'IMT', toAddress: TO, amountUnits: '1' }],
    });

    expect(result.transactionType).toBe('tokenUpdate');
  });
});

describe('PLT lookup and sponsorship wiring', () => {
  it('resolves account labels in token operations before mapping the payload', async () => {
    vi.mocked(resolveAccountInput).mockClear();
    const result = await buildPlt(makePltContext({ protocolVersion: 11 }), {
      sender: SENDER,
      operations: [
        {
          type: 'assign_admin_roles',
          tokenId: 'IMT',
          account: 'administrator',
          roles: ['mint'],
        },
      ],
    });

    expect(resolveAccountInput).toHaveBeenCalledWith('administrator', 'mainnet');
    expect(result.payload).toEqual({
      operations: [{ type: 'assign_admin_roles', tokenId: 'IMT', account: TO, roles: ['mint'] }],
    });
  });

  it('performs fresh token lookup for each build', async () => {
    const ctx = makePltContext({ protocolVersion: 11 });
    const args: BuildPltArgs = {
      sender: SENDER,
      operations: [{ type: 'transfer', tokenId: 'IMT', toAddress: TO, amountUnits: '1' }],
    };

    await buildPlt(ctx, args);
    await buildPlt(ctx, args);

    expect((ctx.clients.getClient().client as FakeConcordiumClient).calls.getTokenInfo).toBe(2);
  });

  it('uses default signature requirements for sponsored tokenUpdate transactions', async () => {
    const result = await buildPlt(makePltContext({ protocolVersion: 11 }), {
      sender: SENDER,
      sponsor: TO,
      operations: [{ type: 'transfer', tokenId: 'IMT', toAddress: TO, amountUnits: '1' }],
    });

    expect(result.metadata).toMatchObject({
      sponsor: TO,
      senderNumSignatures: '1',
      sponsorNumSignatures: '2',
      totalSignatureCount: '3',
    });
  });
});
