import { getIdentityContextSnapshot,setIdentityContextSnapshot } from '@ccd-agent-kit/config-utils';
import { MAINNET_GENESIS_HASH } from '@ccd-agent-kit/sdk-utils';
import { BlockHash } from '@concordium/web-sdk';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
import { readFinalizedIdentityProviderContext } from '../../src/core/providers/node.js';
import { contextSnapshot,useProviderScratch } from '../providerHelpers.js';

const mocks = vi.hoisted(() => ({ resolveNetwork: vi.fn(), client: undefined as unknown, constructor: vi.fn() }));

vi.mock('@ccd-agent-kit/config-utils', async (importOriginal) => ({
  ...await importOriginal<typeof import('@ccd-agent-kit/config-utils')>(),
  resolveNetwork: mocks.resolveNetwork,
}));
vi.mock('@concordium/web-sdk/nodejs', () => ({
  credentials: { createSsl: vi.fn(() => ({})), createInsecure: vi.fn(() => ({})) },
  ConcordiumGRPCNodeClient: mocks.constructor.mockImplementation(function nodeClient() { return mocks.client; }),
}));

const description = { name: 'Provider', url: 'https://idp.example', description: 'Provider description' };
const ip = { ipIdentity: 4, ipDescription: description, ipVerifyKey: '22'.repeat(32), ipCdiVerifyKey: '33'.repeat(96) };
const ar = { arIdentity: 1, arDescription: description, arPublicKey: '44'.repeat(96) };
const networkArs = [
  ar,
  { ...ar, arIdentity: 2, arPublicKey: '45'.repeat(96) },
  { ...ar, arIdentity: 3, arPublicKey: '46'.repeat(96) },
];
const globalContext = {
  onChainCommitmentKey: '66'.repeat(48), bulletproofGenerators: '77'.repeat(64), genesisString: 'provider-node-test',
};
const finalized = BlockHash.fromHexString('ab'.repeat(32));
const sourceBlock = { hash: 'ab'.repeat(32), height: '17', time: '2026-10-16T11:59:59.000Z' };

useProviderScratch('provider-node-');

async function* values<T>(items: T[]) { yield* items; }

function install(genesisHash: string, providers = [ip], revokers = networkArs) {
  mocks.resolveNetwork.mockReturnValue({ config: {
    caip2: `ccd:${genesisHash.slice(0, 32)}`, genesisHash,
    grpc: { host: 'node.example', port: 20000, ssl: true },
  } });
  mocks.client = {
    getConsensusStatus: vi.fn(async () => ({ genesisBlock: BlockHash.fromHexString(genesisHash), lastFinalizedBlock: finalized })),
    getBlockInfo: vi.fn(async () => ({
      blockHash: finalized, blockHeight: 17n, blockSlotTime: new Date(sourceBlock.time),
    })),
    getCryptographicParameters: vi.fn(async () => globalContext),
    getIdentityProviders: vi.fn(() => values(providers)),
    getAnonymityRevokers: vi.fn(() => values(revokers)),
  };
  return finalized;
}

describe('finalized identity-provider node context', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveNetwork.mockReset();
  });
  afterEach(() => vi.useRealTimers());

  it.each([
    ['official mainnet', MAINNET_GENESIS_HASH, 'Mainnet'],
    ['custom network', '12'.repeat(32), 'Testnet'],
  ] as const)('reads %s from one finalized block and classifies the full genesis', async (_name, genesisHash, sdkNetwork) => {
    const finalized = install(genesisHash);
    const network = { caip2: `ccd:${genesisHash.slice(0, 32)}`, genesisHash };

    const result = await readFinalizedIdentityProviderContext(network);
    expect(result).toEqual({
      version: 1, network, sdkNetwork, sourceBlock, observedAt: expect.any(String),
      globalContext, identityProviders: [ip], anonymityRevokers: networkArs,
    });
    const client = mocks.client as Record<string, ReturnType<typeof vi.fn>>;
    expect(client.getCryptographicParameters).toHaveBeenCalledExactlyOnceWith(finalized);
    expect(client.getIdentityProviders).toHaveBeenCalledWith(finalized, expect.any(AbortSignal));
    expect(client.getAnonymityRevokers).toHaveBeenCalledWith(finalized, expect.any(AbortSignal));
    expect(client.getBlockInfo).toHaveBeenCalledExactlyOnceWith(finalized);
    expect(getIdentityContextSnapshot(network.genesisHash.slice(0, 32))).toEqual({
      version: 1, network, sourceBlock, observedAt: result.observedAt,
      globalContext, identityProviders: [ip], anonymityRevokers: networkArs,
    });
  });

  it('rejects a node full genesis mismatch even when its CAIP reference matches', async () => {
    const configured = `${MAINNET_GENESIS_HASH.slice(0, 32)}${'00'.repeat(16)}`;
    install(MAINNET_GENESIS_HASH);
    await expect(readFinalizedIdentityProviderContext({
      caip2: `ccd:${MAINNET_GENESIS_HASH.slice(0, 32)}`, genesisHash: configured,
    })).rejects.toMatchObject({ code: 'CONTEXT_MISMATCH' });
    expect((mocks.client as Record<string, ReturnType<typeof vi.fn>>).getCryptographicParameters).not.toHaveBeenCalled();
  });

  it('rejects the observed node genesis when it differs from configured full genesis', async () => {
    const genesisHash = '12'.repeat(32);
    install(genesisHash);
    (mocks.client as { getConsensusStatus: ReturnType<typeof vi.fn> }).getConsensusStatus.mockResolvedValue({
      genesisBlock: BlockHash.fromHexString('34'.repeat(32)),
      lastFinalizedBlock: finalized,
    });
    await expect(readFinalizedIdentityProviderContext({
      caip2: `ccd:${genesisHash.slice(0, 32)}`, genesisHash,
    })).rejects.toMatchObject({ code: 'CONTEXT_MISMATCH' });
    expect((mocks.client as { getCryptographicParameters: ReturnType<typeof vi.fn> }).getCryptographicParameters)
      .not.toHaveBeenCalled();
  });

  it('rejects an invalid SDK result at the local node boundary', async () => {
    const genesisHash = '12'.repeat(32);
    install(genesisHash, [ip, { ...ip }], [ar]);
    await expect(readFinalizedIdentityProviderContext({
      caip2: `ccd:${genesisHash.slice(0, 32)}`, genesisHash,
    })).rejects.toMatchObject({ code: 'CONTEXT_MISMATCH' });
  });

  it('preserves opaque empty SDK description strings in the shared snapshot', async () => {
    const genesisHash = '12'.repeat(32);
    const emptyDescription = { name: '', url: 'https://idp.example', description: '' };
    install(
      genesisHash,
      [{ ...ip, ipDescription: emptyDescription }],
      [{ ...ar, arDescription: emptyDescription }],
    );
    await expect(readFinalizedIdentityProviderContext({
      caip2: `ccd:${genesisHash.slice(0, 32)}`, genesisHash,
    })).resolves.toMatchObject({
      identityProviders: [{ ipDescription: emptyDescription }],
      anonymityRevokers: [{ arDescription: emptyDescription }],
    });
  });

  it.each([
    ['uppercase genesis', { caip2: `ccd:${'ab'.repeat(16)}`, genesisHash: 'ab'.repeat(32).toUpperCase() }],
    ['short genesis', { caip2: 'ccd:12', genesisHash: '12' }],
    ['wrong CAIP reference', { caip2: `ccd:${'34'.repeat(16)}`, genesisHash: '12'.repeat(32) }],
  ])('rejects invalid configured network binding: %s', async (_name, network) => {
    await expect(readFinalizedIdentityProviderContext(network)).rejects.toMatchObject({ code: 'CONTEXT_MISMATCH' });
    expect(mocks.resolveNetwork).not.toHaveBeenCalled();
  });

  it.each(['wrong genesis', 'RPC failure'] as const)(
    'does not replace a valid shared snapshot after %s',
    async (failure) => {
      const genesisHash = '12'.repeat(32);
      install(genesisHash);
      const previous = contextSnapshot();
      setIdentityContextSnapshot(genesisHash.slice(0, 32), previous);
      if (failure === 'wrong genesis') {
        (mocks.client as { getConsensusStatus: ReturnType<typeof vi.fn> }).getConsensusStatus.mockResolvedValue({
          genesisBlock: BlockHash.fromHexString('34'.repeat(32)), lastFinalizedBlock: finalized,
        });
      } else {
        (mocks.client as { getCryptographicParameters: ReturnType<typeof vi.fn> }).getCryptographicParameters
          .mockRejectedValue(new Error('private RPC detail'));
      }
      await expect(readFinalizedIdentityProviderContext({
        caip2: `ccd:${genesisHash.slice(0, 32)}`, genesisHash,
      })).rejects.toMatchObject({ code: failure === 'wrong genesis' ? 'CONTEXT_MISMATCH' : 'NODE_FAILED' });
      expect(getIdentityContextSnapshot(genesisHash.slice(0, 32))).toEqual(previous);
    },
  );

  it('fails the fresh read when the validated shared snapshot cannot be persisted', async () => {
    const genesisHash = '12'.repeat(32);
    install(genesisHash);
    const filename = path.join(
      process.env.XDG_STATE_HOME!, 'ccd-agent-kit', 'identity-context', `${genesisHash.slice(0, 32)}.json`,
    );
    await mkdir(filename, { recursive: true });
    await expect(readFinalizedIdentityProviderContext({
      caip2: `ccd:${genesisHash.slice(0, 32)}`, genesisHash,
    })).rejects.toMatchObject({ code: 'NODE_FAILED' });
  });

  it('rejects omitted SDK descriptions after using the insecure configured node channel', async () => {
    const genesisHash = '12'.repeat(32);
    install(genesisHash, [{ ...ip, ipDescription: undefined } as never], [{ ...ar, arDescription: undefined } as never]);
    mocks.resolveNetwork.mockReturnValue({ config: {
      caip2: `ccd:${genesisHash.slice(0, 32)}`, genesisHash,
      grpc: { host: 'node.example', port: 20000, ssl: false },
    } });
    await expect(readFinalizedIdentityProviderContext({
      caip2: `ccd:${genesisHash.slice(0, 32)}`, genesisHash,
    })).rejects.toMatchObject({ code: 'CONTEXT_MISMATCH' });
  });

  it('rejects provenance whose returned block hash differs from the captured finalized block', async () => {
    const genesisHash = '12'.repeat(32);
    install(genesisHash);
    (mocks.client as { getBlockInfo: ReturnType<typeof vi.fn> }).getBlockInfo.mockResolvedValue({
      blockHash: BlockHash.fromHexString('cd'.repeat(32)),
      blockHeight: 17n,
      blockSlotTime: new Date(sourceBlock.time),
    });
    await expect(readFinalizedIdentityProviderContext({
      caip2: `ccd:${genesisHash.slice(0, 32)}`, genesisHash,
    })).rejects.toMatchObject({ code: 'CONTEXT_MISMATCH' });
    expect(getIdentityContextSnapshot(genesisHash.slice(0, 32))).toBeUndefined();
  });

  it('fails closed when collection is aborted between streamed entries', async () => {
    const genesisHash = '12'.repeat(32);
    install(genesisHash);
    (mocks.client as { getIdentityProviders: ReturnType<typeof vi.fn> }).getIdentityProviders.mockImplementation(
      async function* (_block: unknown, signal: AbortSignal) {
        yield ip;
        (signal as AbortSignal & { dispatchEvent(event: Event): boolean }).dispatchEvent(new Event('abort'));
        yield ip;
      },
    );
    // AbortSignal cannot be directly toggled, so abort through the captured controller signal's event is insufficient;
    // a pre-aborted iterable is provided by aborting its signal owner in the companion AR call.
    (mocks.client as { getAnonymityRevokers: ReturnType<typeof vi.fn> }).getAnonymityRevokers.mockImplementation(
      (_block: unknown, signal: AbortSignal) => ({
        async *[Symbol.asyncIterator]() {
          Object.defineProperty(signal, 'aborted', { configurable: true, value: true });
          yield ar;
        },
      }),
    );
    await expect(readFinalizedIdentityProviderContext({
      caip2: `ccd:${genesisHash.slice(0, 32)}`, genesisHash,
    })).rejects.toMatchObject({ code: 'NODE_FAILED' });
  });

  it('aborts stalled provider streams at the bounded node deadline', async () => {
    vi.useFakeTimers();
    const genesisHash = '12'.repeat(32);
    install(genesisHash);
    (mocks.client as { getIdentityProviders: ReturnType<typeof vi.fn> }).getIdentityProviders.mockImplementation(
      (_block: unknown, signal: AbortSignal) => ({
        async *[Symbol.asyncIterator]() {
          await new Promise<void>((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
          });
          if (!signal.aborted) yield ip;
        },
      }),
    );
    const pending = readFinalizedIdentityProviderContext({
      caip2: `ccd:${genesisHash.slice(0, 32)}`, genesisHash,
    });
    const expectation = expect(pending).rejects.toMatchObject({ code: 'NODE_FAILED' });
    await vi.advanceTimersByTimeAsync(10_001);
    await expectation;
  });
});
