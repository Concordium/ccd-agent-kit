import { beforeAll, describe, expect, it } from 'vitest';
import type { ConcordiumGRPCClient } from '@concordium/web-sdk';
import { ConcordiumNodeQueries, createConcordiumClient, type ConcordiumQueryClient } from '../../src/concordium/client.js';
import type { GrpcEndpoint } from '../../src/concordium/endpoints.js';

/**
 * Integration tests against a live node. They skip (rather than fail) when the
 * node is unreachable. Run explicitly with `pnpm test:live`. Override the target
 * with `CCD_TEST_GRPC_ENDPOINT` (host[:port]).
 */
const RAW_ENDPOINT = process.env.CCD_TEST_GRPC_ENDPOINT ?? 'grpc.testnet.concordium.com:20000';
const match = /^([^:]+)(?::(\d+))?$/.exec(RAW_ENDPOINT);
const TEST_ENDPOINT: GrpcEndpoint = {
  host: match?.[1] ?? RAW_ENDPOINT,
  port: match?.[2] !== undefined ? Number(match[2]) : 20000,
  tls: true,
};

describe('ConcordiumClient (integration)', () => {
  let client: ConcordiumGRPCClient | undefined;
  let queries: ConcordiumQueryClient | undefined;
  let reason = '';

  beforeAll(async () => {
    try {
      client = createConcordiumClient(TEST_ENDPOINT, 20000);
      queries = new ConcordiumNodeQueries(client);
      await queries.getConsensusInfo();
    } catch (err) {
      reason = String(err);
      client = undefined;
      queries = undefined;
    }
  });

  function requireClient(ctx: { skip: (msg?: string) => void }): ConcordiumQueryClient {
    if (!queries) {
      ctx.skip(`node unreachable (${TEST_ENDPOINT.host}:${TEST_ENDPOINT.port}): ${reason}`);
    }
    return queries as ConcordiumQueryClient;
  }

  it('getConsensusInfo returns a JSON-safe DTO', async (ctx) => {
    const c = requireClient(ctx);
    const info = await c.getConsensusInfo();
    expect(typeof info.bestBlockHash).toBe('string');
    expect(info.bestBlockHash).toMatch(/^[0-9a-f]{64}$/);
    expect(typeof info.lastFinalizedBlockHeight).toBe('string');
    expect(Number(info.lastFinalizedBlockHeight)).toBeGreaterThan(0);
    expect(Number.isFinite(Date.parse(info.genesisTime))).toBe(true);
  });

  it('getBlockInfo resolves last_final and hash identifiers', async (ctx) => {
    const c = requireClient(ctx);
    const byLabel = await c.getBlockInfo({ type: 'last_final' });
    expect(byLabel.hash).toMatch(/^[0-9a-f]{64}$/);

    const byHash = await c.getBlockInfo({ type: 'hash', hash: byLabel.hash });
    expect(byHash.height).toBe(byLabel.height);
  });

  it('getBlockInfo resolves finalized block heights', async (ctx) => {
    const c = requireClient(ctx);
    const final = await c.getBlockInfo({ type: 'last_final' });
    const height = BigInt(final.height);

    const byHeight = await c.getBlockInfo({ type: 'height', height });
    expect(byHeight.hash).toBe(final.hash);
  });

  it('getBlockTransactionEvents returns serializable events', async (ctx) => {
    const c = requireClient(ctx);
    const { hash, height, events } = await c.getBlockTransactionEvents({ type: 'last_final' });
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(typeof height).toBe('string');
    expect(Array.isArray(events)).toBe(true);
    expect(() => JSON.stringify(events)).not.toThrow();
  });

  it('getModuleRefs returns module refs', async (ctx) => {
    const c = requireClient(ctx);
    const moduleRefs = await c.getModuleRefs();
    for (const moduleRef of moduleRefs.slice(0, 5)) {
      expect(moduleRef).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('getPassiveDelegationInfo returns stake amounts', async (ctx) => {
    const c = requireClient(ctx);
    const info = await c.getPassiveDelegationInfo();
    expect(typeof info.totalStaked).toBe('string');
    expect(typeof info.currentPaydayStaked).toBe('string');
  });

  it('getTokenList returns a token list (possibly empty)', async (ctx) => {
    const c = requireClient(ctx);
    const { PLTs } = await c.getTokenList();
    expect(Array.isArray(PLTs)).toBe(true);
  });

  it('wraps node errors as { kind: "node" }', async (ctx) => {
    const c = requireClient(ctx);
    const allZero = '00'.repeat(32);
    await expect(c.getBlockInfo({ type: 'hash', hash: allZero })).rejects.toMatchObject({
      kind: 'node',
    });
  });
});
