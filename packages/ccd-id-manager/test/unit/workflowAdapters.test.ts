import { describe,expect,it,vi } from 'vitest';
import { runCli } from '../../src/cli/index.js';
import type { IdentitySourceService } from '../../src/core/sources/types.js';
import type { CredentialDiscoveryResult,IdentityDiscoveryResult,IdentityRequestResult,IdentitySummary,IdentityWorkflow } from '../../src/core/workflowTypes.js';
import { identityProviderServiceFixture,TEST_CANONICAL_NETWORK } from '../helpers.js';
import {
identityWorkflowFixture
} from '../mcpTestHelpers.js';

const adapterMocks = vi.hoisted(() => ({
  createDefaultIdentityWorkflow: vi.fn(), createDefaultIdentityProviderService: vi.fn(),
  createDefaultIdentitySourceService: vi.fn(),
}));
vi.mock('../../src/core/workflowInfrastructure.js', () => ({
  createDefaultIdentityWorkflow: adapterMocks.createDefaultIdentityWorkflow,
}));
vi.mock('../../src/core/providers/serviceFactory.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/core/providers/serviceFactory.js')>(),
  resolveProviderNetwork: vi.fn(() => TEST_CANONICAL_NETWORK),
  createDefaultIdentityProviderService: adapterMocks.createDefaultIdentityProviderService,
}));
vi.mock('../../src/core/sources/runtime.js', () => ({
  createDefaultIdentitySourceService: adapterMocks.createDefaultIdentitySourceService,
}));

const ID = '35'.repeat(32);
const SOURCE_ID = 'ir:2abcdefghijklmn';
const PUBLIC_KEY = '22'.repeat(32);
const summary: IdentitySummary = {
  identityId: ID, network: 'testnet', identityProviderIndex: 4,
  identityIndex: 7, status: 'pending',
};
const labeledSummary: IdentitySummary = { ...summary, label: 'Ted' };
const requestSummary: IdentityRequestResult = { ...summary, status: 'pending', outcome: 'requested' };
const identityDiscovery: IdentityDiscoveryResult = {
  network: TEST_CANONICAL_NETWORK.caip2, sourceId: SOURCE_ID, gapLimit: 3,
  streams: [{ identityProviderIndex: 4, used: [0], reserved: [2], unused: [1],
    scannedRange: { start: 0, end: 3 }, nextIndex: 4, partial: false, stopReason: 'gap' }],
};
const credentialDiscovery: CredentialDiscoveryResult = {
  network: TEST_CANONICAL_NETWORK.caip2, identityId: ID, gapLimit: 3,
  sourceBlock: { hash: 'aa'.repeat(32), height: '7', time: '2026-10-16T00:00:00.000Z' },
  stream: { used: [0], reserved: [], unused: [1, 2, 3], scannedRange: { start: 0, end: 3 },
    nextIndex: 4, partial: false, stopReason: 'gap' },
};

type AdapterWorkflow = IdentityWorkflow & {
  discoverIdentities: ReturnType<typeof vi.fn>;
  associateIdentitySource: ReturnType<typeof vi.fn>;
  discoverAccountCredentials: ReturnType<typeof vi.fn>;
};

function workflowFixture(): AdapterWorkflow {
  return identityWorkflowFixture({
    request: vi.fn(async () => requestSummary), recover: vi.fn(async () => ({ ...summary, status: 'issued' as const })),
    status: vi.fn(async () => summary), list: vi.fn(async () => [summary]),
    prepareAccount: vi.fn(async () => ({ network: 'testnet', credDeploymentHex: 'aabb', accountAddress: 'account', credentialNumber: 3, expirySeconds: 900 })),
    reconcileAccountOpening: vi.fn(async () => ({ network: 'testnet', identityId: ID, status: 'pending' as const, credentialNumber: 3 })),
    discoverIdentities: vi.fn(async () => identityDiscovery),
    associateIdentitySource: vi.fn(async () => ({ ...summary, status: 'issued' as const })),
    discoverAccountCredentials: vi.fn(async () => credentialDiscovery),
    setOperatorIdentityLabel: vi.fn(async () => labeledSummary), setAgentIdentityLabel: vi.fn(async () => labeledSummary),
    monitorIdentity: vi.fn(async () => summary),
  }) as AdapterWorkflow;
}

function sourceFixture(): IdentitySourceService {
  return {
    resolve: vi.fn(), records: vi.fn(async () => []),
    list: vi.fn(async () => [{ id: SOURCE_ID, label: 'PrimaryKey', backend: 'future-backend', isDefault: true, availability: 'locked' }]),
  } as unknown as IdentitySourceService;
}

function cliFixture(workflow = workflowFixture()) {
  const stdout = vi.fn<(text: string) => void>();
  const stderr = vi.fn<(text: string) => void>();
  const providerService = identityProviderServiceFixture();
  const resolveProviderNetwork = vi.fn(() => TEST_CANONICAL_NETWORK);
  return { workflow, stdout, stderr, providerService, resolveProviderNetwork, deps: {
    workflow, providerService, resolveProviderNetwork, stdout, stderr,
  } };
}

describe('identity workflow CLI adapter', () => {
  it.each([
    [['identity', 'discover'], 'default: 3'],
    [['account', 'discover'], 'default: 3'],
    [['identity', 'request'], 'default: discover and allocate'],
    [['account', 'prepare'], 'default: discover unused'],
  ])('explains discovery defaults in offline help for %j', async (command, expected) => {
    const h = cliFixture();
    expect(await runCli([...command, '--help'], h.deps)).toBe(0);
    expect(h.stdout.mock.calls.flat().join('').replace(/\s+/g, ' ')).toContain(expected);
    expect(h.resolveProviderNetwork).not.toHaveBeenCalled();
    expect(h.stderr).not.toHaveBeenCalled();
  });

  it('routes issuance with a raw optional source and automatic identity allocation', async () => {
    const h = cliFixture();
    expect(await runCli(['--network', 'testnet', 'identity', 'request', '--source', 'PrimaryKey', '--idp', 'Primary'], h.deps)).toBe(0);
    expect(h.resolveProviderNetwork).toHaveBeenCalledExactlyOnceWith('testnet');
    expect(h.providerService.resolve).toHaveBeenCalledWith({ network: TEST_CANONICAL_NETWORK, selector: 'Primary', requireEnabled: false });
    expect(h.workflow.request).toHaveBeenCalledExactlyOnceWith({
      network: TEST_CANONICAL_NETWORK.caip2, source: 'PrimaryKey', identityProviderIndex: 4,
    });
    expect(h.stderr.mock.calls.flat().join('')).toBe(`Network: ${TEST_CANONICAL_NETWORK.caip2}\n`);
  });

  it('forwards a bare CLI request label', async () => {
    const h = cliFixture();
    expect(await runCli(['identity', 'request', '--idp', '4', '--label', 'ted'], h.deps)).toBe(0);
    expect(h.workflow.request).toHaveBeenCalledWith({
      network: TEST_CANONICAL_NETWORK.caip2, identityProviderIndex: 4, label: 'ted',
    });
  });

  it('routes operator label set with bare selector input and optional mode', async () => {
    const h = cliFixture();
    expect(await runCli([
      'identity', 'label', 'set', '--identity', ' old ', '--label', 'Ted', '--mode', 'soft',
    ], h.deps)).toBe(0);
    expect(h.workflow.setOperatorIdentityLabel).toHaveBeenCalledExactlyOnceWith({
      network: TEST_CANONICAL_NETWORK.caip2, identityId: ' old ', operation: 'set', label: 'Ted', mode: 'soft',
    });
    expect(JSON.parse(h.stdout.mock.calls.flat().join(''))).toMatchObject({ label: 'Ted' });
  });

  it('routes explicit operator removal without label or mode fields', async () => {
    const workflow = workflowFixture();
    vi.mocked(workflow.setOperatorIdentityLabel).mockResolvedValueOnce(summary);
    const h = cliFixture(workflow);
    expect(await runCli(['identity', 'label', 'remove', '--identity', ID], h.deps)).toBe(0);
    expect(h.workflow.setOperatorIdentityLabel).toHaveBeenCalledExactlyOnceWith({
      network: TEST_CANONICAL_NETWORK.caip2, identityId: ID, operation: 'remove',
    });
    expect(JSON.parse(h.stdout.mock.calls.flat().join(''))).not.toHaveProperty('label');
  });

  it('removes the old identity label leaf without retaining a compatibility alias', async () => {
    const h = cliFixture();
    expect(await runCli(['identity', 'label', '--identity', ID, '--label', 'Ted'], h.deps)).toBe(2);
    expect(h.workflow.setOperatorIdentityLabel).not.toHaveBeenCalled();
  });

  it('passes an identity-already-exists request outcome through as successful JSON', async () => {
    const workflow = workflowFixture();
    vi.mocked(workflow.request).mockResolvedValueOnce({
      ...summary, status: 'issued', outcome: 'identity_already_exists',
    } as never);
    const h = cliFixture(workflow);
    expect(await runCli(['identity', 'request', '--idp', '4'], h.deps)).toBe(0);
    expect(JSON.parse(h.stdout.mock.calls.flat().join(''))).toMatchObject({
      outcome: 'identity_already_exists', status: 'issued',
    });
  });

  it('routes explicit request and recovery indexes, while allowing configured source default', async () => {
    const h = cliFixture();
    expect(await runCli(['identity', 'request', '--idp', '4', '--identity-index', '0'], h.deps)).toBe(0);
    expect(h.workflow.request).toHaveBeenCalledWith({ network: TEST_CANONICAL_NETWORK.caip2, identityProviderIndex: 4, identityIndex: 0 });
    expect(await runCli(['identity', 'recover', '--source', SOURCE_ID, '--idp', '4', '--identity-index', '7'], h.deps)).toBe(0);
    expect(h.workflow.recover).toHaveBeenCalledWith({ network: TEST_CANONICAL_NETWORK.caip2, source: SOURCE_ID, identityProviderIndex: 4, identityIndex: 7 });
  });

  it('omits an unspecified recovery source and preserves explicit zero account credentials', async () => {
    const h = cliFixture();
    expect(await runCli(['identity', 'recover', '--idp', '4', '--identity-index', '0'], h.deps)).toBe(0);
    expect(h.workflow.recover).toHaveBeenCalledExactlyOnceWith({
      network: TEST_CANONICAL_NETWORK.caip2, identityProviderIndex: 4, identityIndex: 0,
    });

    expect(await runCli([
      'account', 'prepare', '--identity', ID, '--credential-number', '0',
      '--public-keys', JSON.stringify({ 0: PUBLIC_KEY }), '--credential-threshold', '1', '--expiry-seconds', '900',
    ], h.deps)).toBe(0);
    expect(h.workflow.prepareAccount).toHaveBeenCalledExactlyOnceWith({
      network: TEST_CANONICAL_NETWORK.caip2, identityId: ID, credentialNumber: 0,
      publicKeys: { '0': PUBLIC_KEY }, credentialThreshold: 1, expirySeconds: 900,
    });
  });

  it('leaves credential selection automatic when the CLI number is omitted', async () => {
    const h = cliFixture();
    expect(await runCli([
      'account', 'prepare', '--identity', ID, '--public-keys', JSON.stringify({ 0: PUBLIC_KEY }),
      '--credential-threshold', '1', '--expiry-seconds', '900',
    ], h.deps)).toBe(0);
    expect(h.workflow.prepareAccount).toHaveBeenCalledExactlyOnceWith({
      network: TEST_CANONICAL_NETWORK.caip2, identityId: ID, publicKeys: { '0': PUBLIC_KEY }, credentialThreshold: 1, expirySeconds: 900,
    });
  });

  it('forwards per-account disclosure selectors and warns in command help', async () => {
    const h = cliFixture();
    expect(await runCli([
      'account', 'prepare', '--identity', ID, '--public-keys', JSON.stringify({ 0: PUBLIC_KEY }),
      '--credential-threshold', '1', '--expiry-seconds', '900',
      '--reveal-attribute', 'lastName', 'firstName',
    ], h.deps)).toBe(0);
    expect(h.workflow.prepareAccount).toHaveBeenCalledExactlyOnceWith({
      network: TEST_CANONICAL_NETWORK.caip2,
      identityId: ID,
      publicKeys: { '0': PUBLIC_KEY }, credentialThreshold: 1,
      expirySeconds: 900,
      revealAttributes: ['lastName', 'firstName'],
    });

    const help = cliFixture();
    expect(await runCli(['account', 'prepare', '--help'], help.deps)).toBe(0);
    expect(help.stdout.mock.calls.flat().join('').replace(/\s+/g, ' ')).toMatch(/reveal-attribute.*public on-chain/i);
  });

  it('does not retain the legacy singular public-key CLI option', async () => {
    const h = cliFixture();
    expect(await runCli([
      'account', 'prepare', '--identity', ID, '--public-key', PUBLIC_KEY, '--expiry-seconds', '900',
    ], h.deps)).toBe(2);
    expect(h.workflow.prepareAccount).not.toHaveBeenCalled();
  });

  it.each([
    ['public keys that are not an indexed JSON object', [
      '--public-keys', '[]', '--credential-threshold', '1', '--expiry-seconds', '900',
    ]],
    ['an unsafe credential number', [
      '--credential-number', '9007199254740992', '--public-keys', JSON.stringify({ 0: PUBLIC_KEY }),
      '--credential-threshold', '1', '--expiry-seconds', '900',
    ]],
  ])('rejects %s before invoking the workflow', async (_description, options) => {
    const h = cliFixture();
    expect(await runCli([
      'account', 'prepare', '--identity', ID, ...options,
    ], h.deps)).toBe(2);
    expect(h.workflow.prepareAccount).not.toHaveBeenCalled();
  });

  it('routes account reconciliation in canonical network scope', async () => {
    const h = cliFixture();
    expect(await runCli(['account', 'reconcile', '--identity', ID, '--network', 'testnet'], h.deps)).toBe(0);
    expect(h.resolveProviderNetwork).toHaveBeenCalledExactlyOnceWith('testnet');
    expect(h.workflow.reconcileAccountOpening).toHaveBeenCalledExactlyOnceWith({
      network: TEST_CANONICAL_NETWORK.caip2, identityId: ID,
    });
    expect(h.stderr.mock.calls.flat().join('')).toBe(`Network: ${TEST_CANONICAL_NETWORK.caip2}\n`);
  });

  it.each([
    [[], { network: TEST_CANONICAL_NETWORK.caip2, identityId: ID }],
    [['--callback-url', 'ccd-id-manager://identity/callback'], {
      network: TEST_CANONICAL_NETWORK.caip2,
      identityId: ID,
      callbackUrl: 'ccd-id-manager://identity/callback',
    }],
  ] as const)('routes identity status options and preserves its JSON result: %j', async (options, expected) => {
    const h = cliFixture();
    expect(await runCli(['identity', 'status', '--network', 'testnet', '--identity', ID, ...options], h.deps)).toBe(0);
    expect(h.resolveProviderNetwork).toHaveBeenCalledExactlyOnceWith('testnet');
    expect(h.workflow.status).toHaveBeenCalledExactlyOnceWith(expected);
    expect(JSON.parse(h.stdout.mock.calls.flat().join(''))).toEqual(summary);
  });

  it.each([
    ['identity', 'request', '--source', 'PrimaryKey'],
    ['identity', 'recover', '--idp', '4'],
  ])('rejects missing required selectors before network or service effects: %j', async (...args: string[]) => {
    const h = cliFixture();
    expect(await runCli(args, h.deps)).toBe(2);
    expect(h.resolveProviderNetwork).not.toHaveBeenCalled();
    expect(h.providerService.resolve).not.toHaveBeenCalled();
    expect(h.workflow.request).not.toHaveBeenCalled();
    expect(h.workflow.recover).not.toHaveBeenCalled();
  });

  it.each([
    [[], { network: TEST_CANONICAL_NETWORK.caip2 }],
    [['--source', 'PrimaryKey', '--gap-limit', '5', '--start-index', '0', '--end-index', '7'], {
      network: TEST_CANONICAL_NETWORK.caip2, source: 'PrimaryKey', gapLimit: 5, startIndex: 0, endIndex: 7,
    }],
    [['--start-index', '9'], {
      network: TEST_CANONICAL_NETWORK.caip2, startIndex: 9,
    }],
  ] as const)('discovers identities across enabled providers when no IDP is selected: %j', async (options, expected) => {
    const h = cliFixture();
    expect(await runCli(['identity', 'discover', ...options], h.deps)).toBe(0);
    expect(h.providerService.resolve).not.toHaveBeenCalled();
    expect(h.workflow.discoverIdentities).toHaveBeenCalledExactlyOnceWith(expected);
    expect(JSON.parse(h.stdout.mock.calls.flat().join(''))).toEqual(identityDiscovery);
  });

  it('requires an explicitly filtered discovery provider to be enabled', async () => {
    const h = cliFixture();
    expect(await runCli(['identity', 'discover', '--idp', 'Primary'], h.deps)).toBe(0);
    expect(h.providerService.resolve).toHaveBeenCalledExactlyOnceWith({
      network: TEST_CANONICAL_NETWORK, selector: 'Primary', requireEnabled: true,
    });
    expect(h.workflow.discoverIdentities).toHaveBeenCalledWith({
      network: TEST_CANONICAL_NETWORK.caip2, identityProviderIndex: 4,
    });
  });

  it('routes CLI-only source association without resolving the source in the adapter', async () => {
    const h = cliFixture();
    expect(await runCli(['identity', 'associate', '--identity', ID, '--source', 'PrimaryKey'], h.deps)).toBe(0);
    expect(h.workflow.associateIdentitySource).toHaveBeenCalledExactlyOnceWith({
      network: TEST_CANONICAL_NETWORK.caip2, identityId: ID, source: 'PrimaryKey',
    });
  });

  it('prints canonical network context before every new workflow invocation', async () => {
    const h = cliFixture();
    await runCli(['identity', 'discover'], h.deps);
    await runCli(['identity', 'associate', '--identity', ID], h.deps);
    await runCli(['account', 'discover', '--identity', ID], h.deps);
    const contextCalls = h.stderr.mock.invocationCallOrder;
    expect(contextCalls).toHaveLength(3);
    expect(contextCalls[0]).toBeLessThan(vi.mocked(h.workflow.discoverIdentities).mock.invocationCallOrder[0]!);
    expect(contextCalls[1]).toBeLessThan(vi.mocked(h.workflow.associateIdentitySource).mock.invocationCallOrder[0]!);
    expect(contextCalls[2]).toBeLessThan(vi.mocked(h.workflow.discoverAccountCredentials).mock.invocationCallOrder[0]!);
    expect(h.stderr.mock.calls.flat().join('')).toBe(`Network: ${TEST_CANONICAL_NETWORK.caip2}\n`.repeat(3));
  });

  it.each([
    [[], { network: TEST_CANONICAL_NETWORK.caip2, identityId: ID }],
    [['--gap-limit', '2', '--start-credential-number', '0', '--end-credential-number', '4'], {
      network: TEST_CANONICAL_NETWORK.caip2, identityId: ID, gapLimit: 2,
      startCredentialNumber: 0, endCredentialNumber: 4,
    }],
    [['--start-credential-number', '3'], {
      network: TEST_CANONICAL_NETWORK.caip2, identityId: ID, startCredentialNumber: 3,
    }],
    [['--full'], { network: TEST_CANONICAL_NETWORK.caip2, identityId: ID, full: true }],
  ] as const)('routes account credential discovery options: %j', async (options, expected) => {
    const h = cliFixture();
    expect(await runCli(['account', 'discover', '--identity', ID, ...options], h.deps)).toBe(0);
    expect(h.workflow.discoverAccountCredentials).toHaveBeenCalledExactlyOnceWith(expected);
    expect(JSON.parse(h.stdout.mock.calls.flat().join(''))).toEqual(credentialDiscovery);
  });

  it.each([
    ['identity', 'discover', '--gap-limit', '0'],
    ['identity', 'discover', '--gap-limit', 'x'],
    ['identity', 'discover', '--gap-limit'],
    ['identity', 'discover', '--source', '2abcdefghijklmn'],
    ['identity', 'discover', '--source', 'ir:2abcdefghijklm'],
    ['identity', 'discover', '--source', 'name with spaces'],
    ['identity', 'discover', '--end-index', '2147483648'],
    ['identity', 'discover', '--start-index', '8', '--end-index', '7'],
    ['identity', 'discover', '--full'],
    ['identity', 'associate'],
    ['identity', 'label', 'set', '--identity', ID, '--label', '@'],
    ['identity', 'label', 'set', '--identity', ID, '--label', '1ted'],
    ['identity', 'label', 'set', '--identity', ID],
    ['identity', 'label', 'remove', '--identity', ID, '--mode', 'soft'],
    ['identity', 'label', 'remove', '--identity', ID, '--label', 'ted'],
    ['identity', 'request', '--idp', '4', '--label', '@@ted'],
    ['identity', 'request', '--idp', '4', '--mode', 'soft'],
    ['account', 'discover'],
    ['account', 'discover', '--identity', ID, '--end-credential-number', '256'],
    ['account', 'discover', '--identity', ID, '--start-credential-number', '2', '--end-credential-number', '1'],
    ['account', 'discover', '--identity', ID, '--full', '--start-credential-number', '0'],
    ['account', 'discover', '--identity', ID, '--full', '--end-credential-number', '1'],
  ])('rejects invalid discovery syntax before network or workflow effects: %j', async (...args: string[]) => {
    const h = cliFixture();
    expect(await runCli(args, h.deps)).toBe(2);
    expect(h.resolveProviderNetwork).not.toHaveBeenCalled();
    expect(h.workflow.discoverIdentities).not.toHaveBeenCalled();
    expect(h.workflow.discoverAccountCredentials).not.toHaveBeenCalled();
  });

  it('lazily constructs the default workflow only for a runtime operation', async () => {
    const workflow = workflowFixture();
    adapterMocks.createDefaultIdentityWorkflow.mockReset().mockReturnValue(workflow);
    const providers = identityProviderServiceFixture();
    const sources = sourceFixture();
    adapterMocks.createDefaultIdentityProviderService.mockReturnValue(providers);
    adapterMocks.createDefaultIdentitySourceService.mockReturnValue(sources);
    expect(await runCli(['identity', 'list'], { stdout: vi.fn(), stderr: vi.fn() })).toBe(0);
    expect(adapterMocks.createDefaultIdentitySourceService).toHaveBeenCalledOnce();
    expect(adapterMocks.createDefaultIdentityWorkflow).toHaveBeenCalledWith({
      providerPolicy: 'cli', providers, sources,
    });
  });
});
