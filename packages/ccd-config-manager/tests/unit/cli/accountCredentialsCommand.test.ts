import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountCredentialObservation, NetworkConfig } from '@ccd-agent-kit/config-utils';
import { ed25519PublicKey } from '@ccd-agent-kit/sdk-utils';
import { AccountAddress } from '@concordium/web-sdk';

type ConfigModule = typeof import('@ccd-agent-kit/config-utils');
type GrpcModule = typeof import('../../../src/core/grpc.js');

const config = vi.hoisted(() => ({
  getAccountCredentialObservation: vi.fn<ConfigModule['getAccountCredentialObservation']>(),
  getActiveNetwork: vi.fn<ConfigModule['getActiveNetwork']>(),
  getNetwork: vi.fn<ConfigModule['getNetwork']>(),
  loadAccountCredentials: vi.fn<ConfigModule['loadAccountCredentials']>(),
  removeAccountCredentialObservation: vi.fn<ConfigModule['removeAccountCredentialObservation']>(),
  setAccountCredentialObservation: vi.fn<ConfigModule['setAccountCredentialObservation']>(),
  setAccountCredentialRefreshError: vi.fn<ConfigModule['setAccountCredentialRefreshError']>(),
}));
const grpc = vi.hoisted(() => ({
  caip2Reference: vi.fn<GrpcModule['caip2Reference']>(),
  queryFinalizedAccountCredentials: vi.fn<GrpcModule['queryFinalizedAccountCredentials']>(),
}));

vi.mock('@ccd-agent-kit/config-utils', () => config);
vi.mock('../../../src/core/grpc.js', () => grpc);

import { runAccountCredentialsCommand } from '../../../src/cli/accountCredentialsCommand.js';

const CANONICAL_ADDRESS = '3DPgLSmDKt7tvAybE95obMXANrUChv5aBpzGPU3qjaG7ERG6JC';
const ADDRESS = AccountAddress.getAlias(AccountAddress.fromBase58(CANONICAL_ADDRESS), 1).address;
const ATTEMPTED = '2026-10-25T01:02:03.000Z';
const network = {
  caip2: 'ccd:mainnet',
  genesisHash: 'ef'.repeat(32),
  grpc: { host: 'node.example', port: 20_000, ssl: true },
} satisfies NetworkConfig;
const observation = {
  accountThreshold: '1',
  credentials: {
    '0': {
      keys: { '0': { publicKey: ed25519PublicKey.require('ab'.repeat(32)), scheme: 'Ed25519' } },
      threshold: '1',
    },
  },
  sourceBlock: { hash: 'cd'.repeat(32), height: '123', time: '2026-09-24T00:00:00.000Z' },
} satisfies AccountCredentialObservation;
const observationWithRefreshError = {
  ...observation,
  refreshError: { attempted: '2026-10-24T12:00:00.000Z', kind: 'network', message: 'offline' },
} satisfies AccountCredentialObservation;

describe('runAccountCredentialsCommand', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    config.getActiveNetwork.mockReturnValue({ config: network, name: 'mainnet', source: 'config' });
    config.getNetwork.mockReturnValue(network);
    config.loadAccountCredentials.mockReturnValue({});
    grpc.caip2Reference.mockReturnValue('mainnet-ref');
  });

  it('stores and renders a representative finalized query result', async () => {
    const queryAccountCredentials = vi
      .fn<NonNullable<Parameters<typeof runAccountCredentialsCommand>[0]['queryAccountCredentials']>>()
      .mockResolvedValue({ canonicalAddress: CANONICAL_ADDRESS, observation });
    const result = await run({ kind: 'refresh', address: ADDRESS }, queryAccountCredentials);
    expect(result.code).toBe(0);
    expect(config.setAccountCredentialObservation).toHaveBeenCalledWith(CANONICAL_ADDRESS, observation, 'mainnet-ref');
    expect(result.stdout).toContain('Credentials: 1');
  });

  it('uses the default finalized query and persists its canonical result', async () => {
    grpc.queryFinalizedAccountCredentials.mockResolvedValue({ canonicalAddress: CANONICAL_ADDRESS, observation });

    expect((await run({ kind: 'refresh', address: ADDRESS })).code).toBe(0);

    expect(grpc.queryFinalizedAccountCredentials).toHaveBeenCalledWith(network.grpc, ADDRESS);
    expect(config.setAccountCredentialObservation).toHaveBeenCalledWith(
      CANONICAL_ADDRESS,
      observation,
      'mainnet-ref',
    );
  });

  it.each(['network', 'node', 'not_found'] as const)(
    'records a structured %s refresh failure with its message and attempt time',
    async (kind) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(ATTEMPTED));
      try {
        const result = await run(
          { kind: 'refresh', address: ADDRESS },
          vi.fn<NonNullable<Parameters<typeof runAccountCredentialsCommand>[0]['queryAccountCredentials']>>()
            .mockRejectedValue(Object.assign(new Error(`${kind} unavailable`), { kind })),
        );

        expect(result).toEqual({ code: 1, stderr: [`${kind} unavailable`], stdout: [] });
        expect(config.setAccountCredentialRefreshError).toHaveBeenCalledWith(
          ADDRESS,
          { attempted: ATTEMPTED, kind, message: `${kind} unavailable` },
          'mainnet-ref',
        );
        expect(config.setAccountCredentialObservation).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.each([
    { error: new Error('ordinary failure'), message: 'ordinary failure' },
    { error: 'string failure', message: 'string failure' },
    { error: { kind: 'unsupported', message: 'unsupported failure' }, message: 'unsupported failure' },
  ])('stores unstructured refresh failures as unknown without false success', async ({ error, message }) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(ATTEMPTED));
    try {
      const result = await run(
        { kind: 'refresh', address: ADDRESS },
        vi.fn<NonNullable<Parameters<typeof runAccountCredentialsCommand>[0]['queryAccountCredentials']>>()
          .mockRejectedValue(error),
      );

      expect(result).toMatchObject({ code: 1, stderr: [message], stdout: [] });
      expect(config.setAccountCredentialRefreshError).toHaveBeenCalledWith(
        ADDRESS,
        { attempted: ATTEMPTED, kind: 'unknown', message },
        'mainnet-ref',
      );
      expect(config.setAccountCredentialObservation).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('retains a recognized refresh kind when its non-string message requires fallback formatting', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(ATTEMPTED));
    try {
      const error = { kind: 'node', message: { detail: 'unavailable' } };
      const result = await run(
        { kind: 'refresh', address: ADDRESS },
        vi.fn<NonNullable<Parameters<typeof runAccountCredentialsCommand>[0]['queryAccountCredentials']>>()
          .mockRejectedValue(error),
      );

      expect(result).toEqual({ code: 1, stderr: [String(error)], stdout: [] });
      expect(config.setAccountCredentialRefreshError).toHaveBeenCalledWith(
        ADDRESS,
        { attempted: ATTEMPTED, kind: 'node', message: String(error) },
        'mainnet-ref',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('renders cached observations and absent-cache branches', async () => {
    config.getAccountCredentialObservation.mockReturnValueOnce(observation);
    const shown = await run({ kind: 'show', address: ADDRESS });
    expect(shown.code).toBe(0);
    expect(shown.stdout.join('\n')).toContain(`Key 0: Ed25519 ${'ab'.repeat(32)}`);

    config.getAccountCredentialObservation.mockReturnValueOnce(undefined);
    const missing = await run({ kind: 'show', address: ADDRESS });
    expect(missing).toMatchObject({ code: 1, stderr: [`No account credentials cached for ${ADDRESS} on mainnet.`] });
  });

  it('renders complete cached refresh-error metadata alongside credential keys', async () => {
    config.getAccountCredentialObservation.mockReturnValue(observationWithRefreshError);

    const shown = await run({ kind: 'show', address: ADDRESS });

    expect(shown.code).toBe(0);
    expect(shown.stdout).toContain(`  Key 0: Ed25519 ${'ab'.repeat(32)}`);
    expect(shown.stdout).toContain('Refresh error: 2026-10-24T12:00:00.000Z network: offline');
  });

  it('renders list and remove producer results', async () => {
    config.loadAccountCredentials.mockReturnValueOnce({ [ADDRESS]: observationWithRefreshError });
    const listed = await run({ kind: 'list' });
    expect(listed.stdout.join('\n')).toContain(`${ADDRESS} credentials=1 refresh=failed`);

    config.removeAccountCredentialObservation.mockReturnValueOnce(false).mockReturnValueOnce(true);
    expect((await run({ kind: 'remove', address: ADDRESS })).code).toBe(1);
    expect((await run({ kind: 'remove', address: ADDRESS })).stdout).toEqual([
      `Removed account credentials for ${ADDRESS} on mainnet.`,
    ]);
  });

  it('maps network resolution failures to usage errors before querying', async () => {
    config.getNetwork.mockReturnValueOnce(undefined);
    const query = vi.fn<NonNullable<Parameters<typeof runAccountCredentialsCommand>[0]['queryAccountCredentials']>>();
    const result = await run({ kind: 'refresh', address: ADDRESS, network: 'missing' }, query);
    expect(result).toMatchObject({ code: 2, stderr: ["Network 'missing' not found."] });
    expect(query).not.toHaveBeenCalled();
  });

  it.each([
    { request: { kind: 'show', address: ADDRESS, network: 'missing' } as const },
    { request: { kind: 'list', network: 'missing' } as const },
    { request: { kind: 'remove', address: ADDRESS, network: 'missing' } as const },
  ])('returns a useful usage error without reading or mutating the cache for $request.kind scope failure', async ({ request }) => {
    config.getNetwork.mockReturnValueOnce(undefined);
    const query = vi.fn<NonNullable<Parameters<typeof runAccountCredentialsCommand>[0]['queryAccountCredentials']>>();

    expect(await run(request, query)).toEqual({ code: 2, stderr: ["Network 'missing' not found."], stdout: [] });
    expect(query).not.toHaveBeenCalled();
    expect(grpc.queryFinalizedAccountCredentials).not.toHaveBeenCalled();
    expect(config.getAccountCredentialObservation).not.toHaveBeenCalled();
    expect(config.loadAccountCredentials).not.toHaveBeenCalled();
    expect(config.removeAccountCredentialObservation).not.toHaveBeenCalled();
    expect(config.setAccountCredentialObservation).not.toHaveBeenCalled();
    expect(config.setAccountCredentialRefreshError).not.toHaveBeenCalled();
  });
});

async function run(
  request: Parameters<typeof runAccountCredentialsCommand>[0]['request'],
  queryAccountCredentials?: Parameters<typeof runAccountCredentialsCommand>[0]['queryAccountCredentials'],
) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await runAccountCredentialsCommand({ request, queryAccountCredentials, stdout, stderr });
  return { code, stderr, stdout };
}
