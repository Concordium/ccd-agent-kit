import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  findAccountLabelForAddress,
  getAccountCredentialObservation,
  resolveAccountLabel,
  resolveNetwork,
  type AccountCredentialObservation,
} from '@ccd-agent-kit/config-utils';
import { ed25519PublicKey } from '@ccd-agent-kit/sdk-utils';
import {
  AccountCredentialsSigningBackend,
  hasAvailableObservedCredentialKey,
} from '../../../src/core/sign/backends/accountCredentials.js';
import { signMessage } from '../../../src/core/sign/signMessage.js';

import {
  CliUsageError,
  createSignMessageCommandRequest,
  runSignMessageCommand,
} from '../../../src/cli/signMessageCommand.js';
import { transactionFixtures } from '../../helpers/transactionFixtures.js';

vi.mock('@ccd-agent-kit/config-utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ccd-agent-kit/config-utils')>()),
  findAccountLabelForAddress: vi.fn(),
  getAccountCredentialObservation: vi.fn(),
  resolveAccountLabel: vi.fn(),
  resolveNetwork: vi.fn(),
}));
vi.mock('../../../src/core/sign/backends/accountCredentials.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/core/sign/backends/accountCredentials.js')>()),
  hasAvailableObservedCredentialKey: vi.fn(),
}));
vi.mock('../../../src/core/sign/signMessage.js', () => ({ signMessage: vi.fn() }));

const observation: AccountCredentialObservation = {
  accountThreshold: '1',
  credentials: {
    0: { keys: { 0: { publicKey: ed25519PublicKey.require('11'.repeat(32)), scheme: 'Ed25519' } }, threshold: '1' },
  },
  sourceBlock: { hash: '22'.repeat(32), height: '1', time: '2026-01-01T00:00:00.000Z' },
};
const signature = { 0: { 0: '33'.repeat(64) } };

describe('createSignMessageCommandRequest', () => {
  it('parses direct text input', () => {
    const result = createSignMessageCommandRequest({
      account: transactionFixtures.sender,
      input: 'hello',
      format: 'text',
    });

    expect(result).toMatchObject({
      account: transactionFixtures.sender,
      format: 'text',
      source: { kind: 'input', value: 'hello' },
    });
  });

  it('parses file input and network option', () => {
    const result = createSignMessageCommandRequest({
      account: transactionFixtures.sender,
      inputFile: 'payload.txt',
      format: 'hex',
      network: 'testnet',
    });

    expect(result).toMatchObject({
      account: transactionFixtures.sender,
      format: 'hex',
      network: 'testnet',
      source: { kind: 'input-file', path: 'payload.txt' },
    });
  });

  it('rejects conflicting input sources', () => {
    expect(() => {
      createSignMessageCommandRequest({
        account: transactionFixtures.sender,
        input: 'hello',
        stdin: true,
        format: 'text',
      });
    }).toThrowError(new CliUsageError('A single input source must be provided via --input, --input-file, or --stdin.'));
  });
});

describe('runSignMessageCommand', () => {
  beforeEach(() => {
    vi.mocked(resolveNetwork)
      .mockReset()
      .mockReturnValue({
        config: {
          caip2: `ccd:${'11'.repeat(16)}`,
          genesisHash: '00'.repeat(32),
          grpc: { host: 'node', port: 20000, ssl: true },
        },
        name: 'testnet',
      });
    vi.mocked(resolveAccountLabel).mockReset().mockReturnValue({ address: 'resolved-address', label: 'Selected' });
    vi.mocked(getAccountCredentialObservation).mockReset().mockReturnValue(observation);
    vi.mocked(hasAvailableObservedCredentialKey).mockReset().mockReturnValue(true);
    vi.mocked(findAccountLabelForAddress).mockReset().mockReturnValue('First');
    vi.mocked(signMessage).mockReset().mockResolvedValue({
      account: 'resolved-address',
      inputFormat: 'text',
      messageHex: '6869',
      messageText: 'hi',
      signature,
    });
  });

  it('preserves the canonical selected label while signing with its address', async () => {
    const stdout: string[] = [];
    const exitCode = await runSignMessageCommand({
      request: createSignMessageCommandRequest({ account: 'SELECTED', input: 'hi', format: 'text' }),
      stderr: [],
      stdout,
    });

    expect(exitCode).toBe(0);
    expect(resolveAccountLabel).toHaveBeenCalledWith('SELECTED', '11'.repeat(16));
    expect(getAccountCredentialObservation).toHaveBeenCalledWith('resolved-address', '11'.repeat(16));
    expect(signMessage).toHaveBeenCalledWith({
      account: 'resolved-address',
      backend: expect.any(AccountCredentialsSigningBackend),
      messageText: 'hi',
    });
    const result = JSON.parse(stdout.join('\n')) as Record<string, unknown>;
    expect(result).toMatchObject({ account: 'resolved-address', label: 'Selected' });
  });

  it('uses the preferred reverse label for a native address selector', async () => {
    vi.mocked(resolveAccountLabel).mockReturnValue(undefined);
    const stdout: string[] = [];

    const exitCode = await runSignMessageCommand({
      request: createSignMessageCommandRequest({ account: 'resolved-address', input: 'hi', format: 'text' }),
      stderr: [],
      stdout,
    });

    expect(exitCode).toBe(0);
    expect(signMessage).toHaveBeenCalledWith(expect.objectContaining({ account: 'resolved-address' }));
    expect(findAccountLabelForAddress).toHaveBeenCalledWith('resolved-address', '11'.repeat(16));
    expect(JSON.parse(stdout.join('\n'))).toMatchObject({ account: 'resolved-address', label: 'First' });
  });

  it('directs users to refresh when finalized account credentials are absent', async () => {
    vi.mocked(getAccountCredentialObservation).mockReturnValue(undefined);
    const stderr: string[] = [];

    const exitCode = await runSignMessageCommand({
      request: createSignMessageCommandRequest({ account: 'Selected', input: 'hi', format: 'text' }),
      stderr,
      stdout: [],
    });

    expect(exitCode).toBe(1);
    expect(stderr).toEqual([
      expect.stringContaining("No finalized account credentials cached for 'Selected' on network 'testnet'"),
    ]);
    expect(stderr[0]).toContain('ccd-config-manager account credentials refresh');
    expect(signMessage).not.toHaveBeenCalled();
  });
});
