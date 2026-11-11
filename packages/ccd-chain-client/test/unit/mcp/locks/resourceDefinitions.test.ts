import { describe, expect, it, vi } from 'vitest';
import type { LockInfoDTO } from '../../../../src/concordium/dto.js';
import { lockResourceFamilies } from '../../../../src/mcp/locks/resourceDefinitions.js';
import { domainFamily, readDomainResource } from '../../../helpers/domainResources.js';
import { FakeConcordiumClient, makeContext } from '../../../helpers/fakes.js';

describe('lock resource definitions', () => {
  it('makes list and read capability decisions before lock queries', async () => {
    const client = new FakeConcordiumClient({ protocolVersion: 10, lockList: ['lock-1'] });
    const getLockList = vi.spyOn(client, 'getLockList');
    const getLockInfo = vi.spyOn(client, 'getLockInfo');
    const ctx = makeContext(client);

    await expect(domainFamily(lockResourceFamilies(), 'lock').listDefault?.(ctx)).resolves.toEqual([]);
    await expect(
      readDomainResource(lockResourceFamilies(), 'lock', ctx, {
        network: 'testnet', parameters: { lockId: 'lock-1' },
      }),
    ).rejects.toMatchObject({
      kind: 'chain-capability',
      capability: 'lock.info',
      network: 'testnet',
    });
    await expect(readDomainResource(lockResourceFamilies(), 'locks', ctx)).rejects.toMatchObject({
      kind: 'chain-capability',
      capability: 'lock.list',
      network: 'mainnet',
    });
    expect(getLockList).not.toHaveBeenCalled();
    expect(getLockInfo).not.toHaveBeenCalled();
  });

  it('routes supported network-qualified catalogues to qualified drill-down URIs', async () => {
    const lock = {
      lockId: 'lock-1', creatorAccountIndex: '1', creatorSequenceNumber: '2', creationOrder: '0',
      recipients: 'any', expiryUnixSeconds: '3', expiryTime: '2026-01-01T00:00:03.000Z',
      grants: [], tokenIds: [], funds: [],
    } satisfies LockInfoDTO;
    const ctx = makeContext(new FakeConcordiumClient({
      protocolVersion: 11, lockList: ['lock-1'], lockInfos: { 'lock-1': lock },
    }));
    const body = await readDomainResource(lockResourceFamilies(), 'locks', ctx, { network: 'testnet' });
    expect(body).toEqual({ locks: [{ lockId: 'lock-1', uri: 'ccd://testnet/lock/lock-1' }] });
    await expect(readDomainResource(lockResourceFamilies(), 'lock', ctx, {
      parameters: { lockId: 'lock-1' },
    })).resolves.toEqual(lock);
    await expect(domainFamily(lockResourceFamilies(), 'lock').listDefault?.(ctx)).resolves.toEqual([
      { uri: 'ccd://lock/lock-1', name: 'Concordium Lock lock-1' },
    ]);
  });
});
