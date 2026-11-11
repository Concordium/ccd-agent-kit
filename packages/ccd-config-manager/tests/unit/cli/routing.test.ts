import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import type { AccountCredentialsCommandRequest } from '../../../src/cli/accountCredentialsCommand.js';
import type { ChainClientCommandRequest } from '../../../src/cli/chainClientCommand.js';
import type { NetworkCommandRequest } from '../../../src/cli/networkCommand.js';
import type { PathsCommandRequest } from '../../../src/cli/pathsCommand.js';

vi.mock('../../../src/cli/accountCredentialsCommand.js', () => ({ runAccountCredentialsCommand: vi.fn() }));
vi.mock('../../../src/cli/keyCommand.js', () => ({ runKeyCommand: vi.fn() }));
vi.mock('../../../src/cli/chainClientCommand.js', () => ({ runChainClientCommand: vi.fn() }));
vi.mock('../../../src/cli/networkCommand.js', () => ({ runNetworkCommand: vi.fn() }));
vi.mock('../../../src/cli/pathsCommand.js', () => ({ runPathsCommand: vi.fn() }));
vi.mock('../../../src/cli/storageCommand.js', () => ({ runStorageCommand: vi.fn() }));

import { runCli } from '../../../src/bin/ccd-config-manager.js';
import { runAccountCredentialsCommand } from '../../../src/cli/accountCredentialsCommand.js';
import { runKeyCommand } from '../../../src/cli/keyCommand.js';
import { runChainClientCommand } from '../../../src/cli/chainClientCommand.js';
import { runNetworkCommand } from '../../../src/cli/networkCommand.js';
import { runPathsCommand } from '../../../src/cli/pathsCommand.js';
import { runStorageCommand } from '../../../src/cli/storageCommand.js';

const handlers = {
  accountCredentials: vi.mocked(runAccountCredentialsCommand),
  key: vi.mocked(runKeyCommand),
  chainClient: vi.mocked(runChainClientCommand),
  network: vi.mocked(runNetworkCommand),
  paths: vi.mocked(runPathsCommand),
  storage: vi.mocked(runStorageCommand),
};

type RoutingCase =
  | { handler: 'accountCredentials'; argv: string[]; request: AccountCredentialsCommandRequest }
  | { handler: 'chainClient'; argv: string[]; request: ChainClientCommandRequest }
  | { handler: 'network'; argv: string[]; request: NetworkCommandRequest }
  | { handler: 'paths'; argv: string[]; request: PathsCommandRequest };

const routingCases = [
  { handler: 'network', argv: ['network', 'list'], request: { kind: 'list' } },
  { handler: 'network', argv: ['network', 'inspect', '--name', 'testnet'], request: { kind: 'show', name: 'testnet' } },
  { handler: 'network', argv: ['network', 'add', '--name', 'dev', '--grpc-host', 'node'], request: { kind: 'add', name: 'dev', grpcHost: 'node', grpcPort: '20000' } },
  { handler: 'network', argv: ['network', 'update', '--name', 'dev', '--grpc-port', '21000'], request: { kind: 'update', name: 'dev', grpcHost: undefined, grpcPort: '21000' } },
  { handler: 'network', argv: ['network', 'remove', '--name', 'dev'], request: { kind: 'remove', name: 'dev' } },
  { handler: 'network', argv: ['network', 'default', 'show'], request: { kind: 'default-show' } },
  { handler: 'network', argv: ['network', 'default', 'set', '--name', 'mainnet'], request: { kind: 'default', name: 'mainnet' } },
  { handler: 'network', argv: ['network', 'doctor'], request: { kind: 'doctor', name: undefined } },
  { handler: 'accountCredentials', argv: ['account', 'credentials', 'refresh', '--address', 'addr', '--network', 'testnet'], request: { kind: 'refresh', address: 'addr', network: 'testnet' } },
  { handler: 'accountCredentials', argv: ['account', 'credentials', 'inspect', '--address', 'addr'], request: { kind: 'show', address: 'addr', network: undefined } },
  { handler: 'accountCredentials', argv: ['account', 'credentials', 'list', '--network', 'mainnet'], request: { kind: 'list', network: 'mainnet' } },
  { handler: 'accountCredentials', argv: ['account', 'credentials', 'remove', '--address', 'addr'], request: { kind: 'remove', address: 'addr', network: undefined } },
  { handler: 'chainClient', argv: ['service', 'chain-client', 'inspect'], request: { kind: 'show' } },
  { handler: 'chainClient', argv: ['service', 'chain-client', 'startup-refresh', 'set', '--enabled', 'false', '--max-age', '7d', '--failure-retry', '5m', '--concurrency', '3'], request: { kind: 'startup-refresh-set', enabled: 'false', maxAge: '7d', failureRetry: '5m', concurrency: '3' } },
  { handler: 'chainClient', argv: ['service', 'chain-client', 'startup-refresh', 'reset'], request: { kind: 'startup-refresh-reset' } },
  { handler: 'paths', argv: ['paths', '--network', 'testnet'], request: { network: 'testnet' } },
] satisfies readonly RoutingCase[];

describe('ccd-config-manager Commander routing', () => {
  let stdoutWrite: MockInstance;
  let stderrWrite: MockInstance;

  beforeEach(() => {
    vi.clearAllMocks();
    stdoutWrite = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    stderrWrite = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    for (const handler of Object.values(handlers)) handler.mockResolvedValue(0);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(routingCases)('maps $argv to the $handler domain request', async ({ handler, argv, request }) => {
    await expect(runCli(argv)).resolves.toBe(0);

    expect(handlers[handler]).toHaveBeenCalledOnce();
    expect(handlers[handler]).toHaveBeenCalledWith(expect.objectContaining({ request, stdout: [], stderr: [] }));
  });

  it.each([
    {
      argv: ['signing-key', 'generate', '--backend', 'software', '--label', 'primary'],
      request: { action: 'generate', label: 'primary', storage: undefined },
    },
    {
      argv: [
        'signing-key', 'import', '--backend', 'software', '--file', 'key.json',
        '--storage', 'encrypted-file', '--label', 'imported',
      ],
      request: { action: 'import', file: 'key.json', label: 'imported', storage: 'encrypted-file' },
    },
  ])('routes software provisioning through runKeyCommand: $argv', async ({ argv, request }) => {
    await expect(runCli(argv)).resolves.toBe(0);
    expect(handlers.key).toHaveBeenCalledOnce();
    expect(handlers.key).toHaveBeenCalledWith(expect.objectContaining({ request }));
  });

  it('assembles one generate, import, and location-forget command', async () => {
    await expect(runCli(['signing-key', '--help'])).resolves.toBe(0);
    const signingHelp = stdoutWrite.mock.calls.map(([text]) => String(text)).join('\n');
    expect(signingHelp.match(/^\s+generate\b/gm)).toHaveLength(1);
    expect(signingHelp.match(/^\s+import\b/gm)).toHaveLength(1);

    stdoutWrite.mockClear();
    await expect(runCli(['signing-key', 'locations', '--help'])).resolves.toBe(0);
    const locationsHelp = stdoutWrite.mock.calls.map(([text]) => String(text)).join('\n');
    expect(locationsHelp.match(/^\s+forget\b/gm)).toHaveLength(1);
  });

  it.each([
    ['signing-key', 'generate'],
    ['signing-key', 'generate', '--backend', 'unknown'],
    ['signing-key', 'generate', '--backend', 'software', '--device', '123'],
    ['signing-key', 'generate', '--backend', 'yubikey-piv', '--storage', 'encrypted-file', '--device', '123'],
    ['signing-key', 'adopt', '--backend', 'software'],
    ['identity-root', 'generate', '--backend', 'software', '--device', '123'],
  ])('rejects invalid backend/option combinations before mutation: %j', async (...argv) => {
    await expect(runCli(argv)).resolves.toBe(2);
    expect(handlers.key).not.toHaveBeenCalled();
  });

  it.each([
    { argv: ['network', 'add', '--help'], usage: 'Usage: ccd-config-manager network add', option: '--grpc-host <host>' },
    { argv: ['account', 'credentials', 'refresh', '--help'], usage: 'Usage: ccd-config-manager account credentials refresh', option: '--address <address>' },
    { argv: ['service', 'chain-client', 'startup-refresh', 'set', '--help'], usage: 'Usage: ccd-config-manager service chain-client startup-refresh set', option: '--max-age <duration>' },
    { argv: ['contract-instance', 'label', 'set', '--help'], usage: 'Usage: ccd-config-manager contract-instance label set', option: '--address <address>' },
    { argv: ['signing-key', 'import', '--backend', 'software', '--help'], usage: 'Usage: ccd-config-manager signing-key import', option: '--file <path>' },
    { argv: ['storage', 'init', '--help'], usage: 'Usage: ccd-config-manager storage init', option: '--storage <storage>' },
  ])('lets Commander render help for $usage without dispatching', async ({ argv, usage, option }) => {
    await expect(runCli(argv)).resolves.toBe(0);

    expect(stdoutWrite).toHaveBeenCalledWith(expect.stringContaining(usage));
    expect(stdoutWrite).toHaveBeenCalledWith(expect.stringContaining(option));
    expect(stderrWrite).not.toHaveBeenCalled();
    for (const handler of Object.values(handlers)) expect(handler).not.toHaveBeenCalled();
  });

  it.each([
    ['missing required option', ['network', 'inspect']],
    ['unknown option', ['paths', '--bogus']],
    ['extra operand', ['network', 'list', 'extra']],
  ])('does not call a domain handler for %s', async (_label, argv) => {
    await expect(runCli(argv)).resolves.toBe(2);
    for (const handler of Object.values(handlers)) expect(handler).not.toHaveBeenCalled();
  });

  it('rejects an unknown command without dispatching', async () => {
    await expect(runCli(['unknown-command', 'list'])).resolves.toBe(2);
    expect(stderrWrite).toHaveBeenCalledWith(expect.stringContaining("unknown command 'unknown-command'"));
    for (const handler of Object.values(handlers)) expect(handler).not.toHaveBeenCalled();
  });

  it('awaits the domain handler before completing', async () => {
    let resolvePending!: (value: number) => void;
    const pending = new Promise<number>((resolve) => { resolvePending = resolve; });
    handlers.network.mockReturnValueOnce(pending);
    let completed = false;
    const result = runCli(['network', 'list']).then((code) => { completed = true; return code; });

    try {
      await vi.waitFor(() => expect(handlers.network).toHaveBeenCalledOnce());
      expect(completed).toBe(false);
    } finally {
      resolvePending(0);
    }
    await expect(result).resolves.toBe(0);
  });

  it('forwards buffered domain output and preserves a nonzero exit code', async () => {
    handlers.paths.mockImplementationOnce(({ stdout, stderr }) => {
      stdout.push('configured path');
      stderr.push('path warning');
      return Promise.resolve(2);
    });

    await expect(runCli(['paths'])).resolves.toBe(2);
    expect(stdoutWrite).toHaveBeenCalledWith('configured path\n');
    expect(stderrWrite).toHaveBeenCalledWith('path warning\n');
  });

  it('renders rejected handlers to stderr and returns one', async () => {
    handlers.network.mockRejectedValueOnce(new Error('route failed'));

    await expect(runCli(['network', 'list'])).resolves.toBe(1);
    expect(stderrWrite).toHaveBeenCalledWith(expect.stringContaining('route failed'));
  });
});
