import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { IdentitySourceService } from '../../src/core/sources/types.js';
import { identityProviderServiceFixture, TEST_CANONICAL_NETWORK } from '../helpers.js';
import { identityWorkflowFixture } from '../mcpTestHelpers.js';
import {
  captureIdentityMcpAdapter, requestHandler, resource, resourceNotificationUris, resourcePayload, tool,
} from './mcpAdapterHarness.js';

const ID = '35'.repeat(32);
const network = {
  name: 'testnet', caip2: TEST_CANONICAL_NETWORK.caip2 as `ccd:${string}`,
  value: { ...TEST_CANONICAL_NETWORK },
};
const configMocks = vi.hoisted(() => ({
  adapter: {
    list: vi.fn(), resolveDefault: vi.fn(), resolve: vi.fn(),
  },
}));
vi.mock('@ccd-agent-kit/config-utils', async importOriginal => ({
  ...await importOriginal<typeof import('@ccd-agent-kit/config-utils')>(),
  createNetworkResourceAdapter: vi.fn(() => configMocks.adapter),
}));

function sources(): IdentitySourceService {
  return {
    resolve: vi.fn(), list: vi.fn(async () => []), records: vi.fn(async () => []),
    inspect: vi.fn(), createAgreement: vi.fn(), refresh: vi.fn(async () => undefined),
  };
}

describe('identity MCP resource ownership', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    configMocks.adapter.list.mockReturnValue([network]);
    configMocks.adapter.resolveDefault.mockReturnValue(network);
    configMocks.adapter.resolve.mockReturnValue(network);
  });

  it('projects safe summaries into the shared envelope and normalizes labels', async () => {
    const summary = {
      identityId: ID, network: TEST_CANONICAL_NETWORK.caip2, identityProviderIndex: 4,
      identityIndex: 7, status: 'issued' as const, label: '@AgentLabel',
    };
    await captureIdentityMcpAdapter({
      workflow: identityWorkflowFixture({ list: vi.fn(async () => [summary]) }),
      sources: sources(), providers: identityProviderServiceFixture(),
    });

    expect(resourcePayload(await resource('identities-default')(new URL('ccd://identities')))).toEqual({
      network: 'testnet', caip2: TEST_CANONICAL_NETWORK.caip2,
      result: { identities: [{ ...summary, label: 'AgentLabel' }] },
    });
  });

  it('sanitizes inventory failures without leaking collaborator details', async () => {
    await captureIdentityMcpAdapter({
      workflow: identityWorkflowFixture({
        list: vi.fn(async () => { throw new Error('secret /Users/alice/private-state'); }),
      }),
      sources: sources(), providers: identityProviderServiceFixture(),
    });

    const failure = resource('identities-default')(new URL('ccd://identities'));
    await expect(failure).rejects.toThrow('Identity inventory is unavailable.');
    await expect(failure).rejects.not.toThrow('/Users/alice');
  });

  it('does not invalidate subscriptions for agent-driven tool mutations', async () => {
    const summary = {
      identityId: ID, network: TEST_CANONICAL_NETWORK.caip2, identityProviderIndex: 4,
      identityIndex: 7, status: 'pending' as const,
    };
    await captureIdentityMcpAdapter({
      workflow: identityWorkflowFixture({ setAgentIdentityLabel: vi.fn(async () => summary) }),
      sources: sources(), providers: identityProviderServiceFixture(),
    });
    await requestHandler('resources/subscribe')({ uri: 'ccd://identities' });

    await tool('label_identity')({ identityId: ID, label: 'next' });

    expect(resourceNotificationUris()).toEqual([]);
  });
});
