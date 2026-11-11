import { deriveIdentitySourceId,getAccountCredentialObservation } from '@ccd-agent-kit/config-utils';
import { createHash } from 'node:crypto';
import { access,mkdir,symlink,writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
import {
AccountAddress,BlockHash,CredentialRegistrationId,RpcError,TransactionStatusEnum,
VerificationRequestV1,getAccountAddress,
} from '@concordium/web-sdk';
import { createIdentityProofService } from '../../src/core/identityProofs.js';
import { IdentityProviderError } from '../../src/core/providers/error.js';
import { IdentityWorkflowError } from '../../src/core/workflowErrors.js';
import {
createEncryptedIdentityStore,
createDefaultIdentityProofService,createDefaultIdentityWorkflow,createFinalizedAccountObserver,
createIdentityProviderClient,loadIdentityContext
} from '../../src/core/workflowInfrastructure.js';
import type { IdentityWorkflowDependencies,StoredIdentity,StoredIdentityLifecycle } from '../../src/core/workflowTypes.js';
import { identityProviderServiceFixture } from '../helpers.js';
import { identityWorkflowFixture } from '../mcpTestHelpers.js';
import { context,credentialPayload,identityObject,requestObject,sourceService } from '../workflowFixtures.js';
import { useTestXdg } from '../xdgTestHelpers.js';
import { PUBLIC_KEY } from '../yubikeyHelpers.js';

const infrastructureMocks = vi.hoisted(() => ({
  resolveNetwork: vi.fn(),
  getIdentityContextSnapshot: vi.fn(),
  loadAccountCredentials: vi.fn(),
  resolveAccountLabel: vi.fn(),
  nodeClient: undefined as unknown,
  nodeConstructor: vi.fn(),
  createPivTransport: vi.fn(() => ({ transport: true })),
  createIdentityYubiKeyService: vi.fn(),
  createIdentityWorkflow: vi.fn(),
  createIdentityProofService: vi.fn(),
  withIdentityMaterial: vi.fn(),
}));
const filesystemFailures = vi.hoisted(() => ({
  lstat: undefined as { target: string; error: Error } | undefined,
  open: undefined as { target: string; error: Error } | undefined,
  readdir: undefined as { target: string; error: Error } | undefined,
  access: undefined as Error | undefined,
  rename: undefined as Error | { target: string; error: Error } | undefined,
  remove: undefined as Error | undefined,
  write: undefined as { target: string; error: Error; afterWrite?: boolean } | undefined,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    async lstat(target: Parameters<typeof actual.lstat>[0]) {
      if (filesystemFailures.lstat?.target === String(target)) {
        const { error } = filesystemFailures.lstat;
        filesystemFailures.lstat = undefined;
        throw error;
      }
      return actual.lstat(target);
    },
    async open(target: Parameters<typeof actual.open>[0], flags: Parameters<typeof actual.open>[1], mode?: Parameters<typeof actual.open>[2]) {
      if (filesystemFailures.open?.target === String(target)) {
        const { error } = filesystemFailures.open;
        filesystemFailures.open = undefined;
        throw error;
      }
      return actual.open(target, flags, mode);
    },
    async readdir(target: Parameters<typeof actual.readdir>[0], options?: Parameters<typeof actual.readdir>[1]) {
      if (filesystemFailures.readdir?.target === String(target)) {
        const { error } = filesystemFailures.readdir;
        filesystemFailures.readdir = undefined;
        throw error;
      }
      return actual.readdir(target, options as never);
    },
    async access(target: Parameters<typeof actual.access>[0], mode?: Parameters<typeof actual.access>[1]) {
      if (filesystemFailures.access) {
        const failure = filesystemFailures.access;
        filesystemFailures.access = undefined;
        throw failure;
      }
      return actual.access(target, mode);
    },
    async rename(oldPath: Parameters<typeof actual.rename>[0], newPath: Parameters<typeof actual.rename>[1]) {
      if (filesystemFailures.rename instanceof Error
        || filesystemFailures.rename?.target === String(newPath)) {
        const configured = filesystemFailures.rename;
        filesystemFailures.rename = undefined;
        throw configured instanceof Error ? configured : configured.error;
      }
      return actual.rename(oldPath, newPath);
    },
    async rm(target: Parameters<typeof actual.rm>[0], options?: Parameters<typeof actual.rm>[1]) {
      if (filesystemFailures.remove) {
        const failure = filesystemFailures.remove;
        filesystemFailures.remove = undefined;
        throw failure;
      }
      return actual.rm(target, options);
    },
    async writeFile(
      target: Parameters<typeof actual.writeFile>[0],
      data: Parameters<typeof actual.writeFile>[1],
      options?: Parameters<typeof actual.writeFile>[2],
    ) {
      if (filesystemFailures.write?.target === String(target)) {
        const { error, afterWrite } = filesystemFailures.write;
        filesystemFailures.write = undefined;
        if (afterWrite === true) await actual.writeFile(target, data, options);
        throw error;
      }
      return actual.writeFile(target, data, options);
    },
  };
});

vi.mock('@ccd-agent-kit/config-utils', async (importOriginal) => ({
  ...await importOriginal<typeof import('@ccd-agent-kit/config-utils')>(),
  resolveNetwork: infrastructureMocks.resolveNetwork,
  getIdentityContextSnapshot: infrastructureMocks.getIdentityContextSnapshot,
  loadAccountCredentials: infrastructureMocks.loadAccountCredentials,
  resolveAccountLabel: infrastructureMocks.resolveAccountLabel,
}));

vi.mock('@concordium/web-sdk/nodejs', () => ({
  credentials: { createSsl: vi.fn(() => ({})), createInsecure: vi.fn(() => ({})) },
  ConcordiumGRPCNodeClient: infrastructureMocks.nodeConstructor.mockImplementation(
    function mockNodeClient() { return infrastructureMocks.nodeClient; },
  ),
}));

vi.mock('@ccd-agent-kit/piv-utils', async importOriginal => ({
  ...await importOriginal<typeof import('@ccd-agent-kit/piv-utils')>(),
  createPivTransport: infrastructureMocks.createPivTransport,
  createIdentityYubiKeyService: infrastructureMocks.createIdentityYubiKeyService,
}));
vi.mock('../../src/core/identityWorkflow.js', () => ({
  createIdentityWorkflow: infrastructureMocks.createIdentityWorkflow,
}));
vi.mock('../../src/core/identityProofs.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/core/identityProofs.js')>(),
  createIdentityProofService: infrastructureMocks.createIdentityProofService,
}));
vi.mock('../../src/core/identityMaterialSession.js', () => ({
  withIdentityMaterial: infrastructureMocks.withIdentityMaterial,
}));

const xdg = useTestXdg('infra-', ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME']);

const ID_CRED_PUB = 'ab'.repeat(48);
const preIdentity = {
  idCredPub: ID_CRED_PUB,
  choiceArData: { arIdentities: [1], threshold: 1 },
  ipArData: { '1': { encPrfKeyShare: 'aa', proofComEncEq: 'bb' } },
  idCredSecCommitment: 'cc',
  prfKeyCommitmentWithIP: 'dd',
  prfKeySharingCoeffCommitments: ['ee'],
  proofsOfKnowledge: 'ff',
};
const identity = {
  v: 0,
  value: {
    preIdentityObject: preIdentity,
    attributeList: { createdAt: '202601', validTo: '202701', maxAccounts: 1, chosenAttributes: {} },
    signature: '11'.repeat(96),
  },
};

function expectError(value: unknown): Error {
  expect(value).toBeInstanceOf(Error);
  if (!(value instanceof Error)) throw new Error('Expected an error');
  return value;
}

function record(id = '35d15be8-61e8-42d9-9597-4e260a3df3f0'): StoredIdentityLifecycle {
  return {
    version: 1,
    id,
    selection: {
      network: 'testnet', sdkNetwork: 'Testnet', device: '123456',
      rootPublicKey: PUBLIC_KEY.toString('hex'), identityProviderIndex: 0,
      identityIndex: 2, walletProxyUrl: 'https://wallet.example',
    },
    contextHash: '12'.repeat(32), idCredPub: ID_CRED_PUB, status: 'pending',
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  filesystemFailures.access = undefined;
  filesystemFailures.lstat = undefined;
  filesystemFailures.open = undefined;
  filesystemFailures.readdir = undefined;
  filesystemFailures.rename = undefined;
  filesystemFailures.remove = undefined;
  filesystemFailures.write = undefined;
  infrastructureMocks.resolveNetwork.mockReset();
  infrastructureMocks.nodeConstructor.mockClear();
  infrastructureMocks.createPivTransport.mockClear();
  infrastructureMocks.createIdentityYubiKeyService.mockReset();
  infrastructureMocks.createIdentityWorkflow.mockReset();
});

describe('identity provider client', () => {
  it('recovers with one bounded GET containing the encoded recovery state', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(identity), {
      status: 200, headers: { 'content-type': 'application/json' },
    }));
    const client = createIdentityProviderClient(fetcher as typeof fetch);
    const request = { v: 0, value: { marker: 'request' } } as never;

    await expect(client.recover('https://idp.example/recover?foo=bar', request)).resolves.toEqual(identity);
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual' });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    const state = new URL(String(url)).searchParams.get('state');
    expect(JSON.parse(state!)).toEqual({ idRecoveryRequest: request });
  });

  it.each([
    ['pending', { status: 'pending' }, { status: 'pending' }],
    ['error', { status: 'error', detail: 'RAW_PROVIDER_DETAIL' }, { status: 'error' }],
    ['unbound failure', { status: 'error', detail: 'Identity object has failed' }, { status: 'error', failure: 'unconfirmed' }],
    ['missing identity', { status: 'error', detail: 'Identity object does not exist' }, { status: 'error' }],
    ['done', { status: 'done', token: { identityObject: identity } }, { status: 'done', identity }],
  ])('maps a %s retrieval response to the public result', async (_name, body, expected) => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(body), { status: 200 }));
    await expect(createIdentityProviderClient(fetcher as typeof fetch).retrieve('https://idp.example/token')).resolves.toEqual(expected);
    expect(fetcher.mock.calls[0]![1]).toMatchObject({ method: 'GET', redirect: 'manual' });
  });

  it('treats a recovery endpoint HTTP 404 as definitive absence without depending on its body', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      code: 404, message: 'ID object not found in database',
    }), { status: 404, headers: { 'content-type': 'application/json' } }));
    const failure = expectError(await createIdentityProviderClient(fetcher as typeof fetch)
      .recover('https://idp.example/recover', { v: 0 } as never).catch((error: unknown) => error));
    expect(fetcher).toHaveBeenCalledOnce();
    expect(failure).toBeInstanceOf(IdentityWorkflowError);
    expect((failure as IdentityWorkflowError).code).toBe('IDENTITY_NOT_FOUND');
    expect(failure.message).toMatch(/not found|404/i);
    expect(failure.message).not.toContain('RAW_PROVIDER_DETAIL');
  });

  it.each([
    ['plain body', 'not found'],
    ['HTML body', '<html>not found</html>'],
    ['unrelated JSON', JSON.stringify({ code: 7, message: 'different wording' })],
    ['empty body', ''],
    ['malformed JSON', '{"code":404'],
  ])('counts recovery HTTP 404 with %s as absence', async (_label, body) => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(body, { status: 404 }));
    const failure = expectError(await createIdentityProviderClient(fetcher)
      .recover('https://idp.example/recover', { v: 0 } as never).catch((error: unknown) => error));
    expect(failure).toMatchObject({ code: 'IDENTITY_NOT_FOUND' });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('classifies an oversized recovery 404 by status and cancels its body safely', async () => {
    const body = `${JSON.stringify({ code: 404, message: 'ID object not found in database' })}${' '.repeat(1024 * 1024)}`;
    const failure = expectError(await createIdentityProviderClient(vi.fn<typeof fetch>(async () =>
      new Response(body, { status: 404 })))
      .recover('https://idp.example/recover', { v: 0 } as never).catch((error: unknown) => error));
    expect(failure).toMatchObject({ code: 'IDENTITY_NOT_FOUND' });
  });

  it('preserves recovery absence when cancelling the HTTP 404 body rejects', async () => {
    const body = new ReadableStream<Uint8Array>({ cancel() { throw new Error('cancel failed'); } });
    const failure = expectError(await createIdentityProviderClient(vi.fn<typeof fetch>(async () =>
      new Response(body, { status: 404 })))
      .recover('https://idp.example/recover', { v: 0 } as never).catch((error: unknown) => error));
    expect(failure).toMatchObject({ code: 'IDENTITY_NOT_FOUND' });
  });

  it('preserves provider failure when cancelling a rejected creation response fails', async () => {
    const body = new ReadableStream<Uint8Array>({ cancel() { throw new Error('cancel failed'); } });
    await expect(createIdentityProviderClient(vi.fn<typeof fetch>(async () =>
      new Response(body, { status: 503 })))
      .createIssuanceContext('https://idp.example/issue', { v: 0 } as never, 'ccd:testnet'))
      .rejects.toMatchObject({ code: 'PROVIDER_FAILED' });
  });

  it.each([
    ['other status', JSON.stringify({ code: 404, message: 'ID object not found in database' }), 400],
    ['success body code', JSON.stringify({ code: 404, message: 'ID object not found in database' }), 200],
  ])('does not infer recovery absence from %s', async (_label, body, status) => {
    const failure = expectError(await createIdentityProviderClient(vi.fn<typeof fetch>(async () => new Response(body, { status })))
      .recover('https://idp.example/recover', { v: 0 } as never).catch((error: unknown) => error));
    expect(failure).toMatchObject({ code: 'PROVIDER_FAILED' });
  });

  it('creates a canonical POST body and derives status authority from the issuance origin', async () => {
    const created = {
      ctxId: 'context/with spaces',
      url: 'https://idp.example/verify/context',
      network: 'Testnet',
      expiresAt: '2026-10-17T12:00:00.000Z',
    };
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(created), { status: 200 }));
    const request = { v: 0, value: { marker: 'unchanged' } } as never;

    await expect(createIdentityProviderClient(fetcher).createIssuanceContext(
      'https://idp.example/mount/issue', request, 'ccd:testnet',
    )).resolves.toEqual({
      url: created.url,
      statusUrl: 'https://idp.example/agent-id/context%2Fwith%20spaces/identity-object',
    });

    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe('https://idp.example/mount/issue');
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/json' } });
    expect(JSON.parse(String(init?.body))).toEqual({
      network: 'ccd:testnet', state: JSON.stringify({ idObjectRequest: request }),
    });
    expect(JSON.parse(String(init?.body)).state).toBe(JSON.stringify({ idObjectRequest: request }));
  });

  it.each([
    ['non-200', new Response('{}', { status: 404 })],
    ['redirect', new Response('', { status: 302, headers: { location: 'https://idp.example/other' } })],
    ['missing URL', new Response(JSON.stringify({ ctxId: 'ctx' }), { status: 200 })],
    ['missing context ID', new Response(JSON.stringify({ url: 'https://idp.example/verify' }), { status: 200 })],
    ['dot context ID', new Response(JSON.stringify({ url: 'https://idp.example/verify', ctxId: '..' }), { status: 200 })],
    ['context ID deriving an oversized status URL', new Response(JSON.stringify({
      url: 'https://idp.example/verify', ctxId: 'ü'.repeat(2_048),
    }), { status: 200 })],
    ['non-loopback HTTP URL', new Response(JSON.stringify({ url: 'http://idp.example/verify' }), { status: 200 })],
    ['credentialed URL', new Response(JSON.stringify({ url: 'https://user:pass@idp.example/verify' }), { status: 200 })],
    ['primitive response', new Response('7', { status: 200 })],
  ])('rejects a malformed POST creation response: %s', async (_name, response) => {
    const client = createIdentityProviderClient(vi.fn<typeof fetch>(async () => response));
    await expect(client.createIssuanceContext(
      'https://idp.example/issue', { v: 0 } as never, 'ccd:testnet',
    )).rejects.toMatchObject({ code: 'PROVIDER_FAILED' });
  });

  it.each([
    ['cross-origin human URL', { url: 'https://verification.example/continue', ctxId: 'ctx' }],
    ['loopback human URL', { url: 'http://127.0.0.1:7011/continue', ctxId: 'ctx' }],
    ['ignored response metadata', {
      url: 'https://verification.example/continue', ctxId: 'ctx', network: 'unexpected',
      expiresAt: 'not-a-date', extension: { ignored: true },
    }],
  ])('accepts a safe %s response without granting its fields fetch authority', async (_name, response) => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(response), { status: 200 }));
    await expect(createIdentityProviderClient(fetcher).createIssuanceContext(
      'https://idp.example/issue', { v: 0 } as never, 'ccd:testnet',
    )).resolves.toEqual({
      url: response.url, statusUrl: 'https://idp.example/agent-id/ctx/identity-object',
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each([
    ['pending', { status: 'pending' }, { status: 'pending' }],
    ['sanitized error', { status: 'error', detail: 'RAW_PROVIDER_DETAIL' }, { status: 'error' }],
    ['key failure', { status: 'error', failure: 'key_failed' }, { status: 'error', failure: 'key_failed' }],
    ['done', { status: 'done', identityObject: JSON.stringify(identity) }, { status: 'done', identity }],
  ])('polls one POST context %s response from its derived mount-relative URL', async (_name, body, expected) => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(body), { status: 200 }));
    const result = expect(createIdentityProviderClient(fetcher).pollIssuanceContext(
      'https://idp.example/mount/context%2Fwith%20spaces/identity-object',
    ));
    if (expected === undefined) await result.rejects.toMatchObject({ code: 'PROVIDER_FAILED' });
    else await result.resolves.toEqual(expected);
    expect(String(fetcher.mock.calls[0]![0])).toBe('https://idp.example/mount/context%2Fwith%20spaces/identity-object');
    expect(fetcher.mock.calls[0]![1]).toMatchObject({ method: 'GET', redirect: 'manual' });
  });

  it.each([
    ['HTTP 404', new Response('{}', { status: 404 })],
    ['array response', new Response('[]', { status: 200 })],
    ['object identity', new Response(JSON.stringify({ status: 'done', identityObject: identity }), { status: 200 })],
    ['invalid identity JSON', new Response(JSON.stringify({ status: 'done', identityObject: '{' }), { status: 200 })],
  ])('rejects POST context polling %s as provider failure', async (_name, response) => {
    await expect(createIdentityProviderClient(vi.fn<typeof fetch>(async () => response))
      .pollIssuanceContext('https://idp.example/ctx/identity-object'))
      .rejects.toMatchObject({ code: 'PROVIDER_FAILED' });
  });

  it.each([
    ['no response body', new Response(null, { status: 200 })],
    ['declared oversized body', new Response('{}', { status: 200, headers: { 'content-length': String(1024 * 1024 + 1) } })],
    ['provider failure', new Response('RAW_PROVIDER_DETAIL', { status: 500 })],
  ])('rejects %s with a sanitized provider classification', async (_case, response) => {
    const fetcher = vi.fn<typeof fetch>(async () => response);
    const failure = expectError(await createIdentityProviderClient(fetcher)
      .retrieve('https://idp.example/token').catch((error: unknown) => error));
    expect(failure).toBeInstanceOf(IdentityWorkflowError);
    expect((failure as IdentityWorkflowError).code).toBe('PROVIDER_FAILED');
    expect(failure.message).not.toContain('RAW_PROVIDER_DETAIL');
  });

  it.each([
    ['primitive JSON', '7'],
    ['unknown status', JSON.stringify({ status: 'unknown' })],
  ])('rejects retrieval %s as a provider failure', async (_case, body) => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(body, { status: 200 }));
    const failure = expectError(await createIdentityProviderClient(fetcher)
      .retrieve('https://idp.example/token').catch((error: unknown) => error));
    expect(failure).toBeInstanceOf(IdentityWorkflowError);
    expect((failure as IdentityWorkflowError).code).toBe('PROVIDER_FAILED');
  });

  it('preserves provider failure classification when oversized-stream cancellation rejects', async () => {
    const cancel = vi.fn(async () => { throw new Error('cancel failed'); });
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(1024 * 1024 + 1)); },
      cancel,
    });
    const fetcher = vi.fn<typeof fetch>(async () => new Response(body, { status: 200 }));

    const failure = expectError(await createIdentityProviderClient(fetcher)
      .retrieve('https://idp.example/token').catch((error: unknown) => error));
    expect(failure).toBeInstanceOf(IdentityWorkflowError);
    expect((failure as IdentityWorkflowError).code).toBe('PROVIDER_FAILED');
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each([
    new Response('{"detail":"RAW_PROVIDER_DETAIL"', { status: 200 }),
    new Response(JSON.stringify({ status: 'done', token: {} }), { status: 200 }),
    new Response('x'.repeat(1024 * 1024 + 1), { status: 200 }),
    new Response('', { status: 302, headers: { location: 'https://evil.example' } }),
  ])('rejects malformed, oversized, or redirected retrieval responses without raw details', async (response) => {
    const fetcher = vi.fn<typeof fetch>(async () => response);
    const failure = expectError(await createIdentityProviderClient(fetcher as typeof fetch)
      .retrieve('https://idp.example/token').catch((error: unknown) => error));
    expect(failure.message).not.toContain('RAW_PROVIDER_DETAIL');
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('aborts a request after ten seconds', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>((_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }));
    const pending = createIdentityProviderClient(fetcher as typeof fetch).retrieve('https://idp.example/token');
    const expectation = expect(pending).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(10_001);
    await expectation;
  });
});

describe('encrypted store filesystem failures', () => {
  const genesisHash = '12'.repeat(32);
  const reference = genesisHash.slice(0, 32);
  const network = { caip2: `ccd:${reference}`, genesisHash, sdkNetwork: 'Testnet' as const };
  const id = '35'.repeat(32);
  const key = Buffer.alloc(32, 7);
  const rootPublicKey = PUBLIC_KEY.toString('hex');
  const indexRecord = {
    file: `${id}.json`, recipeVersion: 1 as const,
    selection: {
      device: '123456', rootPublicKey,
      rootPublicKeyFingerprint: createHash('sha256').update(Buffer.from(rootPublicKey, 'hex')).digest('hex'),
      identityProviderIndex: 0, identityIndex: 2, walletProxyUrl: 'https://wallet.example',
    },
    workflow: { status: 'ready' as const, contextHash: '12'.repeat(32), idCredPub: ID_CRED_PUB },
  };

  it('does not treat an unreadable current network as an empty reservation scope', async () => {
    const store = createEncryptedIdentityStore();
    await store.bootstrapNetwork(network);
    filesystemFailures.lstat = {
      target: path.join(process.env.XDG_DATA_HOME!, 'ccd-agent-kit', 'id-manager', reference),
      error: Object.assign(new Error('private inspection failure'), { code: 'EACCES' }),
    };
    await expect(store.listIdentityReservations({
      genesisHash, sourceId: deriveIdentitySourceId(rootPublicKey, 1),
      sdkNetwork: network.sdkNetwork, identityProviderIndex: 0,
    })).rejects.toMatchObject({ code: 'STORAGE_FAILED' });
    expect((await store.readIndex(network.caip2)).identities).toEqual({});
  });

  it.each([
    ['credential write', 'credentials.json', false],
    ['partial credential write', 'credentials.json', true],
    ['index write', 'index.json', false],
  ] as const)('leaves no registry files when fresh bootstrap fails during %s', async (_case, target, afterWrite) => {
    const directory = path.join(process.env.XDG_DATA_HOME!, 'ccd-agent-kit', 'id-manager', reference);
    filesystemFailures.write = {
      target: path.join(directory, target), error: new Error('registry write failed'),
      ...(afterWrite ? { afterWrite: true } : {}),
    };
    await expect(createEncryptedIdentityStore().bootstrapNetwork(network))
      .rejects.toMatchObject({ code: 'STORAGE_FAILED' });
    await expect(access(path.join(directory, 'index.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(path.join(directory, 'credentials.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preserves optional historical proxy metadata exactly while new records omit it', async () => {
    const store = createEncryptedIdentityStore();
    await store.bootstrapNetwork(network);
    const historical = record(id);
    historical.selection.network = network.caip2;
    await store.create(historical);
    await expect(store.load(network.caip2, id)).resolves.toMatchObject({
      selection: { walletProxyUrl: 'https://wallet.example' },
    });

    const fresh = record('36'.repeat(32));
    fresh.selection.network = network.caip2;
    delete fresh.selection.walletProxyUrl;
    await store.create(fresh);
    const index = await store.readIndex(network.caip2);
    expect(index.identities[fresh.id]!.selection).not.toHaveProperty('walletProxyUrl');
    expect(index.identities[id]!.selection.walletProxyUrl).toBe('https://wallet.example');
  });

  it('still rejects an unsafe historical proxy value while never following it', async () => {
    const store = createEncryptedIdentityStore();
    await store.bootstrapNetwork(network);
    const unsafe = record(id);
    unsafe.selection.network = network.caip2;
    unsafe.selection.walletProxyUrl = 'file:///protected/private-state';
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    await expect(store.create(unsafe)).rejects.toMatchObject({ code: 'STORAGE_FAILED' });
    expect(fetcher).not.toHaveBeenCalled();
    await expect(store.list(network.caip2)).resolves.toEqual([]);
  });

  it('rejects protected state paths that are symlinks', async () => {
    const dataRoot = path.join(process.env.XDG_DATA_HOME!, 'ccd-agent-kit');
    const outside = path.join(xdg.scratch(), 'outside-data');
    await mkdir(path.dirname(dataRoot), { recursive: true });
    await mkdir(outside);
    await symlink(outside, dataRoot);
    await expect(createEncryptedIdentityStore().bootstrapNetwork(network)).rejects.toMatchObject({ code: 'STORAGE_FAILED' });
  });

  it('rejects a non-directory identity-store root while listing', async () => {
    const root = path.join(process.env.XDG_DATA_HOME!, 'ccd-agent-kit', 'id-manager');
    await mkdir(path.dirname(root), { recursive: true });
    await writeFile(root, 'not a directory');
    await expect(createEncryptedIdentityStore().list(network.caip2)).rejects.toMatchObject({ code: 'STORAGE_FAILED' });
    await expect(createEncryptedIdentityStore().listIdentityMonitorCandidates(Date.now()))
      .rejects.toMatchObject({ code: 'STORAGE_FAILED' });
  });

  it('sanitizes a non-missing index inspection failure during scoped lookup', async () => {
    filesystemFailures.lstat = {
      target: path.join(process.env.XDG_DATA_HOME!, 'ccd-agent-kit', 'id-manager', reference, 'index.json'),
      error: Object.assign(new Error('private inspection failure'), { code: 'EACCES' }),
    };
    await expect(createEncryptedIdentityStore().load(network.caip2, id))
      .rejects.toMatchObject({ code: 'STORAGE_FAILED' });
    expect(filesystemFailures.lstat).toBeUndefined();
  });

  it('removes newly written ciphertext when durable index replacement fails', async () => {
    const store = createEncryptedIdentityStore();
    await store.bootstrapNetwork(network);
    filesystemFailures.rename = {
      target: path.join(process.env.XDG_DATA_HOME!, 'ccd-agent-kit', 'id-manager', reference, 'index.json'),
      error: new Error('index rename failed'),
    };
    await expect(store.createIdentity(network, id, indexRecord, identityObject(), key, null))
      .rejects.toMatchObject({ code: 'STORAGE_FAILED' });
    const ciphertext = path.join(process.env.XDG_DATA_HOME!, 'ccd-agent-kit', 'id-manager', reference, `${id}.json`);
    await expect(access(ciphertext)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(store.readIndex(network.caip2)).resolves.toMatchObject({ identities: {} });
  });

  it('sanitizes a ciphertext open failure before index mutation', async () => {
    const store = createEncryptedIdentityStore();
    await store.bootstrapNetwork(network);
    const ciphertext = path.join(process.env.XDG_DATA_HOME!, 'ccd-agent-kit', 'id-manager', reference, `${id}.json`);
    filesystemFailures.open = {
      target: ciphertext, error: Object.assign(new Error('private open failure'), { code: 'EACCES' }),
    };
    await expect(store.createIdentity(network, id, indexRecord, identityObject(), key, null))
      .rejects.toMatchObject({ code: 'STORAGE_FAILED' });
    await expect(store.readIndex(network.caip2)).resolves.toMatchObject({ identities: {} });
  });

  it('sanitizes a monitor candidate directory read failure', async () => {
    const store = createEncryptedIdentityStore();
    const reservationRoot = path.join(process.env.XDG_DATA_HOME!, 'ccd-agent-kit', 'id-manager');
    await store.reserveIdentityIndex({
      genesisHash, sourceId: deriveIdentitySourceId(rootPublicKey, 1), sdkNetwork: 'Testnet',
      identityProviderIndex: 0, identityIndex: 2, mode: 'explicit',
    });
    filesystemFailures.readdir = {
      target: reservationRoot, error: Object.assign(new Error('private directory failure'), { code: 'EACCES' }),
    };
    await expect(store.listIdentityMonitorCandidates(Date.now()))
      .rejects.toMatchObject({ code: 'STORAGE_FAILED' });
    expect(filesystemFailures.readdir).toBeUndefined();
  });

  it('preserves non-ready metadata and removes restored ciphertext when ready-index replacement fails', async () => {
    const store = createEncryptedIdentityStore();
    await store.bootstrapNetwork(network);
    const request = requestObject(ID_CRED_PUB);
    const pending = { ...indexRecord, workflow: {
      ...indexRecord.workflow, status: 'pending' as const,
      request, retrievalUrl: 'https://idp.example/result',
    } };
    const original = { ...record(id), id, status: 'pending' as const,
      request: pending.workflow.request, retrievalUrl: pending.workflow.retrievalUrl };
    original.selection.network = network.caip2;
    await store.create(original);
    const credentialsRegistry = { version: 1 as const, credentials: {
      ['aa'.repeat(48)]: { identityId: id, credentialNumber: 0, status: 'confirmed' as const },
    } };
    await store.saveCredentials(network.caip2, credentialsRegistry);
    filesystemFailures.rename = {
      target: path.join(process.env.XDG_DATA_HOME!, 'ccd-agent-kit', 'id-manager', reference, 'index.json'),
      error: new Error('index rename failed'),
    };

    await expect(store.restoreIdentity(network, id, {
      ...pending, workflow: {
        status: 'ready', contextHash: pending.workflow.contextHash, idCredPub: pending.workflow.idCredPub,
      },
    }, identityObject(request.value), key, pending.workflow)).rejects.toMatchObject({ code: 'STORAGE_FAILED' });

    expect(filesystemFailures.rename).toBeUndefined();
    const ciphertext = path.join(process.env.XDG_DATA_HOME!, 'ccd-agent-kit', 'id-manager', reference, `${id}.json`);
    await expect(access(ciphertext)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(store.load(network.caip2, id)).resolves.toMatchObject({
      status: 'pending', request: pending.workflow.request, retrievalUrl: pending.workflow.retrievalUrl,
    });
    await expect(store.loadCredentials(network.caip2)).resolves.toEqual(credentialsRegistry);
  });

  it('keeps a pending attempt monitorable when completion marks its reservation used before index persistence fails', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_900_000_000_000);
    const store = createEncryptedIdentityStore();
    await store.bootstrapNetwork(network);
    const request = requestObject(ID_CRED_PUB);
    const requestAttemptId = '018f47a2-43d2-7ad9-8b5e-89d810f95a22';
    const original = {
      ...record(id), status: 'pending' as const, request, requestAttemptId,
      retrievalUrl: 'https://idp.example/result',
    };
    original.selection.network = network.caip2;
    const scope = {
      genesisHash: network.genesisHash,
      sourceId: deriveIdentitySourceId(original.selection.rootPublicKey, 1),
      sdkNetwork: 'Testnet' as const,
      identityProviderIndex: original.selection.identityProviderIndex,
      identityIndex: original.selection.identityIndex,
    };
    await store.reserveIdentityIndex({ ...scope, mode: 'explicit' });
    await store.create(original);
    const entry = (await store.readIndex(network.caip2)).identities[id]!;
    filesystemFailures.rename = {
      target: path.join(process.env.XDG_DATA_HOME!, 'ccd-agent-kit', 'id-manager', reference, 'index.json'),
      error: new Error('index rename failed'),
    };

    await expect(store.createIdentity(network, id, {
      ...entry, workflow: {
        status: 'ready', contextHash: entry.workflow.contextHash, idCredPub: entry.workflow.idCredPub,
      },
    }, identityObject(request.value), key, entry.workflow)).rejects.toMatchObject({ code: 'STORAGE_FAILED' });

    await expect(store.readIdentityRequestReservation(scope)).resolves.toEqual({
      state: 'used', reservedAt: 1_900_000_000_000,
    });
    await expect(store.listIdentityMonitorCandidates(Date.now())).resolves.toEqual([{
      record: expect.objectContaining({ id, status: 'pending', requestAttemptId }),
      reservedAt: 1_900_000_000_000,
    }]);
    await expect(store.load(network.caip2, id)).resolves.toMatchObject({ status: 'pending', requestAttemptId });
  });
});

describe('identity context binding', () => {
  const genesis = '12'.repeat(32);
  const network = { caip2: `ccd:${genesis.slice(0, 32)}`, genesisHash: genesis };
  const selection = {
    network: network.caip2, device: '123456', rootPublicKey: PUBLIC_KEY.toString('hex'),
    identityProviderIndex: 0, identityIndex: 2,
  };
  const globalContext = { onChainCommitmentKey: 'global-key' };
  const ipInfo = { ipIdentity: 0, ipVerifyKey: 'node-key' };
  const ars = [
    { arIdentity: 1, arPublicKey: 'ar-one' },
    { arIdentity: 2, arPublicKey: 'ar-two' },
    { arIdentity: 3, arPublicKey: 'ar-three' },
  ];

  function providers(overrides: Record<string, unknown> = {}) {
    return identityProviderServiceFixture({
      resolve: vi.fn(async () => ({
        index: 0, issuanceUrl: 'https://idp.example/issue', recoveryUrl: 'https://idp.example/recover', issuanceMethod: 'GET' as const,
      })),
      ...overrides,
    });
  }

  function readNodeContext() {
    return vi.fn(async () => ({
      network, sdkNetwork: 'Testnet' as const, globalContext,
      identityProviders: [ipInfo], anonymityRevokers: ars,
      sourceBlock: { hash: 'ab'.repeat(32), height: '17', time: '2026-10-16T11:59:59.000Z' },
      observedAt: '2026-10-16T12:00:00.000Z',
    }) as never);
  }

  beforeEach(() => {
    infrastructureMocks.resolveNetwork.mockReturnValue({ config: {
      ...network, grpc: { host: 'node.example', port: 20000, ssl: true },
    } });
  });

  it('builds workflow context with authoritative full AR keys and configured issuance preference', async () => {
    const providerService = providers({
      resolve: vi.fn(async () => ({
        index: 0, issuanceUrl: 'https://idp.example/issue', recoveryUrl: 'https://idp.example/recover',
        issuanceMethod: 'GET' as const, anonymityRevokers: [3, 1], anonymityRevokerThreshold: 1,
      }) as never),
    });
    const nodeReader = readNodeContext();
    const loaded = loadIdentityContext(selection, {
      providers: providerService, readNodeContext: nodeReader,
    });
    await expect(loaded).resolves.toEqual({
      network: network.caip2, genesisHash: genesis, sdkNetwork: 'Testnet', ipInfo,
      arsInfos: { '1': ars[0], '2': ars[1], '3': ars[2] }, globalContext,
      issuanceUrl: 'https://idp.example/issue', recoveryUrl: 'https://idp.example/recover',
      anonymityRevocation: { anonymityRevokers: [3, 1], anonymityRevokerThreshold: 1 },
    });
    expect(providerService.resolve).toHaveBeenCalledWith({ network, selector: 0, requireEnabled: true });
    expect(providerService.inspect).not.toHaveBeenCalled();
    expect(nodeReader).toHaveBeenCalledExactlyOnceWith(network);
    expect(await loaded).not.toHaveProperty('sourceBlock');
  });

  it('omits AR issuance preference when neither provider field is configured', async () => {
    await expect(loadIdentityContext(selection, {
      providers: providers(), readNodeContext: readNodeContext(),
    })).resolves.not.toHaveProperty('anonymityRevocation');
  });

  it('detaches configured AR lists from provider resolution results', async () => {
    const configured = [3, 1];
    const providerService = providers({
      resolve: vi.fn(async () => ({
        index: 0, issuanceUrl: 'https://idp.example/issue', recoveryUrl: 'https://idp.example/recover',
        issuanceMethod: 'GET' as const, anonymityRevokers: configured,
      }) as never),
    });
    const loaded = await loadIdentityContext(selection, {
      providers: providerService, readNodeContext: readNodeContext(),
    }) as unknown as { anonymityRevocation: { anonymityRevokers: number[] } };
    configured.reverse();
    expect(loaded.anonymityRevocation.anonymityRevokers).toEqual([3, 1]);
  });

  it('adds only the configured POST issuance descriptor to internal workflow context', async () => {
    const providerService = providers({
      resolve: vi.fn(async () => ({
        index: 0,
        issuanceUrl: 'https://idp.example/issue',
        recoveryUrl: 'https://idp.example/recover',
        issuanceMethod: 'POST' as const,
      })),
    });
    const loaded = loadIdentityContext(selection, {
      providers: providerService, readNodeContext: readNodeContext(),
    });
    const context = await loaded;
    expect(context.issuance).toEqual({ method: 'POST' });
    expect(context).not.toHaveProperty('issuanceMethod');
    expect(context.issuance).not.toHaveProperty('body');
  });

  it('requires provider authorization before finalized node access', async () => {
    const providerService = providers({
      resolve: vi.fn(async () => { throw new IdentityProviderError('PROVIDER_DISABLED'); }),
    });
    const nodeReader = readNodeContext();
    await expect(loadIdentityContext(selection, {
      providers: providerService, readNodeContext: nodeReader,
    })).rejects.toMatchObject({ code: 'PROVIDER_DISABLED' });
    expect(providerService.resolve).toHaveBeenCalledWith({ network, selector: 0, requireEnabled: true });
    expect(nodeReader).not.toHaveBeenCalled();
  });

  it('ignores but preserves an old inert walletProxyUrl instead of fetching it', async () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    const historical = { ...selection, walletProxyUrl: 'https://attacker.example/private' };
    await expect(loadIdentityContext(historical, {
      providers: providers(), readNodeContext: readNodeContext(), requireEnabled: false,
    })).resolves.toMatchObject({ issuanceUrl: 'https://idp.example/issue' });
    expect(historical.walletProxyUrl).toBe('https://attacker.example/private');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    ['provider index', { identityProviders: [{ ...ipInfo, ipIdentity: 1 }], anonymityRevokers: ars }],
    ['empty network ARs', { identityProviders: [ipInfo], anonymityRevokers: [] }],
  ])('rejects fresh node context with mismatched %s', async (_name, patch) => {
    const nodeReader = vi.fn(async () => ({ network, sdkNetwork: 'Testnet' as const, globalContext, ...patch }) as never);
    await expect(loadIdentityContext(selection, {
      providers: providers(), readNodeContext: nodeReader, requireEnabled: false,
    })).rejects.toMatchObject({ code: 'CONTEXT_MISMATCH' });
  });

  it('accepts one authoritative network AR in identity context', async () => {
    const nodeReader = vi.fn(async () => ({
      network, sdkNetwork: 'Testnet' as const, globalContext,
      identityProviders: [ipInfo], anonymityRevokers: [ars[0]],
    }) as never);
    await expect(loadIdentityContext(selection, {
      providers: providers(), readNodeContext: nodeReader, requireEnabled: false,
    })).resolves.toMatchObject({ arsInfos: { '1': ars[0] } });
  });

  it('rejects a provider resolver returning a different numeric provider before node access', async () => {
    const providerService = providers({
      resolve: vi.fn(async () => ({
        index: 1, issuanceUrl: 'https://idp.example/issue', recoveryUrl: 'https://idp.example/recover', issuanceMethod: 'GET' as const,
      })),
    });
    const nodeReader = readNodeContext();
    await expect(loadIdentityContext(selection, { providers: providerService, readNodeContext: nodeReader }))
      .rejects.toMatchObject({ code: 'CONTEXT_MISMATCH' });
    expect(nodeReader).not.toHaveBeenCalled();
  });

  it('rejects a finalized reader returning a different canonical network', async () => {
    const nodeReader = vi.fn(async () => ({
      network: { ...network, genesisHash: '34'.repeat(32) }, sdkNetwork: 'Testnet' as const,
      globalContext, identityProviders: [ipInfo], anonymityRevokers: ars,
    }) as never);
    await expect(loadIdentityContext(selection, { providers: providers(), readNodeContext: nodeReader }))
      .rejects.toMatchObject({ code: 'CONTEXT_MISMATCH' });
  });

  it('sanitizes an unexpected resolver failure as a context mismatch', async () => {
    const providerService = providers({
      resolve: vi.fn(async () => { throw new Error('/private/provider-state'); }),
    });
    const failure = await loadIdentityContext(selection, { providers: providerService, readNodeContext: readNodeContext() })
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: 'CONTEXT_MISMATCH' });
    expect(String(failure)).not.toContain('/private/provider-state');
  });
});
describe('default identity proof service wiring', () => {
  const genesisHash = '12'.repeat(32);
  const caip2 = `ccd:${genesisHash.slice(0, 32)}`;
  const sourceId = deriveIdentitySourceId(PUBLIC_KEY.toString('hex'), 1);
  const selected = {
    network: caip2, sdkNetwork: 'Testnet' as const, rootPublicKey: PUBLIC_KEY.toString('hex'),
    identityProviderIndex: 0, identityIndex: 2,
  };
  const stored = { ...record(), sourceId, selection: selected } as StoredIdentity;

  function create(overrides: Record<string, unknown> = {}) {
    const proofService = { findCandidates: vi.fn(), createProof: vi.fn() };
    infrastructureMocks.createIdentityProofService.mockReturnValueOnce(proofService);
    infrastructureMocks.resolveNetwork.mockReturnValue({ config: {
      caip2, genesisHash, sdkNetwork: 'Testnet', grpc: { host: 'node.example', port: 20000, ssl: true },
    } });
    const sources = {
      records: vi.fn(async () => [{ id: sourceId, label: 'source', backend: 'piv', locator: {},
        rootPublicKey: PUBLIC_KEY.toString('hex'), rootPublicKeyFingerprint: '34'.repeat(32), recipeVersion: 1 as const }]),
      createAgreement: vi.fn(async () => ({ derive: vi.fn() })),
    };
    const store = {
      list: vi.fn(async () => [stored]), loadIdentity: vi.fn(async () => identity),
      loadCredentials: vi.fn(async () => ({ version: 1 as const, credentials: {} })),
    };
    const readNodeContext = vi.fn(async () => ({
      network: caip2, sdkNetwork: 'Testnet' as const, genesisHash,
      ipInfo: { ipIdentity: 0 }, arsInfos: { '1': {}, '2': {} },
      globalContext: { onChainCommitmentKey: 'aa' },
      sourceBlock: { hash: 'ab'.repeat(32), height: '17', time: '2026-10-16T11:59:59.000Z' },
      observedAt: '2026-10-16T12:00:00.000Z',
    }));
    const service = createDefaultIdentityProofService({
      sources: sources as never, store: store as never, readNodeContext: readNodeContext as never,
      ...overrides,
    });
    const deps = infrastructureMocks.createIdentityProofService.mock.calls.at(-1)![0] as Parameters<typeof createIdentityProofService>[0];
    return { service, deps, sources, store, readNodeContext, proofService };
  }

  it('adapts legacy stored identities, labels, local context, and registries without new metadata', async () => {
    const h = create({ loadCachedCredentials: vi.fn(async () => [{ account: '4abc', credentialIndex: 0,
      credentialId: 'ab'.repeat(48) }]) });
    expect(h.service).toBe(h.proofService);
    expect(h.deps.resolveNetwork('testnet' as never)).toEqual({ caip2, sdkNetwork: 'Testnet' });
    await expect(h.deps.listRecords(caip2 as never)).resolves.toEqual([stored]);
    await expect(h.deps.loadIdentity(stored as never, Buffer.alloc(32) as never)).resolves.toEqual(identity);
    await expect(h.deps.loadLocalContext(stored as never)).resolves.toBeUndefined();
    infrastructureMocks.getIdentityContextSnapshot.mockReturnValueOnce({
      network: { caip2, genesisHash }, identityProviders: [{ ipIdentity: 0 }],
      anonymityRevokers: [{ arIdentity: 1 }, { arIdentity: 2 }],
      globalContext: { onChainCommitmentKey: 'aa' },
    });
    await expect(h.deps.loadLocalContext(stored as never)).resolves.toMatchObject({ genesisHash });
    await expect(h.deps.listCachedCredentials(caip2 as never)).resolves.toHaveLength(1);
    await expect(h.deps.loadCredentialRegistry(caip2 as never)).resolves.toEqual({ version: 1, credentials: {} });
  });

  it('loads fresh generation context only from the requested finalized block', async () => {
    const h = create();
    await expect(h.deps.loadGenerationContext(selected as never, 'ab'.repeat(32) as never))
      .resolves.toMatchObject({ network: caip2, genesisHash, sourceBlock: { hash: 'ab'.repeat(32) } });
    h.readNodeContext.mockResolvedValueOnce({ ...(await h.readNodeContext.mock.results[0]!.value),
      network: 'ccd:wrong' });
    await expect(h.deps.loadGenerationContext(selected as never, 'ab'.repeat(32) as never))
      .rejects.toBeInstanceOf(Error);
  });

  it('keeps source material inside the delegated material session', async () => {
    const h = create();
    const callback = vi.fn(async () => 'done');
    infrastructureMocks.withIdentityMaterial.mockImplementationOnce(async (input, delegated) => {
      expect(input).toMatchObject({ selection: stored.selection, sourceId });
      return delegated(Buffer.alloc(64), {}, { encryptionKey: Buffer.alloc(32) });
    });
    await expect(h.deps.withMaterial(stored as never, callback as never)).resolves.toBe('done');
    expect(infrastructureMocks.withIdentityMaterial).toHaveBeenCalledWith(
      expect.objectContaining({ sourceId, sources: h.sources }), expect.any(Function),
    );

    expect(() => h.deps.withMaterial({ ...stored, sourceId: undefined } as never, callback as never))
      .toThrow(IdentityWorkflowError);
  });

  it('propagates unreadable cache and registry state to core classification', async () => {
    const cacheFailure = new Error('private cache detail');
    const registryFailure = new Error('private registry detail');
    const loadCachedCredentials = vi.fn(async () => { throw cacheFailure; });
    const h = create({ loadCachedCredentials });
    h.store.loadCredentials.mockRejectedValueOnce(registryFailure);
    await expect(h.deps.listCachedCredentials(caip2 as never)).rejects.toBe(cacheFailure);
    await expect(h.deps.loadCredentialRegistry(caip2 as never)).rejects.toBe(registryFailure);
  });

  it('reads fresh proof context through the finalized-node reader', async () => {
    infrastructureMocks.nodeClient = {
      getConsensusStatus: vi.fn(async () => ({ genesisBlock: BlockHash.fromHexString(genesisHash) })),
      getBlockInfo: vi.fn(async () => ({
        blockHash: BlockHash.fromHexString('ab'.repeat(32)), blockSlotTime: new Date('2026-10-16T11:59:59.000Z'),
      })),
      getCryptographicParameters: vi.fn(async () => ({ onChainCommitmentKey: 'aa' })),
      getIdentityProviders: vi.fn(async function* () { yield { ipIdentity: 0 }; }),
      getAnonymityRevokers: vi.fn(async function* () { yield { arIdentity: 1 }; }),
    };
    const h = create({ readNodeContext: undefined });
    infrastructureMocks.resolveNetwork.mockReturnValue({ config: {
      caip2, genesisHash, sdkNetwork: 'Testnet', grpc: { host: 'node.example', port: 20000, ssl: false },
    } });
    await expect(h.deps.loadGenerationContext(selected, 'ab'.repeat(32))).resolves.toMatchObject({
      network: caip2, genesisHash, sdkNetwork: 'Testnet', sourceBlock: { hash: 'ab'.repeat(32) },
      ipInfo: { ipIdentity: 0 }, arsInfos: { '1': { arIdentity: 1 } },
    });
  });

  it.each(['genesis', 'block', 'provider', 'revokers'] as const)(
    'rejects inconsistent finalized-node proof context: %s', async stage => {
      infrastructureMocks.nodeClient = {
        getConsensusStatus: vi.fn(async () => ({ genesisBlock: BlockHash.fromHexString(
          stage === 'genesis' ? '34'.repeat(32) : genesisHash,
        ) })),
        getBlockInfo: vi.fn(async () => ({
          blockHash: BlockHash.fromHexString(stage === 'block' ? 'cd'.repeat(32) : 'ab'.repeat(32)),
          blockSlotTime: new Date('2026-10-16T11:59:59.000Z'),
        })),
        getCryptographicParameters: vi.fn(async () => ({ onChainCommitmentKey: 'aa' })),
        getIdentityProviders: vi.fn(async function* () { if (stage !== 'provider') yield { ipIdentity: 0 }; }),
        getAnonymityRevokers: vi.fn(async function* () {
          if (stage !== 'revokers') yield { arIdentity: 1 };
        }),
      };
      const h = create({ readNodeContext: undefined });
      await expect(h.deps.loadGenerationContext(selected, 'ab'.repeat(32))).rejects.toBeInstanceOf(Error);
    },
  );

  it('loads and normalizes anchored and current account credentials', async () => {
    const address = getAccountAddress(credentialPayload().unsignedCdi.credId).toString();
    const block = BlockHash.fromHexString('ab'.repeat(32));
    const normal = { value: { type: 'normal', contents: {
      credId: credentialPayload().unsignedCdi.credId, ipIdentity: 0,
      commitments: { cmmAttributes: { firstName: 'aa' } },
      policy: { createdAt: '202601', validTo: '202701', revealedAttributes: {} },
    } } };
    const initial = { value: { type: 'initial', contents: {} } };
    infrastructureMocks.resolveAccountLabel.mockReturnValueOnce({ address, label: 'primary' });
    infrastructureMocks.nodeClient = {
      getConsensusStatus: vi.fn(async () => ({
        genesisBlock: BlockHash.fromHexString(genesisHash), lastFinalizedBlock: block,
      })),
      getBlockInfo: vi.fn(async () => ({ blockHash: block, blockSlotTime: new Date('2026-10-16T11:59:59.000Z') })),
      getAccountInfo: vi.fn()
        .mockResolvedValueOnce({ accountAddress: AccountAddress.fromBase58(address), accountCredentials: { 0: normal, 1: initial } })
        .mockResolvedValueOnce({ accountAddress: AccountAddress.fromBase58(address), accountCredentials: { 0: normal } }),
    };
    const h = create();
    await expect(h.deps.loadFinalizedCredentials(caip2, 'primary', 'ab'.repeat(32))).resolves.toMatchObject({
      account: address, credentials: [{ credentialIndex: 0, issuer: 0 }],
      currentCredentials: [{ credentialIndex: 0 }], sourceBlock: { hash: 'ab'.repeat(32) },
    });
  });

  it('loads default public credential observations and verifies an anchor through the node', async () => {
    const credentialId = credentialPayload().unsignedCdi.credId;
    infrastructureMocks.loadAccountCredentials.mockReturnValueOnce({
      '4abc': { credentials: { 0: { credentialId: credentialId.toUpperCase() }, 1: {} } },
    });
    infrastructureMocks.nodeClient = {
      getConsensusStatus: vi.fn(async () => ({ genesisBlock: BlockHash.fromHexString(genesisHash) })),
      getBlockItemStatus: vi.fn(async () => ({ status: TransactionStatusEnum.Received })),
    };
    const h = create({ loadCachedCredentials: undefined });
    await expect(h.deps.listCachedCredentials(caip2)).resolves.toEqual([{
      account: '4abc', credentialIndex: 0, credentialId,
    }]);
    const proofRequest = VerificationRequestV1.fromJSON({
      type: 'ConcordiumVerificationRequestV1',
      context: { type: 'ConcordiumUnfilledContextInformationV1', given: [], requested: [] },
      subjectClaims: [], transactionRef: 'ab'.repeat(32),
    });
    await expect(h.deps.verifyAnchor(caip2, proofRequest)).resolves.toMatchObject({ status: 'invalid' });
    infrastructureMocks.resolveNetwork.mockReturnValue({ config: {
      caip2, genesisHash, sdkNetwork: 'Testnet', grpc: { host: 'node.example', port: 20000, ssl: false },
    } });
    await expect(h.deps.verifyAnchor(caip2, proofRequest)).resolves.toMatchObject({ status: 'invalid' });
  });

  it('maps the configured mainnet genesis to its SDK namespace', () => {
    const h = create();
    const mainnet = '9dd9ca4d19e9393877d2c44b70f89acbfc0883c2243e5eeaecc0d1cd0503f478';
    infrastructureMocks.resolveNetwork.mockReturnValue({ config: {
      caip2: `ccd:${mainnet.slice(0, 32)}`, genesisHash: mainnet,
      grpc: { host: 'node.example', port: 20000, ssl: true },
    } });
    expect(h.deps.resolveNetwork('mainnet')).toMatchObject({ sdkNetwork: 'Mainnet' });
  });

  it.each(['missing-provider', 'insufficient-revokers', 'unreadable'] as const)(
    'ignores unusable local proof context: %s', async stage => {
      const h = create();
      if (stage === 'unreadable') infrastructureMocks.getIdentityContextSnapshot.mockImplementationOnce(() => { throw new Error(); });
      else infrastructureMocks.getIdentityContextSnapshot.mockReturnValueOnce({
        network: { caip2, genesisHash },
        identityProviders: stage === 'missing-provider' ? [] : [{ ipIdentity: 0 }],
        anonymityRevokers: stage === 'insufficient-revokers' ? [] : [{ arIdentity: 1 }],
        globalContext: { onChainCommitmentKey: 'aa' },
      });
      await expect(h.deps.loadLocalContext(stored)).resolves.toBeUndefined();
    },
  );

  it.each(['genesis', 'block', 'canonical', 'index-syntax', 'index-range', 'credential'] as const)(
    'rejects inconsistent finalized credential data: %s', async stage => {
      const address = getAccountAddress(credentialPayload().unsignedCdi.credId).toString();
      const otherAddress = AccountAddress.getAlias(AccountAddress.fromBase58(address), 1).toString();
      const block = BlockHash.fromHexString('ab'.repeat(32));
      const key = stage === 'index-syntax' ? '01' : stage === 'index-range' ? '256' : '0';
      const normal = { value: { type: 'normal', contents: {
        credId: stage === 'credential' ? 'not-hex' : credentialPayload().unsignedCdi.credId,
        ipIdentity: 0, commitments: { cmmAttributes: {} },
        policy: { createdAt: '202601', validTo: '202701', revealedAttributes: {} },
      } } };
      infrastructureMocks.resolveNetwork.mockReturnValue({ config: {
        caip2, genesisHash, sdkNetwork: 'Testnet', grpc: { host: 'node.example', port: 20000, ssl: false },
      } });
      infrastructureMocks.resolveAccountLabel.mockReturnValueOnce(undefined);
      infrastructureMocks.nodeClient = {
        getConsensusStatus: vi.fn(async () => ({
          genesisBlock: BlockHash.fromHexString(stage === 'genesis' ? '34'.repeat(32) : genesisHash),
          lastFinalizedBlock: block,
        })),
        getBlockInfo: vi.fn(async () => ({
          blockHash: BlockHash.fromHexString(stage === 'block' ? 'cd'.repeat(32) : 'ab'.repeat(32)),
          blockSlotTime: new Date('2026-10-16T11:59:59.000Z'),
        })),
        getAccountInfo: vi.fn()
          .mockResolvedValueOnce({ accountAddress: AccountAddress.fromBase58(address), accountCredentials: { [key]: normal } })
          .mockResolvedValueOnce({
            accountAddress: AccountAddress.fromBase58(stage === 'canonical' ? otherAddress : address),
            accountCredentials: { 0: normal },
          }),
      };
      const h = create();
      infrastructureMocks.resolveNetwork.mockReturnValue({ config: {
        caip2, genesisHash, sdkNetwork: 'Testnet', grpc: { host: 'node.example', port: 20000, ssl: false },
      } });
      await expect(h.deps.loadFinalizedCredentials(caip2, address, 'ab'.repeat(32))).rejects.toBeInstanceOf(Error);
    },
  );
});

describe('finalized account observation', () => {
  const genesis = '12'.repeat(32);
  const network = `ccd:${genesis.slice(0, 32)}`;
  const address = getAccountAddress(credentialPayload().unsignedCdi.credId).toString();
  const alias = AccountAddress.getAlias(AccountAddress.fromBase58(address), 7).toString();
  const credentialId = credentialPayload().unsignedCdi.credId;
  const finalized = BlockHash.fromHexString('ab'.repeat(32));
  const sourceBlock = { hash: 'ab'.repeat(32), height: '17', time: '2027-01-15T08:00:00.000Z' };

  function configure(ssl = true) {
    infrastructureMocks.resolveNetwork.mockReturnValue({ config: {
      caip2: network, genesisHash: genesis,
      grpc: { host: 'node.example', port: 20000, ssl },
    } });
  }

  it('accepts an address alias but returns and caches the node canonical address at one finalized block', async () => {
    configure(false);
    const accountInfo = {
      accountAddress: AccountAddress.fromBase58(address),
      accountThreshold: 1,
      accountCredentials: {
        0: { value: { contents: { credId: credentialId, credentialPublicKeys: { threshold: 1, keys: {
          0: { schemeId: 'Ed25519', verifyKey: '11'.repeat(32) },
        } } } } },
      },
    };
    infrastructureMocks.nodeClient = {
      getConsensusStatus: vi.fn(async () => ({ genesisBlock: BlockHash.fromHexString(genesis), lastFinalizedBlock: finalized })),
      getBlockInfo: vi.fn(async () => ({ blockHash: finalized, blockHeight: 17n, blockSlotTime: new Date(sourceBlock.time) })),
      getAccountInfo: vi.fn(async () => accountInfo),
    };

    const observer = await createFinalizedAccountObserver(network);
    await expect(observer({ type: 'address', address: alias })).resolves.toMatchObject({
      exists: true,
      canonicalAddress: address,
      sourceBlock,
      observation: { accountThreshold: '1', sourceBlock, credentials: expect.any(Object) },
    });
    expect((infrastructureMocks.nodeClient as { getBlockInfo: ReturnType<typeof vi.fn> }).getBlockInfo)
      .toHaveBeenCalledExactlyOnceWith(finalized);
    expect((infrastructureMocks.nodeClient as { getAccountInfo: ReturnType<typeof vi.fn> }).getAccountInfo)
      .toHaveBeenCalledWith(expect.anything(), finalized);
    expect(getAccountCredentialObservation(address, genesis.slice(0, 32))).toMatchObject({ sourceBlock });
  });

  it('returns typed absence only for RPC NOT_FOUND while preserving the same source block', async () => {
    configure();
    infrastructureMocks.nodeClient = {
      getConsensusStatus: vi.fn(async () => ({ genesisBlock: BlockHash.fromHexString(genesis), lastFinalizedBlock: finalized })),
      getBlockInfo: vi.fn(async () => ({ blockHash: finalized, blockHeight: 17n, blockSlotTime: new Date(sourceBlock.time) })),
      getAccountInfo: vi.fn(async () => { throw new RpcError('not found detail', 'NOT_FOUND'); }),
    };
    const observer = await createFinalizedAccountObserver(network);
    await expect(observer({ type: 'address', address })).resolves.toEqual({
      exists: false, sourceBlock, genesisHash: genesis,
    });
    expect(getAccountCredentialObservation(address, genesis.slice(0, 32))).toBeUndefined();
  });

  it.each(['INVALID_ARGUMENT', 'UNAVAILABLE', 'DEADLINE_EXCEEDED'] as const)(
    'does not convert RPC failure code %s into account absence',
    async (code) => {
    configure();
    infrastructureMocks.nodeClient = {
      getConsensusStatus: vi.fn(async () => ({ genesisBlock: BlockHash.fromHexString(genesis), lastFinalizedBlock: finalized })),
      getBlockInfo: vi.fn(async () => ({ blockHash: finalized, blockHeight: 17n, blockSlotTime: new Date(sourceBlock.time) })),
      getAccountInfo: vi.fn(async () => { throw new RpcError('private RPC detail', code); }),
    };
    const observer = await createFinalizedAccountObserver(network);
    await expect(observer({ type: 'address', address })).rejects.toMatchObject({ code: 'NETWORK_FAILED' });
    },
  );

  it.each(['consensus', 'block'] as const)('never treats NOT_FOUND from %s lookup as account absence', async (stage) => {
    configure();
    infrastructureMocks.nodeClient = {
      getConsensusStatus: vi.fn(async () => {
        if (stage === 'consensus') throw new RpcError('missing consensus', 'NOT_FOUND');
        return { genesisBlock: BlockHash.fromHexString(genesis), lastFinalizedBlock: finalized };
      }),
      getBlockInfo: vi.fn(async () => {
        if (stage === 'block') throw new RpcError('missing block', 'NOT_FOUND');
        return { blockHash: finalized, blockHeight: 17n, blockSlotTime: new Date(sourceBlock.time) };
      }),
      getAccountInfo: vi.fn(),
    };
    const action = stage === 'consensus'
      ? createFinalizedAccountObserver(network).then(observer => observer({ type: 'address' as const, address }))
      : createFinalizedAccountObserver(network);
    await expect(action).rejects.toMatchObject({ code: 'NETWORK_FAILED' });
    expect((infrastructureMocks.nodeClient as { getAccountInfo: ReturnType<typeof vi.fn> }).getAccountInfo).not.toHaveBeenCalled();
  });

  it('rejects a finalized node whose full genesis differs after the matching CAIP reference', async () => {
    configure();
    infrastructureMocks.nodeClient = {
      getConsensusStatus: vi.fn(async () => ({
        genesisBlock: BlockHash.fromHexString(`${genesis.slice(0, 32)}${'34'.repeat(16)}`), lastFinalizedBlock: finalized,
      })),
      getBlockInfo: vi.fn(),
      getAccountInfo: vi.fn(),
    };
    await expect(createFinalizedAccountObserver(network)).rejects.toMatchObject({ code: 'NETWORK_FAILED' });
    expect((infrastructureMocks.nodeClient as { getBlockInfo: ReturnType<typeof vi.fn> }).getBlockInfo).not.toHaveBeenCalled();
  });

  it('rejects source-block metadata that does not match the captured finalized hash', async () => {
    configure();
    infrastructureMocks.nodeClient = {
      getConsensusStatus: vi.fn(async () => ({ genesisBlock: BlockHash.fromHexString(genesis), lastFinalizedBlock: finalized })),
      getBlockInfo: vi.fn(async () => ({
        blockHash: BlockHash.fromHexString('cd'.repeat(32)), blockHeight: 17n,
        blockSlotTime: new Date(sourceBlock.time),
      })),
      getAccountInfo: vi.fn(),
    };
    await expect(createFinalizedAccountObserver(network)).rejects.toMatchObject({ code: 'NETWORK_FAILED' });
    expect((infrastructureMocks.nodeClient as { getAccountInfo: ReturnType<typeof vi.fn> }).getAccountInfo)
      .not.toHaveBeenCalled();
  });

  it('reuses one verified client and finalized block for address and credential selectors', async () => {
    configure();
    const accountInfo = {
      accountAddress: AccountAddress.fromBase58(address), accountThreshold: 1, accountCredentials: {},
    };
    infrastructureMocks.nodeClient = {
      getConsensusStatus: vi.fn(async () => ({ genesisBlock: BlockHash.fromHexString(genesis), lastFinalizedBlock: finalized })),
      getBlockInfo: vi.fn(async () => ({ blockHash: finalized, blockHeight: 17n, blockSlotTime: new Date(sourceBlock.time) })),
      getAccountInfo: vi.fn(async () => accountInfo),
    };

    const observer = await createFinalizedAccountObserver(network);
    const [byAddress, byCredential] = await Promise.all([
      observer({ type: 'address', address }), observer({ type: 'credentialId', credentialId }),
    ]);
    expect(byAddress).toMatchObject({ exists: true, canonicalAddress: address });
    expect(byCredential).toMatchObject({ exists: true, canonicalAddress: address, observation: { credentials: {} } });
    const client = infrastructureMocks.nodeClient as Record<string, ReturnType<typeof vi.fn>>;
    expect(client.getConsensusStatus).toHaveBeenCalledOnce();
    expect(client.getBlockInfo).toHaveBeenCalledOnce();
    expect(client.getAccountInfo).toHaveBeenNthCalledWith(1, AccountAddress.fromBase58(address), finalized);
    expect(client.getAccountInfo).toHaveBeenNthCalledWith(2, CredentialRegistrationId.fromHexString(credentialId), finalized);
    expect(getAccountCredentialObservation(address, genesis.slice(0, 32))).toMatchObject({ credentials: {} });
  });

  it('does not cache malformed account data and preserves a prior canonical observation', async () => {
    configure();
    const existing = { accountThreshold: '1', credentials: {}, sourceBlock };
    const { setAccountCredentialObservation } = await import('@ccd-agent-kit/config-utils');
    setAccountCredentialObservation(address, existing, genesis.slice(0, 32));
    infrastructureMocks.nodeClient = {
      getConsensusStatus: vi.fn(async () => ({ genesisBlock: BlockHash.fromHexString(genesis), lastFinalizedBlock: finalized })),
      getBlockInfo: vi.fn(async () => ({ blockHash: finalized, blockHeight: 17n, blockSlotTime: new Date(sourceBlock.time) })),
      getAccountInfo: vi.fn(async () => ({ accountAddress: { toString: () => 'not-an-address' }, accountThreshold: 1, accountCredentials: {} })),
    };

    const observer = await createFinalizedAccountObserver(network);
    await expect(observer({ type: 'credentialId', credentialId })).rejects.toMatchObject({ code: 'NETWORK_FAILED' });
    expect(getAccountCredentialObservation(address, genesis.slice(0, 32))).toEqual(existing);
  });

  it('rejects a malformed public account observation before caching it', async () => {
    configure();
    infrastructureMocks.nodeClient = {
      getConsensusStatus: vi.fn(async () => ({ genesisBlock: BlockHash.fromHexString(genesis), lastFinalizedBlock: finalized })),
      getBlockInfo: vi.fn(async () => ({ blockHash: finalized, blockHeight: 17n, blockSlotTime: new Date(sourceBlock.time) })),
      getAccountInfo: vi.fn(async () => ({
        accountAddress: AccountAddress.fromBase58(address),
        accountThreshold: { toString: () => 'invalid' },
        accountCredentials: {},
      })),
    };
    const observer = await createFinalizedAccountObserver(network);
    await expect(observer({ type: 'address', address })).rejects.toMatchObject({ code: 'NETWORK_FAILED' });
    expect(getAccountCredentialObservation(address, genesis.slice(0, 32))).toBeUndefined();
  });

  it.each([
    ['credential registration ID', {
      0: { value: { type: 'normal', contents: { credentialPublicKeys: { threshold: 1, keys: {} } } } },
    }],
    ['credential index', {
      bad: { value: { contents: { credentialPublicKeys: { threshold: 1, keys: {} } } } },
    }],
    ['credential threshold', {
      0: { value: { contents: { credId: credentialId, credentialPublicKeys: {
        threshold: { toString: () => 'invalid' }, keys: {},
      } } } },
    }],
    ['credential key index', {
      0: { value: { contents: { credId: credentialId, credentialPublicKeys: { threshold: 1, keys: {
        bad: { schemeId: 'Ed25519', verifyKey: '11'.repeat(32) },
      } } } } },
    }],
  ])('rejects a malformed public %s from the node response', async (_label, accountCredentials) => {
    configure();
    infrastructureMocks.nodeClient = {
      getConsensusStatus: vi.fn(async () => ({ genesisBlock: BlockHash.fromHexString(genesis), lastFinalizedBlock: finalized })),
      getBlockInfo: vi.fn(async () => ({ blockHash: finalized, blockHeight: 17n, blockSlotTime: new Date(sourceBlock.time) })),
      getAccountInfo: vi.fn(async () => ({
        accountAddress: AccountAddress.fromBase58(address), accountThreshold: 1, accountCredentials,
      })),
    };
    const observer = await createFinalizedAccountObserver(network);
    await expect(observer({ type: 'address', address })).rejects.toMatchObject({ code: 'NETWORK_FAILED' });
    expect(getAccountCredentialObservation(address, genesis.slice(0, 32))).toBeUndefined();
  });

  it.each([
    { type: 'address', address: 'not-an-address' },
    { type: 'credentialId', credentialId: 'not-hex' },
    { type: 'other', address },
  ])('rejects a malformed strict selector without an account lookup', async (selector) => {
    configure();
    infrastructureMocks.nodeClient = {
      getConsensusStatus: vi.fn(async () => ({ genesisBlock: BlockHash.fromHexString(genesis), lastFinalizedBlock: finalized })),
      getBlockInfo: vi.fn(async () => ({ blockHash: finalized, blockHeight: 17n, blockSlotTime: new Date(sourceBlock.time) })),
      getAccountInfo: vi.fn(),
    };
    const observer = await createFinalizedAccountObserver(network);
    await expect(observer(selector as never)).rejects.toMatchObject({ code: 'NETWORK_FAILED' });
    expect((infrastructureMocks.nodeClient as { getAccountInfo: ReturnType<typeof vi.fn> }).getAccountInfo)
      .not.toHaveBeenCalled();
  });
});

describe('default workflow wiring', () => {
  it('composes the default source service and lists only enabled providers through canonical resolution', async () => {
    const workflow = identityWorkflowFixture();
    infrastructureMocks.createIdentityWorkflow.mockReturnValue(workflow);
    const providers = identityProviderServiceFixture({
      inventory: vi.fn(async () => ({
        network: `ccd:${'12'.repeat(16)}`,
        refreshedAt: '2026-10-16T12:00:00.000Z',
        providers: [
          { index: 0, name: 'Zero', enabled: true },
          { index: 1, name: 'One', enabled: false },
          { index: 2, name: 'Two', enabled: true },
        ],
      })),
    });
    infrastructureMocks.resolveNetwork.mockReturnValue({ config: {
      caip2: `ccd:${'12'.repeat(16)}`, genesisHash: '12'.repeat(32),
      grpc: { host: 'node.example', port: 20000, ssl: true },
    } });

    expect(createDefaultIdentityWorkflow({ providers })).toBe(workflow);
    const dependencies = infrastructureMocks.createIdentityWorkflow.mock.calls[0]![0] as IdentityWorkflowDependencies;
    expect(dependencies.sources).toBeDefined();
    await expect(dependencies.listEnabledProviders(`ccd:${'12'.repeat(16)}`)).resolves.toEqual([0, 2]);
    expect(providers.inventory).toHaveBeenCalledExactlyOnceWith({
      network: { caip2: `ccd:${'12'.repeat(16)}`, genesisHash: '12'.repeat(32) },
    });
    expect(infrastructureMocks.createPivTransport).toHaveBeenCalledOnce();
    expect(infrastructureMocks.nodeConstructor).not.toHaveBeenCalled();

    await expect(dependencies.getIdentityRequestTimeoutMs?.(`ccd:${'12'.repeat(16)}`)).resolves.toBe(86_400_000);
    expect(providers.getIdentityRequestTimeoutMs).toHaveBeenCalledExactlyOnceWith({
      network: { caip2: `ccd:${'12'.repeat(16)}`, genesisHash: '12'.repeat(32) },
    });
  });

  it('composes context loading with the injected source service without touching hardware', async () => {
    const workflow = identityWorkflowFixture();
    infrastructureMocks.createIdentityWorkflow.mockReturnValue(workflow);
    const promptPin = vi.fn(async () => '123456');
    const sources = sourceService();
    const providers = identityProviderServiceFixture({ resolve: vi.fn(async () => ({
      index: 0, issuanceUrl: 'https://idp.example/issue', recoveryUrl: 'https://idp.example/recover', issuanceMethod: 'GET' as const,
    })) });

    expect(createDefaultIdentityWorkflow({ promptPin, providers, sources })).toBe(workflow);
    expect(infrastructureMocks.createPivTransport).not.toHaveBeenCalled();
    expect(infrastructureMocks.createIdentityYubiKeyService).not.toHaveBeenCalled();
    const dependencies = infrastructureMocks.createIdentityWorkflow.mock.calls[0]![0] as IdentityWorkflowDependencies;
    expect(dependencies.createAccountObserver).toBe(createFinalizedAccountObserver);
    expect(dependencies).not.toHaveProperty('observeFinalizedAccount');
    expect(dependencies.sources).toBe(sources);
    expect(dependencies.promptPin).toBe(promptPin);
    expect(promptPin).not.toHaveBeenCalled();

    const genesis = '12'.repeat(32);
    const publicContext = context();
    const globalContext = publicContext.globalContext;
    const ipInfo = { ...publicContext.ipInfo, ipIdentity: 0 };
    const ars = Object.values(publicContext.arsInfos);
    async function* values<T>(items: T[]) { yield* items; }
    infrastructureMocks.resolveNetwork.mockReturnValue({ config: {
      caip2: `ccd:${genesis.slice(0, 32)}`, genesisHash: genesis,
      grpc: { host: 'node.example', port: 20000, ssl: true },
    } });
    expect(dependencies.resolveNetwork('localnet')).toBe(`ccd:${genesis.slice(0, 32)}`);
    expect(infrastructureMocks.resolveNetwork).toHaveBeenCalledWith('localnet');
    const finalized = BlockHash.fromHexString('ab'.repeat(32));
    infrastructureMocks.nodeClient = {
      getConsensusStatus: vi.fn(async () => ({
        genesisBlock: BlockHash.fromHexString(genesis), lastFinalizedBlock: finalized,
      })),
      getBlockInfo: vi.fn(async () => ({
        blockHash: finalized, blockHeight: 17n, blockSlotTime: new Date('2026-10-16T00:00:00.000Z'),
      })),
      getCryptographicParameters: vi.fn(async () => globalContext),
      getIdentityProviders: vi.fn(() => values([ipInfo])),
      getAnonymityRevokers: vi.fn(() => values(ars)),
    };
    await expect(dependencies.loadContext(record().selection)).resolves.toMatchObject({
      network: `ccd:${genesis.slice(0, 32)}`, ipInfo, globalContext,
    });
    expect(providers.resolve).toHaveBeenCalledWith(expect.objectContaining({ requireEnabled: true }));
  });

  it('uses explicit CLI policy to resolve complete disabled providers before fresh node access', async () => {
    const workflow = identityWorkflowFixture();
    const sources = sourceService();
    const providers = identityProviderServiceFixture({
      resolve: vi.fn(async () => { throw new IdentityProviderError('PROVIDER_DISABLED'); }),
    });
    infrastructureMocks.createIdentityWorkflow.mockReturnValue(workflow);
    infrastructureMocks.resolveNetwork.mockReturnValue({ config: {
      caip2: `ccd:${'12'.repeat(16)}`, genesisHash: '12'.repeat(32),
      grpc: { host: 'node.example', port: 20000, ssl: true },
    } });

    expect(createDefaultIdentityWorkflow({ providerPolicy: 'cli', providers, sources })).toBe(workflow);
    const dependencies = infrastructureMocks.createIdentityWorkflow.mock.calls[0]![0] as IdentityWorkflowDependencies;
    await expect(dependencies.loadContext(record().selection)).rejects.toMatchObject({ code: 'PROVIDER_DISABLED' });
    expect(providers.resolve).toHaveBeenCalledWith(expect.objectContaining({ requireEnabled: false }));
    expect(infrastructureMocks.nodeConstructor).not.toHaveBeenCalled();
  });

  it('omits PIN prompting when constructing the non-interactive default workflow', () => {
    const workflow = identityWorkflowFixture();
    infrastructureMocks.createIdentityWorkflow.mockReturnValue(workflow);
    const sources = sourceService();

    expect(createDefaultIdentityWorkflow({ sources })).toBe(workflow);
    const dependencies = infrastructureMocks.createIdentityWorkflow.mock.calls[0]![0] as IdentityWorkflowDependencies;
    expect(dependencies.sources).toBe(sources);
    expect(dependencies).not.toHaveProperty('promptPin');
    expect(infrastructureMocks.createIdentityYubiKeyService).not.toHaveBeenCalled();
  });
});
