import { getAccountAddress } from '@concordium/web-sdk';
import { afterEach,describe,expect,it,vi } from 'vitest';

import * as identityMaterial from '../../src/core/identityMaterial.js';
import { createIdentityWorkflow,IdentityWorkflowError } from '../../src/core/identityWorkflow.js';
import {
context,
credentialPayload,
GENESIS_HASH,
IDENTITY_ID,
identityObject,
NETWORK,
NOW_MS,
PUBLIC_KEY,
readyRecord,
requestObject,
setup,
SOURCE_BLOCK,
SOURCE_ID,
} from '../workflowFixtures.js';

const missing = () => new IdentityWorkflowError('IDENTITY_NOT_FOUND');
afterEach(() => vi.restoreAllMocks());

function discoveryFixture() {
  const fixture = setup({
    loadContext: vi.fn(async (input) => context({
      ipInfo: { ...context().ipInfo, ipIdentity: input.identityProviderIndex },
      issuanceUrl: `https://issuer-${input.identityProviderIndex}.example.test/issue`,
      recoveryUrl: `https://issuer-${input.identityProviderIndex}.example.test/recover`,
    })),
  });
  return { ...fixture, workflow: createIdentityWorkflow(fixture.deps) };
}

describe('identity discovery', () => {
  it('finishes an inclusive range at known occupancy without probing that final slot', async () => {
    const fixture = discoveryFixture();
    fixture.store.records.set(IDENTITY_ID, readyRecord());

    const result = await fixture.workflow.discoverIdentities({ source: SOURCE_ID, identityProviderIndex: 7, endIndex: 2 });

    expect(result.streams[0]).toMatchObject({
      used: [2], unused: [0, 1], scannedRange: { start: 0, end: 1 }, partial: false, stopReason: 'range',
    });
    expect(fixture.provider.recover).toHaveBeenCalledTimes(2);
  });
  it.each([
    { gapLimit: 0 }, { gapLimit: 1.5 }, { endIndex: -1 },
    { endIndex: 0x80000000 }, { startIndex: -1 }, { startIndex: 4, endIndex: 3 },
    { identityProviderIndex: -1 }, { unknown: true },
  ])('rejects invalid strict input %j before source, provider, or hardware access', async (invalid) => {
    const fixture = discoveryFixture();
    await expect(fixture.workflow.discoverIdentities({ source: SOURCE_ID, ...invalid } as never))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(fixture.sources.resolve).not.toHaveBeenCalled();
    expect(fixture.deps.listEnabledProviders).not.toHaveBeenCalled();
    expect(fixture.sources.createAgreement).not.toHaveBeenCalled();
  });

  it('rejects an explicit provider that is not currently enabled', async () => {
    const fixture = discoveryFixture();
    await expect(fixture.workflow.discoverIdentities({ source: SOURCE_ID, identityProviderIndex: 8 }))
      .rejects.toMatchObject({ code: 'PROVIDER_DISABLED' });
    expect(fixture.sources.createAgreement).not.toHaveBeenCalled();
    expect(fixture.provider.recover).not.toHaveBeenCalled();
  });

  it('uses all enabled providers, the default gap of three, and safe disjoint summaries', async () => {
    const fixture = discoveryFixture();
    vi.mocked(fixture.provider.recover)
      .mockResolvedValueOnce(identityObject({ ...requestObject().value, idCredPub: fixture.recovery.value.idCredPub }))
      .mockRejectedValue(missing());

    const result = await fixture.workflow.discoverIdentities({ source: SOURCE_ID });

    expect(result).toEqual({
      network: NETWORK,
      sourceId: SOURCE_ID,
      gapLimit: 3,
      streams: [{
        identityProviderIndex: 7,
        used: [0], reserved: [], unused: [1, 2, 3],
        scannedRange: { start: 0, end: 3 }, nextIndex: 4,
        partial: false, stopReason: 'gap',
      }],
    });
    expect(fixture.deps.listEnabledProviders).toHaveBeenCalledExactlyOnceWith(NETWORK);
    expect(fixture.sources.resolve).toHaveBeenCalledExactlyOnceWith(SOURCE_ID);
    expect(fixture.store.listIdentityReservations).toHaveBeenCalledWith({
      genesisHash: GENESIS_HASH, sourceId: SOURCE_ID, sdkNetwork: 'Testnet', identityProviderIndex: 7,
    });
    expect(fixture.store.reserveIdentityIndex).toHaveBeenCalledWith({
      genesisHash: GENESIS_HASH, sourceId: SOURCE_ID, sdkNetwork: 'Testnet', identityProviderIndex: 7, identityIndex: 0, mode: 'used',
    });
    expect(JSON.stringify(result)).not.toMatch(/root|locator|chosenAttributes|recoveryUrl|issuer-/i);
  });

  it('scans past a known reservation high-water mark and resets the gap at that index', async () => {
    const fixture = discoveryFixture();
    await fixture.store.reserveIdentityIndex({
      genesisHash: GENESIS_HASH, sourceId: SOURCE_ID, sdkNetwork: 'Testnet', identityProviderIndex: 7, identityIndex: 5, mode: 'used',
    });
    vi.mocked(fixture.provider.recover).mockRejectedValue(missing());

    const result = await fixture.workflow.discoverIdentities({ source: SOURCE_ID });

    expect(result.streams[0]).toMatchObject({
      used: [], reserved: [5], unused: [0, 1, 2, 3, 4, 6, 7, 8],
      scannedRange: { start: 0, end: 8 }, nextIndex: 9, stopReason: 'gap', partial: false,
    });
    expect(fixture.provider.recover).toHaveBeenCalledTimes(8);
  });

  it('skips known occupancy without hardware or provider work and reports it in the selected range', async () => {
    const fixture = discoveryFixture();
    await fixture.store.reserveIdentityIndex({
      genesisHash: GENESIS_HASH, sourceId: SOURCE_ID, sdkNetwork: 'Testnet', identityProviderIndex: 7,
      identityIndex: 0, mode: 'used',
    });
    await fixture.store.reserveIdentityIndex({
      genesisHash: GENESIS_HASH, sourceId: SOURCE_ID, sdkNetwork: 'Testnet', identityProviderIndex: 7,
      identityIndex: 2, mode: 'explicit',
    });
    vi.mocked(fixture.provider.recover).mockRejectedValue(missing());

    const result = await fixture.workflow.discoverIdentities({ source: SOURCE_ID });

    expect(result.streams[0]).toMatchObject({
      used: [], reserved: [0, 2], unused: [1, 3, 4, 5],
      scannedRange: { start: 1, end: 5 }, nextIndex: 6, partial: false, stopReason: 'gap',
    });
    expect(fixture.provider.recover).toHaveBeenCalledTimes(4);
    expect(fixture.sources.createAgreement).toHaveBeenCalledTimes(4);
  });

  it('force-probes known values at an explicit inclusive start and excludes earlier occupancy', async () => {
    const fixture = discoveryFixture();
    for (const identityIndex of [0, 2]) await fixture.store.reserveIdentityIndex({
      genesisHash: GENESIS_HASH, sourceId: SOURCE_ID, sdkNetwork: 'Testnet', identityProviderIndex: 7,
      identityIndex, mode: 'used',
    });
    vi.mocked(fixture.provider.recover).mockRejectedValue(missing());

    const result = await fixture.workflow.discoverIdentities({
      source: SOURCE_ID, identityProviderIndex: 7, startIndex: 1, endIndex: 3,
    } as never);

    expect(result.streams[0]).toMatchObject({
      used: [], reserved: [2], unused: [1, 3],
      scannedRange: { start: 1, end: 3 }, partial: false, stopReason: 'range',
    });
    expect(fixture.provider.recover).toHaveBeenCalledTimes(3);
  });

  it('reports the next unscanned index rather than an allocation candidate', async () => {
    const fixture = discoveryFixture();
    vi.mocked(fixture.provider.recover).mockRejectedValue(missing());

    const result = await fixture.workflow.discoverIdentities({
      source: SOURCE_ID, identityProviderIndex: 7, startIndex: 6, gapLimit: 2,
    } as never);

    expect(result.streams[0]).toMatchObject({
      unused: [6, 7], scannedRange: { start: 6, end: 7 }, nextIndex: 8, stopReason: 'gap',
    });
  });

  it('treats an inclusive end as exhaustive instead of stopping at a gap', async () => {
    const fixture = discoveryFixture();
    vi.mocked(fixture.provider.recover).mockRejectedValue(missing());

    const result = await fixture.workflow.discoverIdentities({
      source: SOURCE_ID, identityProviderIndex: 7, gapLimit: 1, endIndex: 3,
    });

    expect(result.streams[0]).toMatchObject({
      unused: [0, 1, 2, 3], scannedRange: { start: 0, end: 3 },
      stopReason: 'range', partial: false,
    });
    expect(result.streams[0]).not.toHaveProperty('nextIndex');
    expect(fixture.provider.recover).toHaveBeenCalledTimes(4);
  });

  it('stops only the failed provider stream, preserves observations, and sanitizes the result', async () => {
    const fixture = discoveryFixture();
    fixture.deps.listEnabledProviders = vi.fn(async () => [7, 8]);
    vi.mocked(fixture.provider.recover).mockImplementation(async (url) => {
      if (url.includes('issuer-7')) throw new Error('secret=/protected/idp endpoint');
      throw missing();
    });
    const workflow = createIdentityWorkflow(fixture.deps);

    const result = await workflow.discoverIdentities({ source: SOURCE_ID, gapLimit: 2 });

    expect(result.streams).toEqual([
      {
        identityProviderIndex: 7, used: [], reserved: [], unused: [],
        scannedRange: { start: 0 }, partial: true, stopReason: 'error', errorCode: 'PROVIDER_FAILED',
      },
      {
        identityProviderIndex: 8, used: [], reserved: [], unused: [0, 1],
        scannedRange: { start: 0, end: 1 }, nextIndex: 2, partial: false, stopReason: 'gap',
      },
    ]);
    expect(JSON.stringify(result)).not.toMatch(/secret|protected|endpoint/i);
  });

  it('reports processed and future reservations once when a later probe fails', async () => {
    const fixture = discoveryFixture();
    for (const identityIndex of [0, 2]) await fixture.store.reserveIdentityIndex({
      genesisHash: GENESIS_HASH, sourceId: SOURCE_ID, sdkNetwork: 'Testnet', identityProviderIndex: 7, identityIndex, mode: 'used',
    });
    vi.mocked(fixture.provider.recover)
      .mockRejectedValueOnce(missing()).mockRejectedValueOnce(new Error('provider unavailable'));

    const result = await fixture.workflow.discoverIdentities({ source: SOURCE_ID });

    expect(result.streams[0]).toMatchObject({
      used: [], reserved: [0, 2], unused: [1],
      scannedRange: { start: 1, end: 1 }, partial: true, stopReason: 'error',
    });
  });

  it('serializes source agreements while provider streams may progress independently', async () => {
    const fixture = discoveryFixture();
    fixture.deps.listEnabledProviders = vi.fn(async () => [7, 8, 9, 10]);
    let active = 0;
    let maximum = 0;
    fixture.sources.createAgreement = vi.fn(async () => ({
      agree: async (peer: Uint8Array) => {
        active += 1;
        maximum = Math.max(maximum, active);
        await Promise.resolve();
        const result = await fixture.device.agree(peer);
        active -= 1;
        return result;
      },
    }));
    vi.mocked(fixture.provider.recover).mockRejectedValue(missing());

    await createIdentityWorkflow(fixture.deps).discoverIdentities({ source: SOURCE_ID, gapLimit: 1 });

    expect(maximum).toBe(1);
  });
});

describe('identity index allocation', () => {
  it('allocates the same index and derives the same material independently on two testnets', async () => {
    const otherGenesis = '34'.repeat(32);
    const otherNetwork = `ccd:${otherGenesis.slice(0, 32)}`;
    const fixture = setup({
      resolveNetwork: vi.fn((network) => network ?? NETWORK),
      loadContext: vi.fn(async (input) => context({
        network: input.network,
        genesisHash: input.network === NETWORK ? GENESIS_HASH : otherGenesis,
      })),
    });
    const workflow = createIdentityWorkflow(fixture.deps);
    const first = await workflow.request({ network: NETWORK, source: SOURCE_ID, identityProviderIndex: 7 });
    const second = await workflow.request({ network: otherNetwork, source: SOURCE_ID, identityProviderIndex: 7 });

    expect(first.identityIndex).toBe(0);
    expect(second.identityIndex).toBe(0);
    expect(second.identityId).toBe(first.identityId);
    expect(vi.mocked(fixture.crypto.request).mock.calls[1]![0])
      .toEqual(vi.mocked(fixture.crypto.request).mock.calls[0]![0]);
    for (const genesisHash of [GENESIS_HASH, otherGenesis]) {
      await expect(fixture.store.listIdentityReservations({
        genesisHash, sourceId: SOURCE_ID, sdkNetwork: 'Testnet', identityProviderIndex: 7,
      })).resolves.toEqual([0]);
    }
  });

  it('rejects an occupied maximum index before probing the provider or hardware', async () => {
    const fixture = discoveryFixture();
    fixture.store.listIdentityReservations.mockResolvedValue([0x7fffffff]);
    vi.mocked(fixture.provider.recover).mockImplementation(async () => { throw new Error('must not probe'); });

    await expect(fixture.workflow.request({ source: SOURCE_ID, identityProviderIndex: 7 }))
      .rejects.toMatchObject({ code: 'INDEX_UNAVAILABLE' });

    expect(fixture.provider.recover).not.toHaveBeenCalled();
    expect(fixture.sources.createAgreement).not.toHaveBeenCalled();
    expect(fixture.store.reserveIdentityIndex).not.toHaveBeenCalled();
  });

  it('uses one source agreement for a recovered remote probe', async () => {
    const fixture = discoveryFixture();
    vi.mocked(fixture.provider.recover).mockResolvedValue(identityObject({
      ...requestObject().value, idCredPub: fixture.recovery.value.idCredPub,
    }));

    await fixture.workflow.discoverIdentities({ source: SOURCE_ID, identityProviderIndex: 7, endIndex: 0 });

    expect(fixture.sources.createAgreement).toHaveBeenCalledOnce();
  });

  it('allows explicitly selected issuance and recovery without applying discovery enabled policy', async () => {
    const issuance = discoveryFixture();
    issuance.deps.listEnabledProviders = vi.fn(async () => []);
    vi.mocked(issuance.provider.recover).mockRejectedValue(missing());
    await expect(createIdentityWorkflow(issuance.deps).request({
      source: SOURCE_ID, identityProviderIndex: 7, identityIndex: 2,
    })).resolves.toMatchObject({ status: 'pending' });

    const recovery = discoveryFixture();
    recovery.deps.listEnabledProviders = vi.fn(async () => []);
    vi.mocked(recovery.provider.recover).mockResolvedValue(identityObject({
      ...requestObject().value, idCredPub: recovery.recovery.value.idCredPub,
    }));
    await expect(createIdentityWorkflow(recovery.deps).recover({
      source: SOURCE_ID, identityProviderIndex: 7, identityIndex: 2,
    })).resolves.toMatchObject({ status: 'issued' });
    expect(issuance.deps.listEnabledProviders).not.toHaveBeenCalled();
    expect(recovery.deps.listEnabledProviders).not.toHaveBeenCalled();
  });

  it('discovers then durably reserves one past high-water before issuance crypto', async () => {
    const fixture = discoveryFixture();
    vi.mocked(fixture.provider.recover).mockRejectedValue(missing());
    const order: string[] = [];
    fixture.store.reserveIdentityIndex.mockImplementationOnce(async () => { order.push('reserve'); });
    vi.mocked(fixture.crypto.request).mockImplementation((input) => {
      order.push('crypto');
      return { ...fixture.request, value: { ...fixture.request.value, idCredPub: input.idCredSec.slice(0, 96).padEnd(96, '0') } };
    });

    await fixture.workflow.request({ network: NETWORK, source: SOURCE_ID, identityProviderIndex: 7 });

    expect(order.slice(0, 2)).toEqual(['reserve', 'crypto']);
    expect(fixture.store.reserveIdentityIndex).toHaveBeenCalledWith({
      genesisHash: GENESIS_HASH, sourceId: SOURCE_ID, sdkNetwork: 'Testnet', identityProviderIndex: 7,
      identityIndex: 0, mode: 'next', expectedHighWater: -1,
    });
  });

  it('does not retry or increment when atomic reservation detects a changed candidate', async () => {
    const fixture = discoveryFixture();
    vi.mocked(fixture.provider.recover).mockRejectedValue(missing());
    fixture.store.reserveIdentityIndex.mockRejectedValueOnce(new IdentityWorkflowError('INDEX_UNAVAILABLE'));

    await expect(fixture.workflow.request({ source: SOURCE_ID, identityProviderIndex: 7 }))
      .rejects.toMatchObject({ code: 'INDEX_UNAVAILABLE' });
    expect(fixture.store.reserveIdentityIndex).toHaveBeenCalledOnce();
    expect(fixture.sources.createAgreement).toHaveBeenCalledTimes(3);
    expect(fixture.crypto.request).not.toHaveBeenCalled();
  });

  it('retains a durable reservation when issuance fails after allocation', async () => {
    const fixture = discoveryFixture();
    vi.mocked(fixture.provider.recover).mockRejectedValue(missing());
    vi.mocked(fixture.crypto.request).mockImplementation(() => { throw new Error('cancelled issuance'); });

    await expect(fixture.workflow.request({ source: SOURCE_ID, identityProviderIndex: 7 }))
      .rejects.toMatchObject({ code: 'CRYPTO_FAILED' });
    await expect(fixture.store.listIdentityReservations({
      genesisHash: GENESIS_HASH, sourceId: SOURCE_ID, sdkNetwork: 'Testnet', identityProviderIndex: 7,
    })).resolves.toEqual([0]);
    expect(fixture.store.records.size).toBe(0);
  });

  it('refuses a locally occupied explicit index without probing or issuing', async () => {
    const fixture = discoveryFixture();
    await fixture.store.reserveIdentityIndex({
      genesisHash: GENESIS_HASH, sourceId: SOURCE_ID, sdkNetwork: 'Testnet', identityProviderIndex: 7,
      identityIndex: 4, mode: 'used',
    });

    await expect(fixture.workflow.request({
      source: SOURCE_ID, identityProviderIndex: 7, identityIndex: 4,
    })).rejects.toMatchObject({ code: 'INDEX_UNAVAILABLE' });
    expect(fixture.provider.recover).not.toHaveBeenCalled();
    expect(fixture.crypto.request).not.toHaveBeenCalled();
  });

  it('recovers a remotely occupied explicit index and returns the ready identity as an existing outcome', async () => {
    const fixture = discoveryFixture();
    vi.mocked(fixture.provider.recover).mockResolvedValue(identityObject({
      ...requestObject().value, idCredPub: fixture.recovery.value.idCredPub,
    }));

    await expect(fixture.workflow.request({
      source: SOURCE_ID, identityProviderIndex: 7, identityIndex: 4,
    })).resolves.toMatchObject({ status: 'issued', identityIndex: 4, outcome: 'identity_already_exists' });
    expect(fixture.store.createIdentity).toHaveBeenCalledOnce();
    expect(fixture.crypto.request).not.toHaveBeenCalled();
  });

  it('does not free or replace a reserved recovery index when the provider reports it missing', async () => {
    const fixture = discoveryFixture();
    await fixture.store.reserveIdentityIndex({
      genesisHash: GENESIS_HASH, sourceId: SOURCE_ID, sdkNetwork: 'Testnet', identityProviderIndex: 7, identityIndex: 2, mode: 'used',
    });
    vi.mocked(fixture.provider.recover).mockRejectedValue(missing());

    await expect(fixture.workflow.recover({
      source: SOURCE_ID, identityProviderIndex: 7, identityIndex: 2,
    })).rejects.toMatchObject({ code: 'DISCOVERY_INCOMPLETE' });
    await expect(fixture.store.listIdentityReservations({
      genesisHash: GENESIS_HASH, sourceId: SOURCE_ID, sdkNetwork: 'Testnet', identityProviderIndex: 7,
    })).resolves.toEqual([2]);
    expect(fixture.crypto.recovery).toHaveBeenCalledOnce();
    expect(fixture.store.createIdentity).not.toHaveBeenCalled();
  });
});

describe('credential discovery', () => {
  it.each([
    { gapLimit: 0 }, { endCredentialNumber: -1 }, { endCredentialNumber: 256 },
    { startCredentialNumber: -1 }, { startCredentialNumber: 3, endCredentialNumber: 2 },
    { full: true, startCredentialNumber: 0 }, { full: true, endCredentialNumber: 2 },
    { full: 'true' }, { unknown: true },
  ])('rejects invalid strict input %j before identity decryption or observation', async (invalid) => {
    const fixture = setup();
    fixture.store.records.set(IDENTITY_ID, readyRecord());
    await expect(createIdentityWorkflow(fixture.deps).discoverAccountCredentials({
      identityId: IDENTITY_ID, ...invalid,
    } as never)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(fixture.store.loadIdentity).not.toHaveBeenCalled();
    expect(fixture.createAccountObserver).not.toHaveBeenCalled();
  });

  it('uses one captured observer, defaults to three misses, and derives credential-id selectors only', async () => {
    const fixture = setup();
    fixture.store.records.set(IDENTITY_ID, readyRecord());
    const observer = vi.fn<(selector: { type: 'credentialId'; credentialId: string }) => Promise<{
      exists: false; sourceBlock: typeof SOURCE_BLOCK; genesisHash: string;
    }>>(async () => ({
      exists: false as const, sourceBlock: SOURCE_BLOCK, genesisHash: GENESIS_HASH,
    }));
    fixture.createAccountObserver.mockResolvedValue(observer as never);

    const result = await createIdentityWorkflow(fixture.deps).discoverAccountCredentials({ identityId: IDENTITY_ID });

    expect(result).toEqual({
      network: NETWORK, identityId: IDENTITY_ID, gapLimit: 3, sourceBlock: SOURCE_BLOCK,
      stream: {
        used: [], reserved: [], unused: [0, 1, 2], scannedRange: { start: 0, end: 2 },
        partial: false, stopReason: 'limit',
      },
    });
    expect(fixture.createAccountObserver).toHaveBeenCalledExactlyOnceWith(NETWORK);
    expect(observer).toHaveBeenCalledTimes(3);
    for (const [selector] of observer.mock.calls) {
      expect(selector).toEqual({ type: 'credentialId', credentialId: expect.stringMatching(/^[0-9a-f]{96}$/) });
    }
    expect(new Set(observer.mock.calls.map(([value]) => value.credentialId)).size).toBe(3);
    expect(fixture.crypto.credential).not.toHaveBeenCalled();
  });

  it('derives only credential IDs actually probed by the default gap scan', async () => {
    const fixture = setup();
    const record = readyRecord();
    record.identity!.value.attributeList.maxAccounts = 255;
    fixture.store.records.set(IDENTITY_ID, record);
    fixture.createAccountObserver.mockResolvedValue(vi.fn(async () => ({
      exists: false as const, sourceBlock: SOURCE_BLOCK, genesisHash: GENESIS_HASH,
    })));
    const derive = vi.spyOn(identityMaterial, 'deriveCredentialRegistrationId');

    await createIdentityWorkflow(fixture.deps).discoverAccountCredentials({ identityId: IDENTITY_ID });

    expect(derive).toHaveBeenCalledTimes(3);
  });

  it('skips known credential numbers by default but reports them and probes unknown gaps', async () => {
    const fixture = setup();
    fixture.store.records.set(IDENTITY_ID, readyRecord());
    fixture.store.credentials.set('11'.repeat(48), {
      identityId: IDENTITY_ID, credentialNumber: 0, status: 'confirmed',
    });
    fixture.store.credentials.set('22'.repeat(48), {
      identityId: IDENTITY_ID, credentialNumber: 2, status: 'pending',
      expectedAccountAddress: 'account-two', expirySeconds: NOW_MS / 1000 + 60,
    });
    const observer = vi.fn(async () => ({ exists: false as const, sourceBlock: SOURCE_BLOCK, genesisHash: GENESIS_HASH }));
    fixture.createAccountObserver.mockResolvedValue(observer);
    const derive = vi.spyOn(identityMaterial, 'deriveCredentialRegistrationId');

    const result = await createIdentityWorkflow(fixture.deps).discoverAccountCredentials({ identityId: IDENTITY_ID });

    expect(result.stream).toMatchObject({
      used: [0], reserved: [2], unused: [1],
      scannedRange: { start: 1, end: 1 }, partial: false, stopReason: 'limit',
    });
    expect(observer).toHaveBeenCalledOnce();
    expect(derive).toHaveBeenCalledOnce();
  });

  it('force-probes locally known credentials within an explicit inclusive range', async () => {
    const fixture = setup();
    fixture.store.records.set(IDENTITY_ID, readyRecord());
    fixture.store.credentials.set('22'.repeat(48), {
      identityId: IDENTITY_ID, credentialNumber: 2, status: 'pending',
      expectedAccountAddress: 'account-two', expirySeconds: NOW_MS / 1000 + 60,
    });
    const observer = vi.fn(async () => ({ exists: false as const, sourceBlock: SOURCE_BLOCK, genesisHash: GENESIS_HASH }));
    fixture.createAccountObserver.mockResolvedValue(observer);

    const result = await createIdentityWorkflow(fixture.deps).discoverAccountCredentials({
      identityId: IDENTITY_ID, startCredentialNumber: 1, endCredentialNumber: 2,
    } as never);

    expect(result.stream).toMatchObject({
      used: [], reserved: [2], unused: [1], scannedRange: { start: 1, end: 2 }, stopReason: 'range',
    });
    expect(observer).toHaveBeenCalledTimes(2);
  });

  it('does not create an observer when a bounded credential range contains only known occupancy', async () => {
    const fixture = setup();
    fixture.store.records.set(IDENTITY_ID, readyRecord());
    fixture.store.credentials.set('11'.repeat(48), {
      identityId: IDENTITY_ID, credentialNumber: 0, status: 'confirmed',
    });

    const result = await createIdentityWorkflow(fixture.deps).discoverAccountCredentials({
      identityId: IDENTITY_ID, endCredentialNumber: 0,
    });

    expect(result.stream).toEqual({
      used: [0], reserved: [], unused: [], scannedRange: { start: 1 },
      partial: false, stopReason: 'range',
    });
    expect(fixture.createAccountObserver).not.toHaveBeenCalled();
  });

  it('classifies historical deployment as used even when current credentials omit the queried id', async () => {
    const fixture = setup();
    fixture.store.records.set(IDENTITY_ID, readyRecord());
    const observation = {
      accountThreshold: '1', credentials: {}, sourceBlock: SOURCE_BLOCK,
    };
    const observer = vi.fn()
      .mockResolvedValueOnce({
        exists: true, canonicalAddress: getAccountAddress(credentialPayload().unsignedCdi.credId).toString(), observation,
        sourceBlock: SOURCE_BLOCK, genesisHash: GENESIS_HASH,
      })
      .mockResolvedValue({ exists: false, sourceBlock: SOURCE_BLOCK, genesisHash: GENESIS_HASH });
    fixture.createAccountObserver.mockResolvedValue(observer);

    const result = await createIdentityWorkflow(fixture.deps).discoverAccountCredentials({ identityId: IDENTITY_ID });

    expect(result.stream.used).toEqual([0]);
    const queriedId = observer.mock.calls[0]![0].credentialId;
    expect(fixture.store.credentials.entries(NETWORK)).toContainEqual([queriedId, {
      identityId: IDENTITY_ID, credentialNumber: 0, status: 'confirmed',
    }]);
  });

  it('requires full mode for a complete account allowance scan', async () => {
    const fixture = setup();
    const record = readyRecord();
    record.identity!.value.attributeList.maxAccounts = 6;
    fixture.store.records.set(IDENTITY_ID, record);
    const observer = vi.fn(async () => ({ exists: false as const, sourceBlock: SOURCE_BLOCK, genesisHash: GENESIS_HASH }));
    fixture.createAccountObserver.mockResolvedValue(observer);

    const result = await createIdentityWorkflow(fixture.deps).discoverAccountCredentials({
      identityId: IDENTITY_ID, gapLimit: 1, full: true,
    });

    expect(result.stream).toMatchObject({
      unused: [0, 1, 2, 3, 4, 5], scannedRange: { start: 0, end: 5 }, stopReason: 'range', partial: false,
    });
    expect(observer).toHaveBeenCalledTimes(6);
  });

  it('rejects inconsistent finalized provenance without caching or ledger mutation', async () => {
    const fixture = setup();
    fixture.store.records.set(IDENTITY_ID, readyRecord());
    fixture.createAccountObserver.mockResolvedValue(vi.fn()
      .mockResolvedValueOnce({ exists: false, sourceBlock: SOURCE_BLOCK, genesisHash: GENESIS_HASH })
      .mockResolvedValueOnce({
        exists: false, sourceBlock: { ...SOURCE_BLOCK, hash: 'cd'.repeat(32) }, genesisHash: GENESIS_HASH,
      }));

    const result = await createIdentityWorkflow(fixture.deps).discoverAccountCredentials({ identityId: IDENTITY_ID });

    expect(result.stream).toMatchObject({
      unused: [0], scannedRange: { start: 0, end: 0 }, partial: true,
      stopReason: 'error', errorCode: 'NETWORK_FAILED',
    });
    expect([...fixture.store.credentials]).toEqual([]);
  });
});

describe('credential allocation from finalized discovery', () => {
  const prepare = (credentialNumber?: number) => ({
    identityId: IDENTITY_ID,
    ...(credentialNumber === undefined ? {} : { credentialNumber }),
    publicKeys: { '0': PUBLIC_KEY }, credentialThreshold: 1,
    expirySeconds: NOW_MS / 1000 + 600,
  });

  it('discovers and chooses the lowest proven-unused credential before building a handoff', async () => {
    const fixture = setup();
    fixture.store.records.set(IDENTITY_ID, readyRecord());
    const observer = vi.fn(async () => ({ exists: false as const, sourceBlock: SOURCE_BLOCK, genesisHash: GENESIS_HASH }));
    fixture.createAccountObserver.mockResolvedValue(observer);

    const result = await createIdentityWorkflow(fixture.deps).prepareAccount(prepare());

    expect(result.credentialNumber).toBe(0);
    expect(observer).toHaveBeenCalledTimes(3);
    expect(fixture.crypto.credential).toHaveBeenCalledWith(
      expect.objectContaining({ credNumber: 0 }), expect.anything(),
    );
    expect(fixture.store.saveCredentials).toHaveBeenCalledOnce();
  });

  it('rejects an explicit credential observed on chain even when absent from the local ledger', async () => {
    const fixture = setup();
    fixture.store.records.set(IDENTITY_ID, readyRecord());
    fixture.createAccountObserver.mockResolvedValue(vi.fn(async () => ({
      exists: true as const,
      canonicalAddress: getAccountAddress(credentialPayload().unsignedCdi.credId).toString(),
      observation: { accountThreshold: '1', credentials: {}, sourceBlock: SOURCE_BLOCK },
      sourceBlock: SOURCE_BLOCK, genesisHash: GENESIS_HASH,
    })) as never);

    await expect(createIdentityWorkflow(fixture.deps).prepareAccount(prepare(0)))
      .rejects.toMatchObject({ code: 'CREDENTIAL_NUMBER_USED' });
    expect(fixture.crypto.credential).not.toHaveBeenCalled();
  });

  it('blocks automatic allocation when credential discovery is partial', async () => {
    const fixture = setup();
    fixture.store.records.set(IDENTITY_ID, readyRecord());
    fixture.createAccountObserver.mockResolvedValue(vi.fn(async () => { throw new Error('private rpc detail'); }));

    await expect(createIdentityWorkflow(fixture.deps).prepareAccount(prepare()))
      .rejects.toMatchObject({ code: 'DISCOVERY_INCOMPLETE' });
    expect(fixture.sources.createAgreement).toHaveBeenCalledOnce();
    expect(fixture.crypto.credential).not.toHaveBeenCalled();
    expect(fixture.store.saveCredentials).not.toHaveBeenCalled();
  });
});
