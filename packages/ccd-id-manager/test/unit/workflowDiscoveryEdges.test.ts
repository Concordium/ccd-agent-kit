import { getAccountAddress } from '@concordium/web-sdk';
import { describe,expect,it,vi } from 'vitest';

import { IdentityHardwareError } from '@ccd-agent-kit/piv-utils';
import { createIdentityWorkflow,IdentityWorkflowError } from '../../src/core/identityWorkflow.js';
import { IdentityProviderError } from '../../src/core/providers/error.js';
import { IdentitySourceError } from '@ccd-agent-kit/config-utils';
import {
  credentialPayload,
  awaitingRecord,
GENESIS_HASH,
IDENTITY_ID,
identityObject,
NETWORK,
NOW_MS,
PUBLIC_KEY,
readyRecord,
requestObject,
selection,
setup,
SOURCE_BLOCK,
SOURCE_ID,
} from '../workflowFixtures.js';

const missing = () => new IdentityWorkflowError('IDENTITY_NOT_FOUND');

describe('identity discovery guarded edges', () => {
  it('forwards the trusted PIN prompt to each operation-bound source agreement', async () => {
    const promptPin = vi.fn(async () => '123456');
    const fixture = setup({ promptPin });
    vi.mocked(fixture.provider.recover).mockRejectedValue(missing());

    await createIdentityWorkflow(fixture.deps).discoverIdentities({
      source: SOURCE_ID, identityProviderIndex: 7, endIndex: 0,
    });

    expect(fixture.sources.createAgreement).toHaveBeenCalledExactlyOnceWith(SOURCE_ID, { promptPin });
  });

  it('returns a partial provider stream when fresh context cannot be loaded', async () => {
    const fixture = setup({
      loadContext: vi.fn(async () => { throw new IdentityProviderError('CONTEXT_MISMATCH'); }),
    });

    const result = await createIdentityWorkflow(fixture.deps).discoverIdentities({ source: SOURCE_ID });

    expect(result.streams[0]).toEqual({
      identityProviderIndex: 7, used: [], reserved: [], unused: [], scannedRange: { start: 0 },
      partial: true, stopReason: 'error', errorCode: 'CONTEXT_MISMATCH',
    });
    expect(fixture.store.listIdentityReservations).not.toHaveBeenCalled();
    expect(fixture.sources.createAgreement).not.toHaveBeenCalled();
  });

  it('returns a partial stream when reservation state cannot be read', async () => {
    const fixture = setup();
    fixture.store.listIdentityReservations.mockRejectedValueOnce(new Error('private storage path'));

    const result = await createIdentityWorkflow(fixture.deps).discoverIdentities({ source: SOURCE_ID });

    expect(result.streams[0]).toEqual({
      identityProviderIndex: 7, used: [], reserved: [], unused: [], scannedRange: { start: 0 },
      partial: true, stopReason: 'error', errorCode: 'STORAGE_FAILED',
    });
    expect(fixture.sources.createAgreement).not.toHaveBeenCalled();
    expect(fixture.provider.recover).not.toHaveBeenCalled();
  });

  it('returns a partial stream when storage lists a record from another network', async () => {
    const fixture = setup();
    fixture.store.list.mockResolvedValue([
      readyRecord({ selection: { ...selection(), network: `ccd:${'34'.repeat(16)}` } }),
    ]);

    const result = await createIdentityWorkflow(fixture.deps).discoverIdentities({
      source: SOURCE_ID, identityProviderIndex: 7, endIndex: 0,
    });

    expect(result.streams[0]).toMatchObject({
      used: [], reserved: [], unused: [], partial: true, stopReason: 'error', errorCode: 'STORAGE_FAILED',
    });
    expect(fixture.provider.recover).not.toHaveBeenCalled();
  });

  it('returns known occupancy without probing when the requested range is fully reserved', async () => {
    const fixture = setup();
    for (const identityIndex of [0, 1, 2]) {
      await fixture.store.reserveIdentityIndex({
        genesisHash: GENESIS_HASH, sourceId: SOURCE_ID, sdkNetwork: 'Testnet',
        identityProviderIndex: 7, identityIndex, mode: identityIndex === 1 ? 'used' : 'explicit',
      });
    }

    const result = await createIdentityWorkflow(fixture.deps).discoverIdentities({
      source: SOURCE_ID, identityProviderIndex: 7, endIndex: 2,
    });

    expect(result.streams[0]).toMatchObject({
      used: [], reserved: [0, 1, 2], unused: [], scannedRange: { start: 3 },
      partial: false, stopReason: 'range',
    });
    expect(fixture.provider.recover).not.toHaveBeenCalled();
  });

  it('validates a known ready identity without overwriting its ciphertext or metadata', async () => {
    const fixture = setup();
    const existing = readyRecord();
    fixture.store.records.set(IDENTITY_ID, existing);
    vi.mocked(fixture.provider.recover)
      .mockRejectedValueOnce(missing())
      .mockRejectedValueOnce(missing())
      .mockResolvedValueOnce(identityObject({
        ...requestObject().value, idCredPub: fixture.recovery.value.idCredPub,
      }));

    const result = await createIdentityWorkflow(fixture.deps).discoverIdentities({
      source: SOURCE_ID, identityProviderIndex: 7, startIndex: 0, endIndex: 2,
    });

    expect(result.streams[0]).toMatchObject({ used: [2], unused: [0, 1], partial: false, stopReason: 'range' });
    expect(fixture.store.reserveIdentityIndex).toHaveBeenCalledWith({
      genesisHash: GENESIS_HASH, sourceId: SOURCE_ID, sdkNetwork: 'Testnet', identityProviderIndex: 7, identityIndex: 2, mode: 'used',
    });
    expect(fixture.store.createIdentity).not.toHaveBeenCalled();
    expect(fixture.store.restoreIdentity).not.toHaveBeenCalled();
    expect(fixture.store.records.get(IDENTITY_ID)).toEqual(existing);
  });

  it('restores missing ciphertext only after validating the remote identity binding', async () => {
    const fixture = setup();
    const existing = { ...awaitingRecord(), status: 'error' as const };
    fixture.store.records.set(IDENTITY_ID, existing);
    fixture.store.loadIdentity.mockRejectedValue(new IdentityWorkflowError('IDENTITY_FILE_MISSING'));
    vi.mocked(fixture.provider.recover)
      .mockRejectedValueOnce(missing())
      .mockRejectedValueOnce(missing())
      .mockResolvedValueOnce(identityObject({
        ...requestObject().value, idCredPub: fixture.recovery.value.idCredPub,
      }));

    const result = await createIdentityWorkflow(fixture.deps).discoverIdentities({
      source: SOURCE_ID, identityProviderIndex: 7, startIndex: 0, endIndex: 2,
    });

    expect(result.streams[0]!.used).toEqual([2]);
    expect(fixture.store.restoreIdentity).toHaveBeenCalledOnce();
    expect(fixture.store.createIdentity).not.toHaveBeenCalled();
    expect(fixture.store.records.get(IDENTITY_ID)).toMatchObject({ status: 'ready', sourceId: SOURCE_ID });
  });

  it('preserves an existing record when ciphertext validation fails unexpectedly', async () => {
    const fixture = setup();
    const existing = readyRecord();
    fixture.store.records.set(IDENTITY_ID, existing);
    fixture.store.loadIdentity.mockRejectedValueOnce(new Error('private encrypted-store failure'));
    vi.mocked(fixture.provider.recover)
      .mockRejectedValueOnce(missing())
      .mockRejectedValueOnce(missing());

    const result = await createIdentityWorkflow(fixture.deps).discoverIdentities({
      source: SOURCE_ID, identityProviderIndex: 7, startIndex: 0, endIndex: 2,
    });

    expect(result.streams[0]).toMatchObject({
      used: [], unused: [0, 1], partial: true, stopReason: 'error', errorCode: 'CRYPTO_FAILED',
    });
    expect(fixture.provider.recover).toHaveBeenCalledTimes(2);
    expect(fixture.store.reserveIdentityIndex).not.toHaveBeenCalled();
    expect(fixture.store.records.get(IDENTITY_ID)).toEqual(existing);
  });

  it('leaves no identity record when used-reservation persistence fails after a remote hit', async () => {
    const fixture = setup();
    vi.mocked(fixture.provider.recover).mockResolvedValue(identityObject({
      ...requestObject().value, idCredPub: fixture.recovery.value.idCredPub,
    }));
    fixture.store.reserveIdentityIndex.mockRejectedValueOnce(new Error('private reservation path'));

    const result = await createIdentityWorkflow(fixture.deps).discoverIdentities({
      source: SOURCE_ID, identityProviderIndex: 7, endIndex: 0,
    });

    expect(result.streams[0]).toMatchObject({
      used: [], unused: [], partial: true, stopReason: 'error', errorCode: 'STORAGE_FAILED',
    });
    expect(fixture.store.createIdentity).not.toHaveBeenCalled();
    expect(fixture.store.records.size).toBe(0);
  });
});

describe('identity allocation guarded edges', () => {
  it('blocks automatic allocation when the selected provider is not enabled', async () => {
    const fixture = setup({ listEnabledProviders: vi.fn(async () => []) });

    await expect(createIdentityWorkflow(fixture.deps).request({
      source: SOURCE_ID, identityProviderIndex: 7,
    })).rejects.toMatchObject({ code: 'PROVIDER_DISABLED' });
    expect(fixture.store.reserveIdentityIndex).not.toHaveBeenCalled();
    expect(fixture.crypto.request).not.toHaveBeenCalled();
  });

  it('maps an indeterminate explicit provider probe to discovery incomplete without reserving', async () => {
    const fixture = setup();
    vi.mocked(fixture.provider.recover).mockRejectedValue(new Error('private provider failure'));

    await expect(createIdentityWorkflow(fixture.deps).request({
      source: SOURCE_ID, identityProviderIndex: 7, identityIndex: 4,
    })).rejects.toMatchObject({ code: 'DISCOVERY_INCOMPLETE' });
    expect(fixture.store.reserveIdentityIndex).not.toHaveBeenCalled();
    expect(fixture.store.records.size).toBe(0);
    expect(fixture.crypto.request).not.toHaveBeenCalled();
  });

  it('blocks automatic allocation when selected-provider discovery is partial', async () => {
    const fixture = setup();
    vi.mocked(fixture.provider.recover).mockRejectedValue(new Error('private provider failure'));

    await expect(createIdentityWorkflow(fixture.deps).request({
      source: SOURCE_ID, identityProviderIndex: 7,
    })).rejects.toMatchObject({ code: 'DISCOVERY_INCOMPLETE' });
    expect(fixture.store.reserveIdentityIndex).not.toHaveBeenCalled();
    expect(fixture.crypto.request).not.toHaveBeenCalled();
  });

  it('preserves source-service failures from an explicit probe', async () => {
    const fixture = setup();
    vi.mocked(fixture.sources.createAgreement).mockRejectedValue(new IdentitySourceError('INVALID_SOURCE'));

    await expect(createIdentityWorkflow(fixture.deps).request({
      source: SOURCE_ID, identityProviderIndex: 7, identityIndex: 4,
    })).rejects.toMatchObject({ code: 'INVALID_SOURCE' });
    expect(fixture.store.reserveIdentityIndex).not.toHaveBeenCalled();
    expect(fixture.provider.recover).not.toHaveBeenCalled();
  });

  it.each([
    ['a ready identity', readyRecord()],
    ['a request pinned to another index', readyRecord({
      status: 'awaiting_verification', identity: undefined,
      selection: { ...selection(), identityIndex: 3 },
    } as never)],
  ])('preserves %s created concurrently after the explicit probe', async (_case, concurrent) => {
    const fixture = setup();
    fixture.store.load
      .mockRejectedValueOnce(new IdentityWorkflowError('IDENTITY_NOT_FOUND'))
      .mockResolvedValueOnce(concurrent);
    vi.mocked(fixture.provider.recover).mockRejectedValue(missing());

    await expect(createIdentityWorkflow(fixture.deps).request({
      source: SOURCE_ID, identityProviderIndex: 7, identityIndex: 2,
    })).rejects.toMatchObject({ code: 'CONTEXT_MISMATCH' });

    expect(fixture.store.save).not.toHaveBeenCalled();
    expect(fixture.store.create).not.toHaveBeenCalled();
  });

});

describe('explicit recovery guarded edges', () => {
  it('rejects invalid recovery input before external effects', async () => {
    const fixture = setup();

    await expect(createIdentityWorkflow(fixture.deps).recover({
      source: SOURCE_ID, identityProviderIndex: 7, identityIndex: undefined,
    } as never)).rejects.toMatchObject({ code: 'INVALID_INPUT' });

    expect(fixture.sources.resolve).not.toHaveBeenCalled();
    expect(fixture.deps.loadContext).not.toHaveBeenCalled();
  });

  it('requires source association for an existing historical identity before provider access', async () => {
    const fixture = setup();
    const historical = readyRecord();
    delete (historical as typeof historical & { sourceId?: string }).sourceId;
    fixture.store.records.set(IDENTITY_ID, historical);

    await expect(createIdentityWorkflow(fixture.deps).recover({
      source: SOURCE_ID, identityProviderIndex: 7, identityIndex: 2,
    })).rejects.toMatchObject({ code: 'SOURCE_NOT_ASSOCIATED' });

    expect(fixture.provider.recover).not.toHaveBeenCalled();
    expect(fixture.store.reserveIdentityIndex).not.toHaveBeenCalled();
  });

  it('reports an unreserved remote miss as identity not found without writes', async () => {
    const fixture = setup();
    vi.mocked(fixture.provider.recover).mockRejectedValue(missing());

    await expect(createIdentityWorkflow(fixture.deps).recover({
      source: SOURCE_ID, identityProviderIndex: 7, identityIndex: 2,
    })).rejects.toMatchObject({ code: 'IDENTITY_NOT_FOUND' });

    expect(fixture.store.reserveIdentityIndex).not.toHaveBeenCalled();
    expect(fixture.store.createIdentity).not.toHaveBeenCalled();
    expect(fixture.store.restoreIdentity).not.toHaveBeenCalled();
  });
});

describe('credential discovery guarded edges', () => {
  it('rejects a non-ready associated identity before decryption or observer creation', async () => {
    const fixture = setup();
    fixture.store.records.set(IDENTITY_ID, readyRecord({ status: 'pending', identity: undefined } as never));

    await expect(createIdentityWorkflow(fixture.deps).discoverAccountCredentials({ identityId: IDENTITY_ID }))
      .rejects.toMatchObject({ code: 'IDENTITY_NOT_READY' });
    expect(fixture.store.loadIdentity).not.toHaveBeenCalled();
    expect(fixture.createAccountObserver).not.toHaveBeenCalled();
  });

  it('rejects a record whose deterministic encrypted file id does not match its handle', async () => {
    const fixture = setup();
    const forgedId = 'ff'.repeat(32);
    fixture.store.records.set(forgedId, readyRecord({ id: forgedId }));

    await expect(createIdentityWorkflow(fixture.deps).discoverAccountCredentials({ identityId: forgedId }))
      .rejects.toMatchObject({ code: 'IDENTITY_MISMATCH' });
    expect(fixture.store.loadIdentity).not.toHaveBeenCalled();
    expect(fixture.createAccountObserver).not.toHaveBeenCalled();
  });

  it('rejects an exhaustive end beyond the decrypted identity allowance', async () => {
    const fixture = setup();
    fixture.store.records.set(IDENTITY_ID, readyRecord());

    await expect(createIdentityWorkflow(fixture.deps).discoverAccountCredentials({
      identityId: IDENTITY_ID, endCredentialNumber: 3,
    })).rejects.toMatchObject({ code: 'CREDENTIAL_LIMIT' });
    expect(fixture.createAccountObserver).not.toHaveBeenCalled();
  });

  it.each(['construction', 'first observation'] as const)(
    'preserves sorted local occupancy when observer %s fails', async (stage) => {
    const fixture = setup();
    const record = readyRecord();
    record.identity!.value.attributeList.maxAccounts = 6;
    fixture.store.records.set(IDENTITY_ID, record);
    fixture.store.credentials.set('11'.repeat(48), { identityId: IDENTITY_ID, credentialNumber: 4, status: 'confirmed' });
    fixture.store.credentials.set('22'.repeat(48), { identityId: IDENTITY_ID, credentialNumber: 1, status: 'confirmed' });
    const failure = new Error('private RPC configuration');
    if (stage === 'construction') fixture.createAccountObserver.mockRejectedValueOnce(failure);
    else fixture.createAccountObserver.mockResolvedValue(vi.fn(async () => { throw failure; }));

    const result = await createIdentityWorkflow(fixture.deps).discoverAccountCredentials({ identityId: IDENTITY_ID });

    expect(result.stream).toMatchObject({
      used: [1, 4], reserved: [], unused: [], partial: true, stopReason: 'error', errorCode: 'NETWORK_FAILED',
    });
    expect(result).not.toHaveProperty('sourceBlock');
    expect(JSON.stringify(result)).not.toContain('private RPC');
    expect([...fixture.store.credentials]).toHaveLength(2);
    },
  );

  it('stops at the identity account limit when the requested gap cannot be reached', async () => {
    const fixture = setup();
    const record = readyRecord();
    record.identity!.value.attributeList.maxAccounts = 2;
    fixture.store.records.set(IDENTITY_ID, record);

    const result = await createIdentityWorkflow(fixture.deps).discoverAccountCredentials({
      identityId: IDENTITY_ID, gapLimit: 3,
    });

    expect(result.stream).toEqual({
      used: [], reserved: [], unused: [0, 1], scannedRange: { start: 0, end: 1 },
      partial: false, stopReason: 'limit',
    });
  });

  it('rejects an account observation whose embedded block differs from captured provenance', async () => {
    const fixture = setup();
    fixture.store.records.set(IDENTITY_ID, readyRecord());
    fixture.createAccountObserver.mockResolvedValue(vi.fn(async () => ({
      exists: true as const,
      canonicalAddress: getAccountAddress(credentialPayload().unsignedCdi.credId).toString(),
      sourceBlock: SOURCE_BLOCK, genesisHash: GENESIS_HASH,
      observation: {
        accountThreshold: '1', credentials: {},
        sourceBlock: { ...SOURCE_BLOCK, hash: 'cd'.repeat(32) },
      },
    })) as never);

    const result = await createIdentityWorkflow(fixture.deps).discoverAccountCredentials({ identityId: IDENTITY_ID });

    expect(result.stream).toMatchObject({
      used: [], unused: [], partial: true, stopReason: 'error', errorCode: 'NETWORK_FAILED',
    });
    expect([...fixture.store.credentials]).toEqual([]);
  });
});

describe('association and account allocation races', () => {
  it('rejects invalid association input before reading protected state', async () => {
    const fixture = setup();

    await expect(createIdentityWorkflow(fixture.deps).associateIdentitySource({
      identityId: '../identity', source: SOURCE_ID, unknown: true,
    } as never)).rejects.toMatchObject({ code: 'INVALID_INPUT' });

    expect(fixture.store.load).not.toHaveBeenCalled();
    expect(fixture.sources.resolve).not.toHaveBeenCalled();
  });

  it('sanitizes workflow storage failures during association as a mismatch', async () => {
    const fixture = setup();
    const historical = readyRecord({ selection: { ...selection(), device: '12345678' } });
    delete (historical as typeof historical & { sourceId?: string }).sourceId;
    fixture.store.records.set(IDENTITY_ID, historical);
    fixture.store.loadIdentity.mockRejectedValueOnce(new IdentityWorkflowError('STORAGE_FAILED'));

    await expect(createIdentityWorkflow(fixture.deps).associateIdentitySource({
      identityId: IDENTITY_ID, source: SOURCE_ID,
    })).rejects.toMatchObject({ code: 'ASSOCIATION_MISMATCH' });

    expect(fixture.store.reserveIdentityIndex).not.toHaveBeenCalled();
    expect(fixture.store.save).not.toHaveBeenCalled();
  });

  it('preserves association authorization errors and performs no writes', async () => {
    const fixture = setup();
    const historical = readyRecord({ selection: { ...selection(), device: '12345678' } });
    delete (historical as typeof historical & { sourceId?: string }).sourceId;
    fixture.store.records.set(IDENTITY_ID, historical);
    fixture.device.agree.mockRejectedValue(new IdentityHardwareError('AUTHORIZATION_REQUIRED'));

    await expect(createIdentityWorkflow(fixture.deps).associateIdentitySource({
      identityId: IDENTITY_ID, source: SOURCE_ID,
    })).rejects.toMatchObject({ code: 'AUTHORIZATION_REQUIRED' });
    expect(fixture.store.reserveIdentityIndex).not.toHaveBeenCalled();
    expect(fixture.store.save).not.toHaveBeenCalled();
    expect(fixture.store.records.get(IDENTITY_ID)).toEqual(historical);
  });

  it('rechecks credential occupancy inside mutation and preserves the concurrent entry', async () => {
    const fixture = setup();
    fixture.store.records.set(IDENTITY_ID, readyRecord());
    Object.assign(fixture.store, { withMutation: vi.fn(async (_network, operation) => {
      fixture.store.credentials.set('11'.repeat(48), {
        identityId: IDENTITY_ID, credentialNumber: 0, status: 'confirmed',
      });
      return operation();
    }) });

    await expect(createIdentityWorkflow(fixture.deps).prepareAccount({
      identityId: IDENTITY_ID, publicKeys: { '0': PUBLIC_KEY }, credentialThreshold: 1, expirySeconds: NOW_MS / 1000 + 600,
    })).rejects.toMatchObject({ code: 'CREDENTIAL_NUMBER_USED' });
    expect(fixture.crypto.credential).not.toHaveBeenCalled();
    expect(fixture.store.credentials.entries(NETWORK)).toContainEqual(['11'.repeat(48), {
      identityId: IDENTITY_ID, credentialNumber: 0, status: 'confirmed',
    }]);
  });

  it('rechecks a changed identity account limit before credential construction', async () => {
    const fixture = setup();
    const record = readyRecord();
    record.identity!.value.attributeList.maxAccounts = 3;
    fixture.store.records.set(IDENTITY_ID, record);
    fixture.store.credentials.set('11'.repeat(48), {
      identityId: IDENTITY_ID, credentialNumber: 0, status: 'confirmed',
    });
    fixture.store.credentials.set('22'.repeat(48), {
      identityId: IDENTITY_ID, credentialNumber: 1, status: 'confirmed',
    });
    const changed = identityObject(requestObject().value);
    changed.value.attributeList.maxAccounts = 2;
    fixture.store.loadIdentity
      .mockResolvedValueOnce(structuredClone(record.identity!))
      .mockResolvedValueOnce(changed);

    await expect(createIdentityWorkflow(fixture.deps).prepareAccount({
      identityId: IDENTITY_ID, publicKeys: { '0': PUBLIC_KEY }, credentialThreshold: 1, expirySeconds: NOW_MS / 1000 + 600,
    })).rejects.toMatchObject({ code: 'CREDENTIAL_LIMIT' });
    expect(fixture.crypto.credential).not.toHaveBeenCalled();
    expect(fixture.store.saveCredentials).not.toHaveBeenCalled();
  });
});
