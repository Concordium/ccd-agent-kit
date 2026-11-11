import { beforeEach, describe, expect, it, vi } from 'vitest';

import { IdentityProviderError } from '../../src/core/providers/error.js';
import type { IdentitySourceService } from '../../src/core/sources/types.js';
import type { IdentitySummary, IdentityWorkflow } from '../../src/core/workflowTypes.js';
import { identityProviderServiceFixture, TEST_CANONICAL_NETWORK } from '../helpers.js';
import { identityWorkflowFixture } from '../mcpTestHelpers.js';
import { captureIdentityMcpAdapter, tool, toolPayload, toolText } from './mcpAdapterHarness.js';

const networkMocks = vi.hoisted(() => ({ resolve: vi.fn(() => TEST_CANONICAL_NETWORK) }));
vi.mock('../../src/core/providers/serviceFactory.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/core/providers/serviceFactory.js')>(),
  resolveProviderNetwork: networkMocks.resolve,
}));

const ID = '35'.repeat(32);
const SOURCE_ID = 'ir:2abcdefghijklmn';
const PUBLIC_KEY = '22'.repeat(32);
const summary: IdentitySummary = {
  identityId: ID,
  network: TEST_CANONICAL_NETWORK.caip2,
  identityProviderIndex: 4,
  identityIndex: 7,
  status: 'issued',
  label: 'Agent',
};

function sources(): IdentitySourceService {
  return {
    resolve: vi.fn(), list: vi.fn(async () => []), records: vi.fn(async () => []),
    inspect: vi.fn(), createAgreement: vi.fn(), refresh: vi.fn(async () => undefined),
  };
}

function workflowFixture(): IdentityWorkflow {
  return identityWorkflowFixture({
    request: vi.fn<IdentityWorkflow['request']>(async () => ({ ...summary, status: 'pending', outcome: 'requested' })),
    recover: vi.fn<IdentityWorkflow['recover']>(async () => summary),
    list: vi.fn<IdentityWorkflow['list']>(async () => [summary]),
    prepareAccount: vi.fn<IdentityWorkflow['prepareAccount']>(async () => ({
      network: TEST_CANONICAL_NETWORK.caip2, credDeploymentHex: 'aabb', accountAddress: 'account',
      credentialNumber: 0, expirySeconds: 900,
    })),
    reconcileAccountOpening: vi.fn<IdentityWorkflow['reconcileAccountOpening']>(async () => ({
      network: TEST_CANONICAL_NETWORK.caip2, identityId: ID, status: 'pending', credentialNumber: 0,
    })),
    discoverIdentities: vi.fn<IdentityWorkflow['discoverIdentities']>(async () => ({
      network: TEST_CANONICAL_NETWORK.caip2, sourceId: SOURCE_ID, gapLimit: 3, streams: [],
    })),
    discoverAccountCredentials: vi.fn<IdentityWorkflow['discoverAccountCredentials']>(async () => ({
      network: TEST_CANONICAL_NETWORK.caip2, identityId: ID, gapLimit: 3,
      stream: { used: [], reserved: [], unused: [0], scannedRange: { start: 0 }, partial: false, stopReason: 'gap' },
    })),
    setAgentIdentityLabel: vi.fn<IdentityWorkflow['setAgentIdentityLabel']>(async () => summary),
  });
}

async function capture(workflow = workflowFixture(), providers = identityProviderServiceFixture()) {
  await captureIdentityMcpAdapter({ workflow, sources: sources(), providers });
  return { workflow, providers };
}

describe('workflow MCP adapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    networkMocks.resolve.mockReturnValue(TEST_CANONICAL_NETWORK);
  });

  it.each([
    [{ identityProvider: 'Primary', identityIndex: 0 }, {
      network: TEST_CANONICAL_NETWORK.caip2, identityProviderIndex: 4, identityIndex: 0,
    }],
    [{ network: 'testnet', source: SOURCE_ID, identityProvider: 4, identityIndex: 7 }, {
      network: TEST_CANONICAL_NETWORK.caip2, source: SOURCE_ID, identityProviderIndex: 4, identityIndex: 7,
    }],
  ])('resolves and routes recovery input %j', async (input, expected) => {
    const { workflow, providers } = await capture();

    const response = await tool('recover_identity')(input);

    expect(providers.resolve).toHaveBeenCalledExactlyOnceWith({
      network: TEST_CANONICAL_NETWORK, selector: input.identityProvider, requireEnabled: true,
    });
    expect(workflow.recover).toHaveBeenCalledExactlyOnceWith(expected);
    expect(toolPayload(response)).toEqual(summary);
  });

  it.each([
    [new IdentityProviderError('PROVIDER_NOT_FOUND'), /not found/i],
    [new Error('secret /Users/alice/private-state'), /workflow operation failed/i],
  ])('returns a safe recovery error when provider resolution fails', async (error, visible) => {
    const providers = identityProviderServiceFixture({ resolve: vi.fn(async () => { throw error; }) });
    const { workflow } = await capture(workflowFixture(), providers);

    const response = await tool('recover_identity')({ identityProvider: 4, identityIndex: 7 });

    expect(response.isError).toBe(true);
    expect(toolText(response)).toMatch(visible);
    expect(toolText(response)).not.toMatch(/Users\/alice|private-state|secret/);
    expect(workflow.recover).not.toHaveBeenCalled();
  });

  it.each([
    ['request_identity', {
      source: SOURCE_ID, identityProvider: 4, identityIndex: 0, label: 'agent',
    }, 'request', {
      network: TEST_CANONICAL_NETWORK.caip2, source: SOURCE_ID, identityProviderIndex: 4,
      identityIndex: 0, label: 'agent', mode: 'soft',
    }],
    ['prepare_account_opening', {
      identityId: ID, publicKeys: { '0': PUBLIC_KEY }, credentialThreshold: 1, expirySeconds: 900,
      credentialNumber: 0, revealAttributes: ['firstName'],
    }, 'prepareAccount', {
      identityId: ID, publicKeys: { '0': PUBLIC_KEY }, credentialThreshold: 1, expirySeconds: 900,
      credentialNumber: 0, revealAttributes: ['firstName'],
    }],
    ['reconcile_account_opening', { identityId: ID }, 'reconcileAccountOpening', { identityId: ID }],
    ['discover_account_credentials', {
      identityId: ID, gapLimit: 2, startCredentialNumber: 0, endCredentialNumber: 3,
    }, 'discoverAccountCredentials', {
      identityId: ID, gapLimit: 2, startCredentialNumber: 0, endCredentialNumber: 3,
    }],
    ['discover_account_credentials', { identityId: ID, full: true }, 'discoverAccountCredentials', {
      identityId: ID, full: true,
    }],
    ['label_identity', { identityId: ID, label: 'next' }, 'setAgentIdentityLabel', {
      network: TEST_CANONICAL_NETWORK.caip2, identityId: ID, operation: 'set', label: 'next',
    }],
    ['label_identity', { identityId: ID, remove: true }, 'setAgentIdentityLabel', {
      network: TEST_CANONICAL_NETWORK.caip2, identityId: ID, operation: 'remove',
    }],
  ] as const)('maps optional workflow fields for %s', async (name, input, method, expected) => {
    const { workflow } = await capture();

    const response = await tool(name)(input);

    expect(response.isError).not.toBe(true);
    expect(workflow[method]).toHaveBeenCalledExactlyOnceWith(expected);
  });

  it.each([
    [{}, { network: TEST_CANONICAL_NETWORK.caip2 }],
    [{ source: SOURCE_ID, identityProvider: 'Primary', gapLimit: 5, startIndex: 0, endIndex: 4 }, {
      network: TEST_CANONICAL_NETWORK.caip2, source: SOURCE_ID, identityProviderIndex: 4,
      gapLimit: 5, startIndex: 0, endIndex: 4,
    }],
  ])('maps identity discovery input %j', async (input, expected) => {
    const { workflow, providers } = await capture();

    await tool('discover_identities')(input);

    expect(workflow.discoverIdentities).toHaveBeenCalledExactlyOnceWith(expected);
    if ('identityProvider' in input) {
      expect(providers.resolve).toHaveBeenCalledWith({
        network: TEST_CANONICAL_NETWORK, selector: input.identityProvider, requireEnabled: true,
      });
    } else expect(providers.resolve).not.toHaveBeenCalled();
  });

  it('trims and case-folds a bare identity label, returns canonical spelling, and stops an unknown label', async () => {
    const { workflow } = await capture();
    const input = { identityId: '  aGeNt ', publicKeys: { '0': PUBLIC_KEY }, credentialThreshold: 1, expirySeconds: 900 };

    await tool('prepare_account_opening')(input);
    expect(workflow.list).toHaveBeenCalledWith({ network: TEST_CANONICAL_NETWORK.caip2 });
    expect(workflow.prepareAccount).toHaveBeenCalledWith({ ...input, identityId: ID, network: TEST_CANONICAL_NETWORK.caip2 });

    vi.mocked(workflow.list).mockResolvedValueOnce([]);
    const response = await tool('prepare_account_opening')({ ...input, identityId: 'missing' });
    expect(response.isError).toBe(true);
    expect(workflow.prepareAccount).toHaveBeenCalledOnce();
  });

  it('never case-folds a native identity ID while resolving MCP selectors', async () => {
    const { workflow } = await capture();
    await expect(Promise.resolve().then(() => tool('prepare_account_opening')({
      identityId: 'AB'.repeat(32), publicKeys: { '0': PUBLIC_KEY }, credentialThreshold: 1, expirySeconds: 900,
    }))).rejects.toBeDefined();
    expect(workflow.prepareAccount).not.toHaveBeenCalled();
  });
});
