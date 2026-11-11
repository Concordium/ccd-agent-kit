import { MAINNET_GENESIS_HASH } from '@ccd-agent-kit/sdk-utils';
import { TransactionExpiry,getAccountAddress } from '@concordium/web-sdk';
import { describe,expect,it,vi } from 'vitest';

import { IdentityWorkflowError,createIdentityWorkflow } from '../../src/core/identityWorkflow.js';
import { IdentityProviderError } from '../../src/core/providers/error.js';
import type { StoredIdentity } from '../../src/core/workflowTypes.js';
import { PRIVATE_DIAGNOSTIC,expectSanitized } from '../helpers.js';
import {
IDENTITY_ID,
ID_CRED_PUB,
NETWORK,
NOW_MS,
PUBLIC_KEY,
SOURCE_ID,
awaitingRecord,
context,
contextFingerprint,
credentialPayload,
identityObject,
readyRecord,
recoveryInput,
requestObject,
selection,
setup,
} from '../workflowFixtures.js';

const startInput = () => recoveryInput();

async function expectWorkflowError(promise: Promise<unknown>, code: string) {
  let failure: unknown;
  try {
    await promise;
  } catch (error) {
    failure = error;
  }
  expectSanitized(failure, IdentityWorkflowError, code);
}

function callback(id = IDENTITY_ID, retrieval = 'https://issuer.example.test/v1/result/opaque') {
  return `ccd-id-manager://identity/${id}#code_uri=${encodeURIComponent(retrieval)}`;
}

async function seedReady(fixture: ReturnType<typeof setup>): Promise<StoredIdentity> {
  await createIdentityWorkflow(fixture.deps).request(startInput());
  const record = fixture.store.records.get(IDENTITY_ID)!;
  const request = record.request!;
  record.status = 'ready';
  record.identity = identityObject(request.value);
  for (const field of ['request','requestAttemptId','postIssuance','authorizationUrl','retrievalUrl','confirmedFailure'] as const) {
    delete record[field];
  }
  fixture.store.records.set(IDENTITY_ID, structuredClone(record));
  vi.mocked(fixture.crypto.request).mockClear();
  vi.mocked(fixture.sources.createAgreement).mockClear();
  fixture.store.create.mockClear();
  fixture.device.transferred.length = 0;
  return structuredClone(record);
}

describe('IdentityWorkflow request and recovery', () => {
  it.each([
    ['explicit override', 'localnet', 'localnet'],
    ['shared default', undefined, undefined],
  ] as const)('resolves the %s once and derives the SDK namespace internally', async (_label, network, expectedSelector) => {
    const fixture = setup();
    const withoutNetwork: Partial<ReturnType<typeof startInput>> = { ...startInput() };
    delete withoutNetwork.network;
    const input = network === undefined ? withoutNetwork : { ...withoutNetwork, network };
    await createIdentityWorkflow(fixture.deps).request(input as never);
    expect(fixture.deps.resolveNetwork).toHaveBeenCalledExactlyOnceWith(expectedSelector);
    expect(fixture.deps.loadContext).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ network: NETWORK }));
    expect(vi.mocked(fixture.deps.loadContext).mock.calls[0]![0]).not.toHaveProperty('sdkNetwork');
    expect(fixture.sources.createAgreement).toHaveBeenCalledTimes(2);
    expect(fixture.sources.createAgreement).toHaveBeenNthCalledWith(1, SOURCE_ID);
    expect(fixture.sources.createAgreement).toHaveBeenNthCalledWith(2, SOURCE_ID);
    expect(fixture.store.bootstrapNetwork).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      caip2: NETWORK,
      sdkNetwork: 'Testnet',
    }));
    expect(fixture.store.create).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      selection: expect.objectContaining({ network: NETWORK, sdkNetwork: 'Testnet' }),
    }));
  });

  it.each([
    ['official full Mainnet genesis', MAINNET_GENESIS_HASH, 'Mainnet'],
    ['same Mainnet CAIP-2 prefix with a different tail', `${MAINNET_GENESIS_HASH.slice(0, 32)}${'00'.repeat(16)}`, 'Testnet'],
  ] as const)('derives the SDK namespace from %s, never the alias or CAIP-2 prefix', async (_label, genesisHash, sdkNetwork) => {
    const canonical = `ccd:${genesisHash.slice(0, 32)}`;
    const fixture = setup({
      resolveNetwork: vi.fn(() => canonical),
      loadContext: vi.fn(async () => context({ network: canonical, genesisHash, sdkNetwork })),
    });
    await createIdentityWorkflow(fixture.deps).request({ ...startInput(), network: 'mainnet' });
    const loadedSelection = vi.mocked(fixture.deps.loadContext).mock.calls[0]![0];
    expect(loadedSelection).toMatchObject({ network: canonical });
    expect(loadedSelection).not.toHaveProperty('sdkNetwork');
    expect(fixture.sources.createAgreement).toHaveBeenCalledWith(SOURCE_ID);
  });

  it('loads verified context before agreement and creates a versioned issuance request with the default AR policy', async () => {
    const fixture = setup();
    const order: string[] = [];
    vi.mocked(fixture.deps.loadContext).mockImplementation(async () => {
      order.push('context');
      return context();
    });
    vi.mocked(fixture.sources.createAgreement).mockImplementation(async () => {
      order.push('agreement');
      return { agree: fixture.device.agree };
    });

    const summary = await createIdentityWorkflow(fixture.deps).request(startInput());

    expect(order).toEqual(['context', 'agreement', 'agreement']);
    expect(fixture.crypto.request).toHaveBeenCalledOnce();
    const cryptoInput = vi.mocked(fixture.crypto.request).mock.calls[0]![0];
    expect(cryptoInput).toMatchObject({
      ipInfo: context().ipInfo,
      globalContext: context().globalContext,
      arsInfos: context().arsInfos,
      arThreshold: 2,
    });
    expect(cryptoInput.idCredSec).toMatch(/^[0-9a-f]{64}$/);
    expect(cryptoInput.prfKey).toMatch(/^[0-9a-f]{64}$/);
    expect(cryptoInput.blindingRandomness).toMatch(/^[0-9a-f]{64}$/);
    expect(new Set([cryptoInput.idCredSec, cryptoInput.prfKey, cryptoInput.blindingRandomness]).size).toBe(3);

    const stored = fixture.store.records.get(IDENTITY_ID)!;
    expect(stored).toMatchObject({
      version: 1,
      id: IDENTITY_ID,
      sourceId: SOURCE_ID,
      selection: selection(),
      idCredPub: ID_CRED_PUB,
      status: 'awaiting_verification',
      request: fixture.request,
    });
    expect(stored.contextHash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.selection).not.toHaveProperty('walletProxyUrl');
    expect(stored.selection).not.toHaveProperty('device');
    expect(stored).not.toHaveProperty('identity');
    expect(stored.retrievalUrl).toBeUndefined();

    expect(summary).toMatchObject({
      identityId: IDENTITY_ID,
      network: NETWORK,
      identityProviderIndex: 7,
      identityIndex: 2,
      status: 'pending',
      sourceId: SOURCE_ID,
    });
    const authorizationUrl = new URL(summary.authorizationUrl!);
    expect(`${authorizationUrl.origin}${authorizationUrl.pathname}`).toBe(context().issuanceUrl);
    expect(authorizationUrl.searchParams.get('redirect_uri')).toBe(`ccd-id-manager://identity/${IDENTITY_ID}`);
    expect(JSON.parse(authorizationUrl.searchParams.get('state')!)).toEqual({ idObjectRequest: fixture.request });
    expect(JSON.stringify(summary)).not.toContain('chosenAttributes');
    expect(fixture.device.transferred).toHaveLength(2);
    expect(fixture.device.transferred.every((secret) => secret.every((byte) => byte === 0))).toBe(true);
  });

  it.each([
    ['list only', { anonymityRevokers: [3, 1] }, ['1', '3'], 1],
    ['threshold only', { anonymityRevokerThreshold: 1 }, ['1', '2', '3'], 1],
    ['both', { anonymityRevokers: [3, 2], anonymityRevokerThreshold: 2 }, ['2', '3'], 2],
  ] as const)('uses configured AR policy for new issuance: %s', async (_case, preference, ids, threshold) => {
    const loaded = context({ anonymityRevocation: preference } as never);
    const fixture = setup({ loadContext: vi.fn(async () => loaded) });
    await createIdentityWorkflow(fixture.deps).request(startInput());
    const cryptoInput = vi.mocked(fixture.crypto.request).mock.calls[0]![0];
    expect(Object.keys(cryptoInput.arsInfos).sort()).toEqual(ids);
    expect(cryptoInput.arThreshold).toBe(threshold);
    expect(loaded.arsInfos).toEqual(context().arsInfos);
  });

  it('supports explicit threshold 255 without clamping', async () => {
    const base = context();
    const arsInfos = Object.fromEntries(Array.from({ length: 256 }, (_, index) => {
      const arIdentity = index + 1;
      return [String(arIdentity), { ...base.arsInfos[1]!, arIdentity }];
    }));
    const fixture = setup({ loadContext: vi.fn(async () => context({
      arsInfos,
      anonymityRevocation: { anonymityRevokerThreshold: 255 },
    } as never)) });
    await createIdentityWorkflow(fixture.deps).request(startInput());
    expect(vi.mocked(fixture.crypto.request).mock.calls[0]![0].arThreshold).toBe(255);
  });

  it('requires explicit threshold one when fresh context contains one AR', async () => {
    const one = context();
    one.arsInfos = { 1: one.arsInfos[1]! };
    const omitted = setup({ loadContext: vi.fn(async () => one) });
    await expect(createIdentityWorkflow(omitted.deps).request(startInput()))
      .rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' });
    expect(omitted.crypto.request).not.toHaveBeenCalled();

    const explicit = setup({ loadContext: vi.fn(async () => ({
      ...one, anonymityRevocation: { anonymityRevokerThreshold: 1 },
    })) });
    await createIdentityWorkflow(explicit.deps).request(startInput());
    expect(vi.mocked(explicit.crypto.request).mock.calls[0]![0]).toMatchObject({
      arsInfos: one.arsInfos, arThreshold: 1,
    });
  });

  it.each([
    ['unknown selected ID', { anonymityRevokers: [1, 99], anonymityRevokerThreshold: 1 }],
    ['empty selected list', { anonymityRevokers: [] }],
    ['duplicate selected ID', { anonymityRevokers: [1, 1], anonymityRevokerThreshold: 1 }],
    ['zero selected ID', { anonymityRevokers: [0], anonymityRevokerThreshold: 1 }],
    ['threshold zero', { anonymityRevokerThreshold: 0 }],
    ['threshold over count', { anonymityRevokers: [1, 2], anonymityRevokerThreshold: 3 }],
    ['threshold over byte range', { anonymityRevokerThreshold: 256 }],
  ])('rejects invalid fresh AR policy before reserving or invoking crypto: %s', async (_case, preference) => {
    const fixture = setup({ loadContext: vi.fn(async () => context({ anonymityRevocation: preference } as never)) });
    await expect(createIdentityWorkflow(fixture.deps).request(startInput()))
      .rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' });
    expect(fixture.store.reserveIdentityIndex).not.toHaveBeenCalled();
    expect(fixture.crypto.request).not.toHaveBeenCalled();
  });

  it('rejects an omitted threshold whose selected-count default exceeds 255', async () => {
    const base = context();
    const arsInfos = Object.fromEntries(Array.from({ length: 257 }, (_, index) => {
      const arIdentity = index + 1;
      return [String(arIdentity), { ...base.arsInfos[1]!, arIdentity }];
    }));
    const fixture = setup({ loadContext: vi.fn(async () => context({ arsInfos } as never)) });
    await expect(createIdentityWorkflow(fixture.deps).request(startInput()))
      .rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' });
    expect(fixture.store.reserveIdentityIndex).not.toHaveBeenCalled();
    expect(fixture.crypto.request).not.toHaveBeenCalled();
  });

  it('does not apply current AR issuance policy when an existing identity is reused', async () => {
    const fixture = setup();
    await seedReady(fixture);
    fixture.store.reserveIdentityIndex.mockClear();
    vi.mocked(fixture.deps.loadContext).mockResolvedValue(context({
      anonymityRevocation: { anonymityRevokers: [99], anonymityRevokerThreshold: 1 },
    } as never));
    await expect(createIdentityWorkflow(fixture.deps).request(startInput())).resolves.toMatchObject({
      outcome: 'identity_already_exists', status: 'issued',
    });
    expect(fixture.crypto.request).not.toHaveBeenCalled();
    expect(fixture.store.reserveIdentityIndex).not.toHaveBeenCalled();
  });

  it('recovers with the direct versioned SDK request and persists only a matching identity', async () => {
    const fixture = setup();
    vi.mocked(fixture.provider.recover).mockResolvedValue(identityObject({
      ...requestObject().value,
      idCredPub: fixture.recovery.value.idCredPub,
    }));

    const summary = await createIdentityWorkflow(fixture.deps).recover(startInput());

    expect(fixture.deps.resolveNetwork).toHaveBeenCalledExactlyOnceWith(NETWORK);
    expect(fixture.provider.recover).toHaveBeenCalledWith(context().recoveryUrl, fixture.recovery);
    expect(vi.mocked(fixture.provider.recover).mock.calls[0]![1]).not.toHaveProperty('idRecoveryRequest');
    expect(summary).toEqual({
      identityId: IDENTITY_ID,
      network: NETWORK,
      identityProviderIndex: 7,
      identityIndex: 2,
      status: 'issued',
      sourceId: SOURCE_ID,
      label: `ID-${SOURCE_ID.slice(3)}-7-2`,
    });
    expect(fixture.store.records.get(IDENTITY_ID)).toMatchObject({
      idCredPub: fixture.recovery.value.idCredPub,
      status: 'ready',
      identity: expect.any(Object),
    });
    expect(fixture.store.records.get(IDENTITY_ID)).not.toHaveProperty('request');
  });

  it('binds the context fingerprint to canonical public context and both endpoint origins', async () => {
    const first = setup();
    await createIdentityWorkflow(first.deps).request(startInput());
    const hash = first.store.records.get(IDENTITY_ID)!.contextHash;

    const reordered = setup({
      loadContext: async () => {
        const original = context();
        return {
          recoveryUrl: original.recoveryUrl,
          issuanceUrl: original.issuanceUrl,
          globalContext: original.globalContext,
          arsInfos: { 3: original.arsInfos[3]!, 2: original.arsInfos[2]!, 1: original.arsInfos[1]! },
          ipInfo: original.ipInfo,
          network: original.network,
          genesisHash: original.genesisHash,
          sdkNetwork: original.sdkNetwork,
        };
      },
    });
    await createIdentityWorkflow(reordered.deps).request(startInput());
    expect(reordered.store.records.get(IDENTITY_ID)!.contextHash).toBe(hash);

    const changedEndpoint = setup({
      loadContext: async () => context({ recoveryUrl: 'https://recovery.example.test/v1/recover' }),
    });
    await createIdentityWorkflow(changedEndpoint.deps).request(startInput());
    expect(changedEndpoint.store.records.get(IDENTITY_ID)!.contextHash).not.toBe(hash);

    const changedPreference = setup({
      loadContext: async () => context({
        anonymityRevocation: { anonymityRevokers: [3, 1], anonymityRevokerThreshold: 1 },
      } as never),
    });
    await createIdentityWorkflow(changedPreference.deps).request(startInput());
    expect(changedPreference.store.records.get(IDENTITY_ID)!.contextHash).toBe(hash);
  });

  it('keeps SDK material and storage identity stable across verified genesis hashes in one SDK namespace', async () => {
    const run = async (genesisHash: string) => {
      const loaded = context({
        network: `ccd:${genesisHash.slice(0, 32)}`,
        genesisHash,
        sdkNetwork: 'Testnet',
      });
      const fixture = setup({
        resolveNetwork: vi.fn(() => loaded.network),
        loadContext: async () => loaded,
      });
      const summary = await createIdentityWorkflow(fixture.deps).request({ ...startInput(), network: 'devnet' });
      return {
        summary,
        cryptoInput: vi.mocked(fixture.crypto.request).mock.calls[0]![0],
        record: fixture.store.records.get(summary.identityId, loaded.network)!,
      };
    };
    const first = await run('12'.repeat(32));
    const second = await run('34'.repeat(32));
    expect(second.summary.identityId).toBe(first.summary.identityId);
    expect(second.cryptoInput.idCredSec).toBe(first.cryptoInput.idCredSec);
    expect(second.cryptoInput.prfKey).toBe(first.cryptoInput.prfKey);
    expect(second.cryptoInput.blindingRandomness).toBe(first.cryptoInput.blindingRandomness);
    expect(second.record.contextHash).not.toBe(first.record.contextHash);
    expect(second.record.selection.network).not.toBe(first.record.selection.network);
  });

  it('persists and lists a realistic long GET authorization URL without truncating the SDK request state', async () => {
    const fixture = setup();
    fixture.request.value.proofsOfKnowledge = 'aa'.repeat(8_192);
    const workflow = createIdentityWorkflow(fixture.deps);

    const requested = await workflow.request(startInput());
    expect(requested.authorizationUrl?.length).toBeGreaterThan(16_000);
    expect(fixture.store.records.get(IDENTITY_ID)?.authorizationUrl).toBe(requested.authorizationUrl);
    await expect(workflow.list({})).resolves.toEqual([
      expect.objectContaining({
        identityId: IDENTITY_ID, status: 'pending', authorizationUrl: requested.authorizationUrl,
      }),
    ]);
  });

  it.each([
    ['network', { network: '' }],
    ['SDK network', { sdkNetwork: 'Devnet' }],
      ['source selector', { source: '' }],
      ['raw device selector', { device: '12345678' }],
      ['raw public-key pin', { rootPublicKey: selection().rootPublicKey }],
    ['IDP index', { identityProviderIndex: -1 }],
    ['identity index', { identityIndex: 0.5 }],
    ['wallet proxy URL', { walletProxyUrl: 'http://wallet.example.test' }],
  ])('rejects invalid %s before context, hardware, provider, or storage', async (_name, patch) => {
    const fixture = setup();
    await expectWorkflowError(
      createIdentityWorkflow(fixture.deps).request({ ...startInput(), ...patch } as never),
      'INVALID_INPUT',
    );
    expect(fixture.deps.loadContext).not.toHaveBeenCalled();
    expect(fixture.sources.createAgreement).not.toHaveBeenCalled();
    expect(fixture.provider.recover).not.toHaveBeenCalled();
    expect(fixture.store.create).not.toHaveBeenCalled();
  });

  it.each([
    ['network', context({ network: 'ccd:00000000000000000000000000000000' })],
    ['identity provider', context({ ipInfo: { ...context().ipInfo, ipIdentity: 8 } })],
  ])('rejects a mismatched %s before hardware agreement', async (_name, loadedContext) => {
    const fixture = setup({ loadContext: async () => loadedContext });
    await expectWorkflowError(createIdentityWorkflow(fixture.deps).request(startInput()), 'DISCOVERY_INCOMPLETE');
    expect(fixture.sources.createAgreement).not.toHaveBeenCalled();
    expect(fixture.crypto.request).not.toHaveBeenCalled();
    expect(fixture.store.bootstrapNetwork).not.toHaveBeenCalled();
    expect(fixture.store.create).not.toHaveBeenCalled();
  });

  it('sanitizes SDK, provider, and storage failures, performs no retry, and leaves storage unchanged', async () => {
    for (const [boundary, configure, code] of [
      ['crypto', (f: ReturnType<typeof setup>) => vi.mocked(f.crypto.request).mockImplementation(() => { throw new Error(PRIVATE_DIAGNOSTIC); }), 'CRYPTO_FAILED'],
      ['provider', (f: ReturnType<typeof setup>) => vi.mocked(f.provider.recover).mockRejectedValue(new Error(PRIVATE_DIAGNOSTIC)), 'PROVIDER_FAILED'],
      ['store', (f: ReturnType<typeof setup>) => f.store.create.mockRejectedValue(new Error(PRIVATE_DIAGNOSTIC)), 'STORAGE_FAILED'],
    ] as const) {
      const fixture = setup();
      configure(fixture);
      const workflow = createIdentityWorkflow(fixture.deps);
      await expectWorkflowError(boundary === 'provider' ? workflow.recover(startInput()) : workflow.request(startInput()), code);
      expect(fixture.store.records.size, boundary).toBe(0);
      expect(fixture.device.transferred).toHaveLength(boundary === 'provider' ? 1 : 2);
      expect(fixture.device.transferred.every((secret) => secret.every((byte) => byte === 0))).toBe(true);
      expect(vi.mocked(fixture.crypto.request).mock.calls.length + vi.mocked(fixture.crypto.recovery).mock.calls.length)
        .toBe(boundary === 'provider' ? 1 : 2);
      expect(fixture.provider.recover).toHaveBeenCalledOnce();
      expect(fixture.store.create.mock.calls.length).toBe(boundary === 'store' ? 1 : 0);
    }
  });

  it('rejects recovered identity mismatch without writing a record', async () => {
    const fixture = setup();
    vi.mocked(fixture.provider.recover).mockResolvedValue(identityObject({
      ...requestObject().value,
      idCredPub: 'ff'.repeat(48),
    }));
    await expectWorkflowError(createIdentityWorkflow(fixture.deps).recover(startInput()), 'IDENTITY_MISMATCH');
    expect(fixture.store.create).not.toHaveBeenCalled();
  });
});

describe('IdentityWorkflow status and listing', () => {
  it('rejects an identity pinned to an old AR subset before status continuation or mutation', async () => {
    const current = context();
    const oldSubset = context({ arsInfos: { 1: current.arsInfos[1]!, 2: current.arsInfos[2]! } });
    const fixture = setup();
    const record = awaitingRecord();
    record.contextHash = contextFingerprint(oldSubset);
    fixture.store.records.set(IDENTITY_ID, record);

    await expectWorkflowError(createIdentityWorkflow(fixture.deps).status({
      identityId: IDENTITY_ID, callbackUrl: callback(),
    }), 'CONTEXT_MISMATCH');

    expect(fixture.provider.retrieve).not.toHaveBeenCalled();
    expect(fixture.store.save).not.toHaveBeenCalled();
    expect(fixture.store.createIdentity).not.toHaveBeenCalled();
    expect(fixture.store.records.get(IDENTITY_ID)).toEqual(record);
  });

  it('returns awaiting verification without fetching when no callback is supplied', async () => {
    const fixture = setup();
    fixture.store.records.set(IDENTITY_ID, awaitingRecord());
    const result = await createIdentityWorkflow(fixture.deps).status({ identityId: IDENTITY_ID });
    expect(result.status).toBe('pending');
    expect(fixture.deps.resolveNetwork).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(fixture.store.load).toHaveBeenCalledWith(NETWORK, IDENTITY_ID);
    expect(fixture.provider.retrieve).not.toHaveBeenCalled();
    expect(fixture.store.save).not.toHaveBeenCalled();
  });

  it('rechecks provider context before any non-ready status HTTP continuation', async () => {
    const fixture = setup({
      loadContext: vi.fn(async () => { throw new IdentityProviderError('PROVIDER_DISABLED'); }),
    });
    fixture.store.records.set(IDENTITY_ID, awaitingRecord());
    await expect(createIdentityWorkflow(fixture.deps).status({
      identityId: IDENTITY_ID, callbackUrl: callback(),
    })).rejects.toMatchObject({ code: 'PROVIDER_DISABLED' });
    expect(fixture.provider.retrieve).not.toHaveBeenCalled();
    expect(fixture.sources.createAgreement).not.toHaveBeenCalled();
    expect(fixture.store.save).not.toHaveBeenCalled();
  });

  it.each([
    ['wrong scheme', callback().replace('ccd-id-manager:', 'https:')],
    ['wrong host', callback().replace('//identity/', '//other/')],
    ['wrong identity', callback('018f47a2-43d2-7ad9-8b5e-89d810f95a22')],
    ['query instead of fragment', callback().replace('#', '?')],
    ['foreign origin', callback(IDENTITY_ID, 'https://attacker.example/steal')],
    ['credentials in origin', callback(IDENTITY_ID, 'https://issuer.example.test@attacker.example/steal')],
    ['non-URL retrieval', `ccd-id-manager://identity/${IDENTITY_ID}#code_uri=not-a-url`],
  ])('rejects %s callback before retrieval', async (_name, callbackUrl) => {
    const fixture = setup();
    fixture.store.records.set(IDENTITY_ID, awaitingRecord());
    await expectWorkflowError(createIdentityWorkflow(fixture.deps).status({ identityId: IDENTITY_ID, callbackUrl }), 'INVALID_INPUT');
    expect(fixture.provider.retrieve).not.toHaveBeenCalled();
    expect(fixture.store.save).not.toHaveBeenCalled();
  });

  it.each([
    ['pending', 'pending'],
    ['error', 'unknown'],
  ] as const)('persists one sanitized %s retrieval result without polling', async (status, publicStatus) => {
    const fixture = setup();
    fixture.store.records.set(IDENTITY_ID, awaitingRecord());
    vi.mocked(fixture.provider.retrieve).mockResolvedValue({ status });
    const result = await createIdentityWorkflow(fixture.deps).status({ identityId: IDENTITY_ID, callbackUrl: callback() });
    expect(result.status).toBe(publicStatus);
    expect(fixture.provider.retrieve).toHaveBeenCalledOnce();
    expect(fixture.store.save).toHaveBeenCalledOnce();
    expect(fixture.store.records.get(IDENTITY_ID)).toMatchObject({
      status,
      retrievalUrl: 'https://issuer.example.test/v1/result/opaque',
    });
  });

  it('persists a provider key failure and its permanent reservation together', async () => {
    const fixture = setup();
    fixture.store.records.set(IDENTITY_ID, {
      ...awaitingRecord(), requestAttemptId: '018f47a2-43d2-7ad9-8b5e-89d810f95a22',
    });
    vi.mocked(fixture.provider.retrieve).mockResolvedValue({ status: 'error', failure: 'key_failed' });

    await expect(createIdentityWorkflow(fixture.deps).status({
      identityId: IDENTITY_ID, callbackUrl: callback(),
    })).resolves.toMatchObject({ status: 'failed' });

    expect(fixture.store.save).toHaveBeenCalledWith(expect.objectContaining({ status: 'error' }),
      expect.objectContaining({ status: 'awaiting_verification' }), 'failed');
    expect([...fixture.store.reservations.values()][0]?.get(2)).toMatchObject({ state: 'failed' });
    expect(fixture.store.records.get(IDENTITY_ID)).toMatchObject({
      status: 'error',
      confirmedFailure: {
        kind: 'authenticated_key_failure', requestAttemptId: expect.any(String),
      },
    });
  });

  it('keeps authenticated key failure on a historical attempt inconclusive without failing its reservation', async () => {
    const fixture = setup();
    fixture.store.records.set(IDENTITY_ID, awaitingRecord());
    vi.mocked(fixture.provider.retrieve).mockResolvedValue({ status: 'error', failure: 'key_failed' });
    await expect(createIdentityWorkflow(fixture.deps).status({
      identityId: IDENTITY_ID, callbackUrl: callback(),
    })).resolves.toMatchObject({ status: 'unknown' });
    expect(fixture.store.save).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'error' }),
      expect.objectContaining({ status: 'awaiting_verification' }),
    );
    expect(fixture.store.save).not.toHaveBeenCalledWith(expect.anything(), expect.anything(), 'failed');
  });

  it('validates idCredPub and the full issuance pre-identity object before storing ready identity', async () => {
    const fixture = setup();
    const record = awaitingRecord();
    record.label = 'OperatorLabel';
    fixture.store.records.set(IDENTITY_ID, record);
    vi.mocked(fixture.provider.retrieve).mockResolvedValue({ status: 'done', identity: identityObject(record.request!.value) });
    await expect(createIdentityWorkflow(fixture.deps).status({ identityId: IDENTITY_ID, callbackUrl: callback() })).resolves.toMatchObject({ status: 'issued' });
    const completed = fixture.store.records.get(IDENTITY_ID);
    expect(completed).toMatchObject({ status: 'ready', label: 'OperatorLabel', identity: expect.any(Object) });
    for (const field of ['request','requestAttemptId','postIssuance','authorizationUrl','retrievalUrl','confirmedFailure']) {
      expect(completed).not.toHaveProperty(field);
    }

    for (const mismatch of [
      identityObject({ ...record.request!.value, idCredPub: 'ff'.repeat(48) }),
      identityObject({ ...record.request!.value, proofsOfKnowledge: 'ff'.repeat(64) }),
    ]) {
      fixture.store.records.set(IDENTITY_ID, structuredClone(record));
      fixture.store.save.mockClear();
      vi.mocked(fixture.provider.retrieve).mockResolvedValue({ status: 'done', identity: mismatch });
      await expectWorkflowError(createIdentityWorkflow(fixture.deps).status({ identityId: IDENTITY_ID, callbackUrl: callback() }), 'IDENTITY_MISMATCH');
      expect(fixture.store.save).not.toHaveBeenCalled();
      expect(fixture.store.records.get(IDENTITY_ID)).toEqual(record);
    }
  });

  it('preserves the record and makes no retry when retrieval fails', async () => {
    const fixture = setup();
    const record = awaitingRecord();
    fixture.store.records.set(IDENTITY_ID, record);
    vi.mocked(fixture.provider.retrieve).mockRejectedValue(new Error(PRIVATE_DIAGNOSTIC));
    await expectWorkflowError(createIdentityWorkflow(fixture.deps).status({ identityId: IDENTITY_ID, callbackUrl: callback() }), 'PROVIDER_FAILED');
    expect(fixture.provider.retrieve).toHaveBeenCalledOnce();
    expect(fixture.store.save).not.toHaveBeenCalled();
    expect(fixture.store.records.get(IDENTITY_ID)).toEqual(record);
  });

  it('lists only agent-safe summaries from validated store records', async () => {
    const fixture = setup();
    fixture.store.records.set(IDENTITY_ID, readyRecord());
    const summaries = await createIdentityWorkflow(fixture.deps).list({});
    expect(summaries).toEqual([{
      identityId: IDENTITY_ID,
      network: NETWORK,
      identityProviderIndex: 7,
      identityIndex: 2,
      status: 'issued',
      sourceId: SOURCE_ID,
    }]);
    expect(JSON.stringify(summaries)).not.toContain('chosenAttributes');
    expect(JSON.stringify(summaries)).not.toContain('rootPublicKey');
    expect(fixture.deps.resolveNetwork).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(fixture.store.list).toHaveBeenCalledWith(NETWORK);
    expect(JSON.stringify(summaries)).not.toContain('walletProxyUrl');

  });

  it('rejects a selected-network list containing a foreign-network record', async () => {
    const fixture = setup();
    fixture.store.list.mockResolvedValue([
      readyRecord({ selection: { ...selection(), network: `ccd:${'34'.repeat(16)}` } }),
    ]);
    await expectWorkflowError(createIdentityWorkflow(fixture.deps).list({}), 'STORAGE_FAILED');
    expect(fixture.sources.createAgreement).not.toHaveBeenCalled();
    expect(fixture.deps.loadContext).not.toHaveBeenCalled();
  });
});

describe('IdentityWorkflow account preparation', () => {
  it('rejects an identity pinned to an old AR subset before account-opening work or mutation', async () => {
    const current = context();
    const oldSubset = context({ arsInfos: { 1: current.arsInfos[1]!, 2: current.arsInfos[2]! } });
    const fixture = setup();
    const record = readyRecord({ contextHash: contextFingerprint(oldSubset) });
    fixture.store.records.set(IDENTITY_ID, record);

    await expectWorkflowError(createIdentityWorkflow(fixture.deps).prepareAccount({
      identityId: IDENTITY_ID, credentialNumber: 0, publicKeys: { '0': PUBLIC_KEY }, credentialThreshold: 1,
      expirySeconds: NOW_MS / 1000 + 60,
    }), 'CONTEXT_MISMATCH');

    expect(fixture.sources.createAgreement).not.toHaveBeenCalled();
    expect(fixture.crypto.credential).not.toHaveBeenCalled();
    expect(fixture.store.loadCredentials).toHaveBeenCalledOnce();
    expect(fixture.store.saveCredentials).not.toHaveBeenCalled();
    expect(fixture.store.records.get(IDENTITY_ID)).toEqual(record);
  });

  it('creates a multi-key signing handoff with the requested threshold, openings, and no account-key derivation', async () => {
    const fixture = setup();
    const record = await seedReady(fixture);
    vi.mocked(fixture.deps.resolveNetwork).mockClear();
    const expirySeconds = NOW_MS / 1000 + 600;

    const result = await createIdentityWorkflow(fixture.deps).prepareAccount({
      identityId: IDENTITY_ID,
      credentialNumber: 0,
      publicKeys: { '0': PUBLIC_KEY, '7': '12'.repeat(32) }, credentialThreshold: 2,
      expirySeconds,
    });

    expect(fixture.crypto.credential).toHaveBeenCalledOnce();
    const [input, expiry] = vi.mocked(fixture.crypto.credential).mock.calls[0]!;
    expect(input).toMatchObject({
      ipInfo: context().ipInfo,
      globalContext: context().globalContext,
      arsInfos: context().arsInfos,
      idObject: record.identity!.value,
      revealedAttributes: [],
      credNumber: 0,
      credentialPublicKeys: {
        keys: {
          0: { schemeId: 'Ed25519', verifyKey: PUBLIC_KEY },
          7: { schemeId: 'Ed25519', verifyKey: '12'.repeat(32) },
        },
        threshold: 2,
      },
    });
    expect(input.idCredSec).toMatch(/^[0-9a-f]{64}$/);
    expect(input.prfKey).toMatch(/^[0-9a-f]{64}$/);
    expect(input.sigRetrievelRandomness).toMatch(/^[0-9a-f]{64}$/);
    expect(input.attributeRandomness).toEqual({
      firstName: expect.stringMatching(/^[0-9a-f]{64}$/),
      lastName: expect.stringMatching(/^[0-9a-f]{64}$/),
      sex: expect.stringMatching(/^[0-9a-f]{64}$/),
      dob: expect.stringMatching(/^[0-9a-f]{64}$/),
      countryOfResidence: expect.stringMatching(/^[0-9a-f]{64}$/),
      nationality: expect.stringMatching(/^[0-9a-f]{64}$/),
      idDocType: expect.stringMatching(/^[0-9a-f]{64}$/),
      idDocNo: expect.stringMatching(/^[0-9a-f]{64}$/),
      idDocIssuer: expect.stringMatching(/^[0-9a-f]{64}$/),
      idDocIssuedAt: expect.stringMatching(/^[0-9a-f]{64}$/),
      idDocExpiresAt: expect.stringMatching(/^[0-9a-f]{64}$/),
      nationalIdNo: expect.stringMatching(/^[0-9a-f]{64}$/),
      taxIdNo: expect.stringMatching(/^[0-9a-f]{64}$/),
      lei: expect.stringMatching(/^[0-9a-f]{64}$/),
      legalName: expect.stringMatching(/^[0-9a-f]{64}$/),
      legalCountry: expect.stringMatching(/^[0-9a-f]{64}$/),
      businessNumber: expect.stringMatching(/^[0-9a-f]{64}$/),
      registrationAuth: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(TransactionExpiry.toUnwrappedJSON(expiry)).toBe(BigInt(expirySeconds));
    expect(result).toEqual({
      network: NETWORK,
      credDeploymentHex: expect.stringMatching(/^[0-9a-f]+$/),
      accountAddress: getAccountAddress(credentialPayload().unsignedCdi.credId).address,
      credentialNumber: 0,
      expirySeconds,
    });
    expect(result.credDeploymentHex.startsWith(`00${BigInt(expirySeconds).toString(16).padStart(16, '0')}`)).toBe(true);
    expect(result).not.toHaveProperty('randomness');
    expect(result).not.toHaveProperty('identity');
    expect(fixture.deps.resolveNetwork).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(fixture.device.transferred[0]!.every((byte) => byte === 0)).toBe(true);
  });

  it.each([
    ['not ready', { ...awaitingRecord(), status: 'pending' as const }, { credentialNumber: 0, publicKeys: { '0': PUBLIC_KEY }, credentialThreshold: 1, expirySeconds: NOW_MS / 1000 + 1 }, 'IDENTITY_NOT_READY'],
    ['negative credential', readyRecord(), { credentialNumber: -1, publicKeys: { '0': PUBLIC_KEY }, credentialThreshold: 1, expirySeconds: NOW_MS / 1000 + 1 }, 'INVALID_INPUT'],
    ['fractional credential', readyRecord(), { credentialNumber: 0.5, publicKeys: { '0': PUBLIC_KEY }, credentialThreshold: 1, expirySeconds: NOW_MS / 1000 + 1 }, 'INVALID_INPUT'],
    ['byte overflow', readyRecord(), { credentialNumber: 256, publicKeys: { '0': PUBLIC_KEY }, credentialThreshold: 1, expirySeconds: NOW_MS / 1000 + 1 }, 'INVALID_INPUT'],
    ['identity maximum', readyRecord(), { credentialNumber: 3, publicKeys: { '0': PUBLIC_KEY }, credentialThreshold: 1, expirySeconds: NOW_MS / 1000 + 1 }, 'CREDENTIAL_LIMIT'],
    ['expired', readyRecord(), { credentialNumber: 0, publicKeys: { '0': PUBLIC_KEY }, credentialThreshold: 1, expirySeconds: NOW_MS / 1000 }, 'INVALID_INPUT'],
    ['unsafe expiry', readyRecord(), { credentialNumber: 0, publicKeys: { '0': PUBLIC_KEY }, credentialThreshold: 1, expirySeconds: Number.MAX_SAFE_INTEGER + 1 }, 'INVALID_INPUT'],
    ['invalid public key', readyRecord(), { credentialNumber: 0, publicKeys: { '0': 'aa' }, credentialThreshold: 1, expirySeconds: NOW_MS / 1000 + 1 }, 'INVALID_INPUT'],
    ['empty public keys', readyRecord(), { credentialNumber: 0, publicKeys: {}, credentialThreshold: 1, expirySeconds: NOW_MS / 1000 + 1 }, 'INVALID_INPUT'],
    ['zero threshold', readyRecord(), { credentialNumber: 0, publicKeys: { '0': PUBLIC_KEY }, credentialThreshold: 0, expirySeconds: NOW_MS / 1000 + 1 }, 'INVALID_INPUT'],
    ['threshold above key count', readyRecord(), { credentialNumber: 0, publicKeys: { '0': PUBLIC_KEY }, credentialThreshold: 2, expirySeconds: NOW_MS / 1000 + 1 }, 'INVALID_INPUT'],
    ['noncanonical key index', readyRecord(), { credentialNumber: 0, publicKeys: { '00': PUBLIC_KEY }, credentialThreshold: 1, expirySeconds: NOW_MS / 1000 + 1 }, 'INVALID_INPUT'],
    ['key index overflow', readyRecord(), { credentialNumber: 0, publicKeys: { '256': PUBLIC_KEY }, credentialThreshold: 1, expirySeconds: NOW_MS / 1000 + 1 }, 'INVALID_INPUT'],
    ['duplicate parsed indexes', readyRecord(), { credentialNumber: 0, publicKeys: { '0': PUBLIC_KEY, '00': '12'.repeat(32) }, credentialThreshold: 1, expirySeconds: NOW_MS / 1000 + 1 }, 'INVALID_INPUT'],
  ])('rejects %s before hardware and credential creation', async (_name, record, input, code) => {
    const fixture = setup();
    fixture.store.records.set(IDENTITY_ID, record);
    await expectWorkflowError(
      createIdentityWorkflow(fixture.deps).prepareAccount({ identityId: IDENTITY_ID, ...input }),
      code,
    );
    if (code === 'CREDENTIAL_LIMIT') expect(fixture.sources.createAgreement).toHaveBeenCalledOnce();
    else expect(fixture.sources.createAgreement).not.toHaveBeenCalled();
    expect(fixture.crypto.credential).not.toHaveBeenCalled();
  });

  it('validates current context against the stored fingerprint before hardware use', async () => {
    const fixture = setup({
      loadContext: async () => context({
        ipInfo: { ...context().ipInfo, ipVerifyKey: 'fe'.repeat(32) },
      }),
    });
    fixture.store.records.set(IDENTITY_ID, readyRecord());
    await expectWorkflowError(createIdentityWorkflow(fixture.deps).prepareAccount({
      identityId: IDENTITY_ID,
      credentialNumber: 0,
      publicKeys: { '0': PUBLIC_KEY }, credentialThreshold: 1,
      expirySeconds: NOW_MS / 1000 + 1,
    }), 'CONTEXT_MISMATCH');
    expect(fixture.sources.createAgreement).not.toHaveBeenCalled();
  });

  it('requires current MCP provider enablement before account-preparation hardware or crypto work', async () => {
    const fixture = setup({
      loadContext: vi.fn(async () => { throw new IdentityProviderError('PROVIDER_DISABLED'); }),
    });
    const existing = readyRecord();
    fixture.store.records.set(IDENTITY_ID, existing);

    await expect(createIdentityWorkflow(fixture.deps).prepareAccount({
      identityId: IDENTITY_ID,
      credentialNumber: 0,
      publicKeys: { '0': PUBLIC_KEY }, credentialThreshold: 1,
      expirySeconds: NOW_MS / 1000 + 1,
    })).rejects.toMatchObject({ code: 'PROVIDER_DISABLED' });

    expect(fixture.sources.createAgreement).not.toHaveBeenCalled();
    expect(fixture.crypto.credential).not.toHaveBeenCalled();
    expect(fixture.store.saveCredentials).not.toHaveBeenCalled();
    expect(fixture.store.records.get(IDENTITY_ID)).toEqual(existing);
  });

  it('rejects a stored SDK namespace forged against the verified full genesis', async () => {
    const fixture = setup();
    const record = readyRecord();
    record.selection = { ...record.selection, sdkNetwork: 'Mainnet' };
    fixture.store.records.set(IDENTITY_ID, record);
    await expectWorkflowError(createIdentityWorkflow(fixture.deps).prepareAccount({
      identityId: IDENTITY_ID,
      credentialNumber: 0,
      publicKeys: { '0': PUBLIC_KEY }, credentialThreshold: 1,
      expirySeconds: NOW_MS / 1000 + 1,
    }), 'CONTEXT_MISMATCH');
    expect(fixture.sources.createAgreement).not.toHaveBeenCalled();
    expect(fixture.crypto.credential).not.toHaveBeenCalled();
  });

  it('clears transferred secrets, preserves the stored identity, and does not retry on credential failure', async () => {
    const fixture = setup();
    const record = await seedReady(fixture);
    vi.mocked(fixture.crypto.credential).mockImplementation(() => { throw new Error(PRIVATE_DIAGNOSTIC); });

    await expectWorkflowError(createIdentityWorkflow(fixture.deps).prepareAccount({
      identityId: IDENTITY_ID,
      credentialNumber: 0,
      publicKeys: { '0': PUBLIC_KEY }, credentialThreshold: 1,
      expirySeconds: NOW_MS / 1000 + 60,
    }), 'CRYPTO_FAILED');
    expect(fixture.crypto.credential).toHaveBeenCalledOnce();
    expect(fixture.store.save).not.toHaveBeenCalled();
    expect(fixture.store.records.get(IDENTITY_ID)).toEqual(record);
    expect(fixture.device.transferred).toHaveLength(2);
    expect(fixture.device.transferred.every((secret) => secret.every((byte) => byte === 0))).toBe(true);
  });
});
