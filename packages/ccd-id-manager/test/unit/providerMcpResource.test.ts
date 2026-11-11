import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { IdentitySourceService } from '../../src/core/sources/types.js';
import { identityProviderServiceFixture, TEST_CANONICAL_NETWORK } from '../helpers.js';
import { identityWorkflowFixture } from '../mcpTestHelpers.js';
import {
  captureIdentityMcpAdapter, resource, resourcePayload,
} from './mcpAdapterHarness.js';

const network = {
  name: 'testnet', caip2: TEST_CANONICAL_NETWORK.caip2 as `ccd:${string}`,
  value: { ...TEST_CANONICAL_NETWORK },
};
const configMocks = vi.hoisted(() => ({
  adapter: { list: vi.fn(), resolveDefault: vi.fn(), resolve: vi.fn() },
}));
vi.mock('@ccd-agent-kit/config-utils', async importOriginal => ({
  ...await importOriginal<typeof import('@ccd-agent-kit/config-utils')>(),
  createNetworkResourceAdapter: vi.fn(() => configMocks.adapter),
}));

const sources = (): IdentitySourceService => ({
  resolve: vi.fn(), list: vi.fn(async () => []), records: vi.fn(async () => []),
  inspect: vi.fn(), createAgreement: vi.fn(), refresh: vi.fn(async () => undefined),
});

describe('identity-provider MCP resource ownership', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    configMocks.adapter.list.mockReturnValue([network]);
    configMocks.adapter.resolveDefault.mockReturnValue(network);
    configMocks.adapter.resolve.mockReturnValue(network);
  });

  it('projects provider domain data without duplicating network routing metadata', async () => {
    const providers = identityProviderServiceFixture({ inventory: vi.fn(async () => ({
      network: TEST_CANONICAL_NETWORK.caip2,
      providers: [{ index: 4, name: 'Provider Four', enabled: true }],
    })) });
    await captureIdentityMcpAdapter({ workflow: identityWorkflowFixture(), sources: sources(), providers });

    expect(resourcePayload(await resource('identity-providers-default')(new URL('ccd://identity-providers')))).toEqual({
      network: 'testnet', caip2: TEST_CANONICAL_NETWORK.caip2,
      result: { providers: [{ index: 4, name: 'Provider Four', enabled: true }] },
    });
  });

  it('sanitizes provider storage failures', async () => {
    const providers = identityProviderServiceFixture({
      inventory: vi.fn(async () => { throw new Error('https://private.example/secret'); }),
    });
    await captureIdentityMcpAdapter({ workflow: identityWorkflowFixture(), sources: sources(), providers });

    await expect(resource('identity-providers-default')(new URL('ccd://identity-providers')))
      .rejects.toThrow('Identity-provider inventory is unavailable.');
  });
});
