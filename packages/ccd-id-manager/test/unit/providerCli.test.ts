import { describe,expect,it,vi } from 'vitest';
import { runCli } from '../../src/cli/index.js';
import { IdentityProviderError } from '../../src/core/providers/error.js';
import type { IdentityProviderService } from '../../src/core/providers/types.js';
import { NETWORK } from '../providerHelpers.js';

const projection = {
  network: NETWORK.caip2,
  providers: [{ index: 0, name: 'Zero ID', label: 'primary', enabled: true }],
};
const detail = {
  index: 0,
  name: 'Zero ID',
  label: 'primary',
  enabled: true,
  issuanceUrl: 'https://idp.example/issue',
  recoveryUrl: 'https://idp.example/recover',
  issuanceMethod: 'GET' as const,
};

function fixture() {
  const providerService = {
    inventory: vi.fn(async () => projection),
    refresh: vi.fn(async () => projection),
    inspect: vi.fn(async () => detail),
    configure: vi.fn(async () => detail),
    configureIdentityRequestTimeout: vi.fn(async ({ network, seconds }) => ({
      network: network.caip2, identityRequestTimeoutSeconds: seconds,
    })),
    getIdentityRequestTimeoutMs: vi.fn(async () => 86_400_000),
    setEnabled: vi.fn(async () => projection),
    resolve: vi.fn(),
  };
  const resolveProviderNetwork = vi.fn(() => NETWORK);
  const stdout = vi.fn<(text: string) => void>();
  const stderr = vi.fn<(text: string) => void>();
  return {
    providerService,
    resolveProviderNetwork,
    stdout,
    stderr,
    deps: {
      providerService: providerService as unknown as IdentityProviderService,
      resolveProviderNetwork,
      stdout,
      stderr,
    },
    out: () => stdout.mock.calls.flat().join(''),
    err: () => stderr.mock.calls.flat().join(''),
  };
}

function serviceCalls(h: ReturnType<typeof fixture>): number {
  return [
    h.providerService.inventory,
    h.providerService.refresh,
    h.providerService.inspect,
    h.providerService.configure,
    h.providerService.configureIdentityRequestTimeout,
    h.providerService.getIdentityRequestTimeoutMs,
    h.providerService.setEnabled,
    h.providerService.resolve,
  ].reduce((total, mock) => total + mock.mock.calls.length, 0);
}

describe('identity-provider CLI adapter', () => {
  it.each([
    [],
    ['idp', '--help'],
    ['idp', 'discover', '--help'],
    ['idp', 'list', '--help'],
    ['idp', 'inspect', '--help'],
    ['idp', 'configure', '--help'],
    ['idp', 'enable', '--help'],
    ['idp', 'disable', '--help'],
    ['identity', '--help'],
    ['identity', 'discover', '--help'],
    ['identity', 'configure', '--help'],
    ['identity', 'associate', '--help'],
    ['identity', 'label', '--help'],
    ['identity', 'label', 'set', '--help'],
    ['identity', 'label', 'remove', '--help'],
    ['identity', 'request', '--help'],
    ['identity', 'list', '--help'],
    ['account', '--help'],
    ['account', 'discover', '--help'],
    ['account', 'prepare', '--help'],
  ])('renders offline help with inherited network options: %j', async (...args: string[]) => {
    const h = fixture();
    expect(await runCli(args, h.deps)).toBe(0);
    expect(h.out()).toMatch(/Usage:|Commands:|Options:/);
    expect(h.err()).toBe('');
    expect(h.resolveProviderNetwork).not.toHaveBeenCalled();
    expect(serviceCalls(h)).toBe(0);
    expect(h.out()).toContain('--network <network>');
  });

  it.each([
    ['identity', 'discover', '--help'],
    ['identity', 'associate', '--help'],
    ['identity', 'request', '--help'],
    ['identity', 'recover', '--help'],
    ['account', 'discover', '--help'],
  ])('keeps workflow help offline without source, workflow, network, or hardware lookup: %j', async (...args: string[]) => {
    const h = fixture();
    const sourceService = { resolve: vi.fn(), list: vi.fn(), records: vi.fn() };
    const workflow = {
      discoverIdentities: vi.fn(), associateIdentitySource: vi.fn(), request: vi.fn(), recover: vi.fn(),
      discoverAccountCredentials: vi.fn(),
      setOperatorIdentityLabel: vi.fn(), setAgentIdentityLabel: vi.fn(),
    };
    const hardware = { listDevices: vi.fn() };
    expect(await runCli(args, {
      ...h.deps, sourceService: sourceService as never, workflow: workflow as never,
    })).toBe(0);
    expect(h.out()).toContain('Usage:');
    expect(h.err()).toBe('');
    expect(h.resolveProviderNetwork).not.toHaveBeenCalled();
    expect(serviceCalls(h)).toBe(0);
    expect(sourceService.resolve).not.toHaveBeenCalled();
    expect(Object.values(workflow).every(mock => mock.mock.calls.length === 0)).toBe(true);
    expect(hardware.listDevices).not.toHaveBeenCalled();
  });

  it.each(['idp', 'identity', 'account'])('shows network-scoped %s group help for a missing subcommand', async (command) => {
    const h = fixture();
    expect(await runCli([command], h.deps)).toBe(2);
    expect(h.err()).toContain(`Usage: ccd-id-manager ${command}`);
    expect(h.err()).toMatch(/network-scoped/i);
    expect(h.err()).toContain('--network <network>');
    expect(h.err()).not.toContain('Network:');
    expect(h.out()).toBe('');
    expect(h.resolveProviderNetwork).not.toHaveBeenCalled();
  });

  it.each(['idp', 'identity', 'account'])('declares --network once on the %s parent and displays it in leaf help', async (group) => {
    const h = fixture();
    const leaf = group === 'idp' ? 'list' : group === 'identity' ? 'list' : 'reconcile';
    expect(await runCli([group, leaf, '--help'], h.deps)).toBe(0);
    expect(h.out().match(/--network <network>/g)).toHaveLength(1);
  });

  it.each([
    ['--network', 'localnet', 'idp', 'discover'],
    ['idp', 'discover', '--network', 'localnet'],
  ])('accepts the global network option before or after the idp command: %j', async (...args: string[]) => {
    const h = fixture();
    expect(await runCli(args, h.deps)).toBe(0);
    expect(h.resolveProviderNetwork).toHaveBeenCalledExactlyOnceWith('localnet');
    expect(h.providerService.refresh).toHaveBeenCalledExactlyOnceWith({ network: NETWORK });
    expect(JSON.parse(h.out())).toEqual(projection);
    expect(h.err()).toBe(`Network: ${NETWORK.caip2}\n`);
  });

  it('reports a missing required provider selector before resolving services', async () => {
    const h = fixture();
    expect(await runCli(['idp', 'inspect'], h.deps)).toBe(2);
    expect(h.err()).toContain('required option');
    expect(h.err()).toContain('Usage: ccd-id-manager idp inspect');
    expect(h.err()).not.toContain('Network:');
    expect(h.resolveProviderNetwork).not.toHaveBeenCalled();
    expect(serviceCalls(h)).toBe(0);
  });

  it.each(['--issuance', '--recovery'])('does not echo credentials from invalid %s URLs', async (flag) => {
    const h = fixture();
    expect(await runCli([
      'idp', 'configure', '--idp', '0', flag, 'https://alice:private@example.com',
    ], h.deps)).toBe(2);
    expect(h.err()).toContain('invalid');
    expect(h.err()).not.toMatch(/alice|private/);
    expect(h.resolveProviderNetwork).not.toHaveBeenCalled();
  });

  it.each([
    [['idp', 'list'], 'inventory', { network: NETWORK }],
    [['idp', 'inspect', '--idp', 'primary'], 'inspect', { network: NETWORK, selector: 'primary' }],
    [['idp', 'enable', '--idp', '0'], 'setEnabled', { network: NETWORK, selector: 0, enabled: true }],
    [['idp', 'disable', '--idp', 'primary'], 'setEnabled', { network: NETWORK, selector: 'primary', enabled: false }],
  ] as const)('resolves once, routes %j canonically, and preserves JSON stdout', async (args, method, input) => {
    const h = fixture();
    expect(await runCli([...args], h.deps)).toBe(0);
    expect(h.resolveProviderNetwork).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(h.providerService[method]).toHaveBeenCalledExactlyOnceWith(input);
    expect(JSON.parse(h.out())).toBeTruthy();
    expect(h.err()).toBe(`Network: ${NETWORK.caip2}\n`);
  });

  it('passes only the endpoint and label configuration fields, including explicit label mode', async () => {
    const h = fixture();
    expect(await runCli([
      'idp', '--network', 'devnet', 'configure', '--idp', 'primary', '--label', 'office', '--mode', 'soft',
      '--issuance', 'https://idp.example/new-issue', '--recovery', 'http://localhost:8000/recover',
    ], h.deps)).toBe(0);
    expect(h.resolveProviderNetwork).toHaveBeenCalledExactlyOnceWith('devnet');
    expect(h.providerService.configure).toHaveBeenCalledExactlyOnceWith({
      network: NETWORK,
      selector: 'primary',
      patch: {
        label: 'office',
        mode: 'soft',
        issuanceUrl: 'https://idp.example/new-issue',
        recoveryUrl: 'http://localhost:8000/recover',
      },
    });
    expect(JSON.parse(h.out())).toEqual(detail);
    expect(h.err()).toBe(`Network: ${NETWORK.caip2}\n`);
  });

  it('parses AR identity CSV and threshold as provider patch fields', async () => {
    const h = fixture();
    expect(await runCli([
      'idp', 'configure', '--idp', 'primary', '--ars', '3,1', '--ar-threshold', '2',
    ], h.deps)).toBe(0);
    expect(h.providerService.configure).toHaveBeenCalledExactlyOnceWith({
      network: NETWORK,
      selector: 'primary',
      patch: { anonymityRevokers: [3, 1], anonymityRevokerThreshold: 2 },
    });
  });

  it.each([
    [['--clear-ars'], { anonymityRevokers: null }],
    [['--clear-ar-threshold'], { anonymityRevokerThreshold: null }],
    [['--clear-ars', '--ar-threshold', '1'], { anonymityRevokers: null, anonymityRevokerThreshold: 1 }],
  ] as const)('maps AR clear options to public null deletion patches: %j', async (options, patch) => {
    const h = fixture();
    expect(await runCli(['idp', 'configure', '--idp', '0', ...options], h.deps)).toBe(0);
    expect(h.providerService.configure).toHaveBeenCalledExactlyOnceWith({ network: NETWORK, selector: 0, patch });
  });

  it.each([
    ['list set and clear', ['--ars', '1,2', '--clear-ars']],
    ['threshold set and clear', ['--ar-threshold', '1', '--clear-ar-threshold']],
    ['empty AR CSV', ['--ars', '']],
    ['duplicate AR IDs', ['--ars', '1,1']],
    ['zero AR ID', ['--ars', '0,1']],
    ['oversized AR ID', ['--ars', '4294967296']],
    ['fractional threshold', ['--ar-threshold', '1.5']],
    ['zero threshold', ['--ar-threshold', '0']],
    ['threshold above byte range', ['--ar-threshold', '256']],
  ])('rejects invalid AR options before network or service effects: %s', async (_case, options) => {
    const h = fixture();
    expect(await runCli(['idp', 'configure', '--idp', '0', ...options], h.deps)).toBe(2);
    expect(h.resolveProviderNetwork).not.toHaveBeenCalled();
    expect(h.providerService.configure).not.toHaveBeenCalled();
  });

  it.each([
    [['--issuance-method', 'post'], { issuanceMethod: 'POST' }],
    [['--issuance-method', 'get'], { issuanceMethod: 'GET' }],
  ] as const)('normalizes issuance transport options: %j', async (options, patch) => {
    const h = fixture();
    expect(await runCli(['idp', 'configure', '--idp', '0', ...options], h.deps)).toBe(0);
    expect(h.providerService.configure).toHaveBeenCalledExactlyOnceWith({
      network: NETWORK, selector: 0, patch,
    });
  });

  it.each([
    ['removed body option', ['--issuance-body', 'network=devnet']],
    ['removed clear-body option', ['--clear-issuance-body']],
    ['invalid method', ['--issuance-method', 'PUT']],
  ])('rejects invalid issuance %s before dependency effects', async (_name, options) => {
    const h = fixture();
    expect(await runCli(['idp', 'configure', '--idp', '0', ...options], h.deps)).toBe(2);
    expect(h.resolveProviderNetwork).not.toHaveBeenCalled();
    expect(h.providerService.configure).not.toHaveBeenCalled();
  });

  it('configures the canonical network request timeout from positive fractional hours', async () => {
    const h = fixture();
    expect(await runCli([
      'identity', '--network', 'devnet', 'configure', '--request-timeout-hours', '0.5',
    ], h.deps)).toBe(0);
    expect(h.providerService.configureIdentityRequestTimeout).toHaveBeenCalledExactlyOnceWith({
      network: NETWORK, seconds: 1_800,
    });
    expect(JSON.parse(h.out())).toEqual({
      network: NETWORK.caip2, identityRequestTimeoutSeconds: 1_800,
    });
    expect(h.err()).toBe(`Network: ${NETWORK.caip2}\n`);
  });

  it.each(['0', '-1', 'NaN', 'Infinity', '0.0001', '999999999999999']) (
    'rejects invalid request timeout hours %s before network or provider effects', async (hours) => {
      const h = fixture();
      expect(await runCli([
        'identity', 'configure', '--request-timeout-hours', hours,
      ], h.deps)).toBe(2);
      expect(h.resolveProviderNetwork).not.toHaveBeenCalled();
      expect(h.providerService.configureIdentityRequestTimeout).not.toHaveBeenCalled();
      expect(h.err()).not.toContain('Network:');
    },
  );

  it('requires request timeout hours without resolving the network', async () => {
    const h = fixture();
    expect(await runCli(['identity', 'configure'], h.deps)).toBe(2);
    expect(h.err()).toContain('required option');
    expect(h.resolveProviderNetwork).not.toHaveBeenCalled();
    expect(h.providerService.configureIdentityRequestTimeout).not.toHaveBeenCalled();
  });

  it.each([
    ['empty configure patch', ['idp', 'configure', '--idp', '0']],
    ['bad selector', ['idp', 'enable', '--idp', 'bad value!']],
    ['negative index', ['idp', 'enable', '--idp', '-1']],
    ['bad label', ['idp', 'configure', '--idp', '0', '--label', '123']],
    ['bad mode', ['idp', 'configure', '--idp', '0', '--label', 'valid', '--mode', 'agent']],
    ['missing global network value', ['--network']],
  ])('rejects %s before dependency effects', async (_label, args) => {
    const h = fixture();
    expect(await runCli(args, h.deps)).toBe(2);
    expect(h.resolveProviderNetwork).not.toHaveBeenCalled();
    expect(serviceCalls(h)).toBe(0);
    expect(h.out()).toBe('');
    expect(h.err()).not.toBe('');
    if (_label === 'missing global network value') {
      expect(h.err()).toContain("option '--network <network>' argument missing");
    }
    expect(h.err()).not.toContain('Network:');
  });

  it.each([
    new IdentityProviderError('PROVIDER_NOT_FOUND'),
    new Error('secret=deadbeef /protected/idps.json'),
  ])(
    'prints canonical context before sanitized provider/runtime failures',
    async (failure) => {
      const h = fixture();
      h.providerService.inspect.mockRejectedValue(failure);
      expect(await runCli(['idp', 'inspect', '--idp', 'missing'], h.deps)).toBe(1);
      expect(h.out()).toBe('');
      expect(h.err()).toContain(`Network: ${NETWORK.caip2}\n`);
      expect(h.err()).not.toMatch(/deadbeef|protected\/idps\.json/);
      expect(h.resolveProviderNetwork).toHaveBeenCalledOnce();
    },
  );

  it('sanitizes network-resolution failure before any provider effect', async () => {
    const h = fixture();
    h.resolveProviderNetwork.mockImplementation(() => {
      throw Object.assign(new IdentityProviderError('INVALID_NETWORK'), { detail: '/private/network.json secret' });
    });
    expect(await runCli(['idp', '--network', '../../private', 'list'], h.deps)).toBe(1);
    expect(h.err()).toContain('selected network is invalid');
    expect(h.err()).not.toMatch(/private|secret/i);
    expect(h.err()).not.toContain('Network:');
    expect(serviceCalls(h)).toBe(0);
  });
});
