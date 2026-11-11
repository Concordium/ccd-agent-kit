import { beforeEach, describe, expect, it, vi } from 'vitest';

const consensusStatusMock = vi.fn();
vi.mock('@concordium/web-sdk/nodejs', () => {
  class MockNodeClient {
    public constructor(_host: string, _port: number, _creds: unknown) {}

    public getConsensusStatus(): Promise<unknown> {
      return consensusStatusMock();
    }
  }

  return {
    ConcordiumGRPCNodeClient: MockNodeClient,
    credentials: {
      createSsl: () => ({ kind: 'ssl' }),
      createInsecure: () => ({ kind: 'insecure' }),
    },
  };
});

vi.mock('@concordium/web-sdk', () => ({
  BlockHash: {
    toHexString: (value: unknown) => String(value),
  },
}));

import {
  autoDetectConnection,
  GrpcConnectionError,
  queryConsensusInfo,
} from '../../../../src/core/config/grpc.js';

describe('grpc', () => {
  const VALID_GENESIS = '9dd9ca4d19e9393877d2c44b70f89acb'.padEnd(64, '0');
  beforeEach(() => {
    consensusStatusMock.mockReset();
  });

  describe('GrpcConnectionError', () => {
    it('has correct name property', () => {
      const error = new GrpcConnectionError('test');
      expect(error.name).toBe('GrpcConnectionError');
    });

    it('is an instance of Error', () => {
      const error = new GrpcConnectionError('test');
      expect(error).toBeInstanceOf(Error);
    });
  });

  describe('queryConsensusInfo', () => {
    it('returns genesis block from consensus status', async () => {
      consensusStatusMock.mockResolvedValueOnce({
        genesisBlock: VALID_GENESIS,
      });

      const result = await queryConsensusInfo({ host: 'localhost', port: 20000, ssl: true });
      expect(result.genesisBlock).toBe(VALID_GENESIS);
    });

    it('does not attempt node shutdown after a successful consensus query', async () => {
      consensusStatusMock.mockResolvedValueOnce({
        genesisBlock: VALID_GENESIS,
      });

      await expect(queryConsensusInfo({ host: 'localhost', port: 20000, ssl: false })).resolves.toEqual({
        genesisBlock: VALID_GENESIS,
      });
    });

    it('wraps upstream errors in GrpcConnectionError', async () => {
      consensusStatusMock.mockRejectedValueOnce(new Error('socket closed'));

      await expect(queryConsensusInfo({ host: 'localhost', port: 20000, ssl: false })).rejects.toThrow(
        'gRPC call failed: socket closed',
      );
    });
  });

  describe('autoDetectConnection', () => {
    it('uses SSL when first attempt succeeds', async () => {
      consensusStatusMock.mockResolvedValueOnce({ genesisBlock: VALID_GENESIS });

      const result = await autoDetectConnection('localhost', 20000);

      expect(result.ssl).toBe(true);
      expect(result.genesisBlock).toBe(VALID_GENESIS);
      expect(consensusStatusMock).toHaveBeenCalledTimes(1);
    });

    it('falls back to non-SSL when SSL attempt fails', async () => {
      consensusStatusMock
        .mockRejectedValueOnce(new Error('tls failed'))
        .mockResolvedValueOnce({ genesisBlock: VALID_GENESIS });

      const result = await autoDetectConnection('localhost', 20000);

      expect(result.ssl).toBe(false);
      expect(result.genesisBlock).toBe(VALID_GENESIS);
      expect(consensusStatusMock).toHaveBeenCalledTimes(2);
    });

    it('throws when both SSL and non-SSL attempts fail', async () => {
      consensusStatusMock
        .mockRejectedValueOnce(new Error('tls failed'))
        .mockRejectedValueOnce(new Error('plain failed'));

      await expect(autoDetectConnection('localhost', 20000)).rejects.toThrow(
        'Could not connect to gRPC node at localhost:20000 (tried tls and no-tls)',
      );
    });
  });
});
