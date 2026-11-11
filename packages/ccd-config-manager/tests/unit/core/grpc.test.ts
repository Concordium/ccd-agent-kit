import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BlockHash, type AccountCredential } from '@concordium/web-sdk';

const grpcMocks = vi.hoisted(() => ({
  createInsecure: vi.fn(() => ({ kind: 'insecure' })),
  createSsl: vi.fn(() => ({ kind: 'ssl' })),
  fromBase58: vi.fn((address: string) => ({ address })),
  getAccountInfo: vi.fn(),
  getBlockInfo: vi.fn(),
  getConsensusStatus: vi.fn(),
  constructors: [] as Array<{ host: string; port: number; credentials: unknown; options: unknown }>,
}));

vi.mock('@concordium/web-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@concordium/web-sdk')>();
  return {
    ...actual,
    AccountAddress: {
      fromBase58: grpcMocks.fromBase58,
    },
  };
});

vi.mock('@concordium/web-sdk/nodejs', () => ({
  credentials: {
    createInsecure: grpcMocks.createInsecure,
    createSsl: grpcMocks.createSsl,
  },
  ConcordiumGRPCNodeClient: class ConcordiumGRPCNodeClient {
    public constructor(host: string, port: number, credentials: unknown, options: unknown) {
      grpcMocks.constructors.push({ host, port, credentials, options });
    }

    public getConsensusStatus() {
      return grpcMocks.getConsensusStatus();
    }

    public getAccountInfo(address: unknown, block: unknown) {
      return grpcMocks.getAccountInfo(address, block);
    }

    public getBlockInfo(block: unknown) {
      return grpcMocks.getBlockInfo(block);
    }
  },
}));

describe('gRPC discovery helpers', () => {
  beforeEach(() => {
    grpcMocks.createInsecure.mockClear();
    grpcMocks.createSsl.mockClear();
    grpcMocks.fromBase58.mockClear();
    grpcMocks.getAccountInfo.mockReset();
    grpcMocks.getBlockInfo.mockReset();
    grpcMocks.getConsensusStatus.mockReset();
    grpcMocks.constructors.length = 0;
  });

  it('queries consensus info using TLS credentials', async () => {
    const { queryConsensusInfo } = await import('../../../src/core/grpc.js');
    grpcMocks.getConsensusStatus.mockResolvedValueOnce({ genesisBlock: BlockHash.fromHexString('a'.repeat(64)) });

    await expect(queryConsensusInfo({ host: 'node.example', port: 20000, ssl: true })).resolves.toEqual({
      genesisBlock: 'a'.repeat(64),
    });
    expect(grpcMocks.createSsl).toHaveBeenCalledOnce();
    expect(grpcMocks.constructors).toEqual([
      { host: 'node.example', port: 20000, credentials: { kind: 'ssl' }, options: { timeout: 5000 } },
    ]);
  });

  it('wraps consensus query failures in GrpcConnectionError', async () => {
    const { GrpcConnectionError, queryConsensusInfo } = await import('../../../src/core/grpc.js');
    grpcMocks.getConsensusStatus.mockRejectedValueOnce(new Error('unavailable'));

    await expect(queryConsensusInfo({ host: 'node.example', port: 20000, ssl: false })).rejects.toBeInstanceOf(
      GrpcConnectionError,
    );
    expect(grpcMocks.createInsecure).toHaveBeenCalledOnce();
  });

  it.each([
    [Object.assign(new Error('native deadline'), { code: 4 }), 'Timed out after 1234ms: native deadline'],
    [new Error('request timeout'), 'Timed out after 1234ms: request timeout'],
    ['offline string', 'offline string'],
    [{ reason: 'offline' }, '[object Object]'],
  ])('formats consensus query SDK failures for %s', async (failure, message) => {
    const { GrpcConnectionError, queryConsensusInfo } = await import('../../../src/core/grpc.js');
    grpcMocks.getConsensusStatus.mockRejectedValueOnce(failure);
    const result = queryConsensusInfo({ host: 'node.example', port: 20000, ssl: true }, 1234);

    await expect(result).rejects.toThrow(GrpcConnectionError);
    await expect(result).rejects.toThrow(message);
    expect(grpcMocks.constructors).toEqual([
      { host: 'node.example', port: 20000, credentials: { kind: 'ssl' }, options: { timeout: 1234 } },
    ]);
  });

  it('auto-detects SSL connections first', async () => {
    const { autoDetectConnection } = await import('../../../src/core/grpc.js');
    grpcMocks.getConsensusStatus.mockResolvedValueOnce({ genesisBlock: BlockHash.fromHexString('b'.repeat(64)) });

    await expect(autoDetectConnection('node.example', 20000)).resolves.toEqual({
      host: 'node.example',
      port: 20000,
      ssl: true,
      genesisBlock: 'b'.repeat(64),
    });
    expect(grpcMocks.getConsensusStatus).toHaveBeenCalledTimes(1);
  });

  it('falls back to non-SSL when SSL detection fails', async () => {
    const { autoDetectConnection } = await import('../../../src/core/grpc.js');
    grpcMocks.getConsensusStatus
      .mockRejectedValueOnce(new Error('tls failed'))
      .mockResolvedValueOnce({ genesisBlock: BlockHash.fromHexString('c'.repeat(64)) });

    await expect(autoDetectConnection('node.example', 20000)).resolves.toEqual({
      host: 'node.example',
      port: 20000,
      ssl: false,
      genesisBlock: 'c'.repeat(64),
    });
    expect(grpcMocks.createSsl).toHaveBeenCalledOnce();
    expect(grpcMocks.createInsecure).toHaveBeenCalledOnce();
  });

  it('throws one clear error when both SSL and non-SSL detection fail', async () => {
    const { autoDetectConnection, GrpcConnectionError } = await import('../../../src/core/grpc.js');
    grpcMocks.getConsensusStatus.mockRejectedValue(new Error('offline'));

    await expect(autoDetectConnection('node.example', 20000)).rejects.toBeInstanceOf(GrpcConnectionError);
    expect(grpcMocks.getConsensusStatus).toHaveBeenCalledTimes(2);
  });

  it('queries finalized account credentials and records source block metadata', async () => {
    const { queryFinalizedAccountCredentials } = await import('../../../src/core/grpc.js');
    const lastFinalizedBlockHex = '44'.repeat(32);
    const lastFinalizedBlock = BlockHash.fromHexString(lastFinalizedBlockHex);
    grpcMocks.getConsensusStatus.mockResolvedValueOnce({ lastFinalizedBlock });
    grpcMocks.getAccountInfo.mockResolvedValueOnce({
      accountAddress: { address: 'canonical-address' },
      accountThreshold: 1,
      accountCredentials: {
        '0': accountCredential(1),
      },
    });
    grpcMocks.getBlockInfo.mockResolvedValueOnce({
      blockHeight: 123n,
      blockSlotTime: new Date('2026-09-25T00:00:00.000Z'),
    });

    await expect(
      queryFinalizedAccountCredentials({ host: 'node.example', port: 20000, ssl: true }, 'input-address'),
    ).resolves.toEqual({
      canonicalAddress: 'canonical-address',
      observation: {
        accountThreshold: '1',
        credentials: { '0': { keys: { '0': { publicKey: 'aa'.repeat(32), scheme: 'Ed25519' } }, threshold: '1' } },
        sourceBlock: { hash: lastFinalizedBlockHex, height: '123', time: '2026-09-25T00:00:00.000Z' },
      },
    });
    expect(grpcMocks.fromBase58).toHaveBeenCalledWith('input-address');
    expect(grpcMocks.getAccountInfo).toHaveBeenCalledWith({ address: 'input-address' }, lastFinalizedBlock);
    expect(grpcMocks.getBlockInfo).toHaveBeenCalledWith(lastFinalizedBlock);
    expect(grpcMocks.getAccountInfo.mock.calls[0]?.[1]).toBe(lastFinalizedBlock);
    expect(grpcMocks.getBlockInfo.mock.calls[0]?.[0]).toBe(lastFinalizedBlock);
  });

  it('wraps finalized account credential query failures', async () => {
    const { GrpcConnectionError, queryFinalizedAccountCredentials } = await import('../../../src/core/grpc.js');
    grpcMocks.getConsensusStatus.mockRejectedValueOnce(new Error('account unavailable'));

    await expect(
      queryFinalizedAccountCredentials({ host: 'node.example', port: 20000, ssl: false }, 'input-address'),
    ).rejects.toBeInstanceOf(GrpcConnectionError);
  });

  it('extracts SDK credential keys and thresholds while omitting credential IDs', async () => {
    const { extractAccountCredentials } = await import('../../../src/core/grpc.js');

    expect(
      extractAccountCredentials({
        accountCredentials: {
          '0': accountCredential(1),
          '1': accountCredential(2),
        },
      }),
    ).toEqual({
      '0': { keys: { '0': { publicKey: 'aa'.repeat(32), scheme: 'Ed25519' } }, threshold: '1' },
      '1': { keys: { '0': { publicKey: 'aa'.repeat(32), scheme: 'Ed25519' } }, threshold: '2' },
    });
  });
});

function accountCredential(threshold: number): AccountCredential {
  return {
    v: 0,
    value: {
      type: 'initial',
      contents: {
        regId: '11'.repeat(48),
        ipIdentity: 0,
        policy: { createdAt: '202601', validTo: '202701', revealedAttributes: {} },
        credentialPublicKeys: { threshold, keys: { 0: { schemeId: 'ed25519', verifyKey: 'aa'.repeat(32) } } },
      },
    },
  };
}
