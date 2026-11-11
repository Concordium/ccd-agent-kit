import { describe, expect, it, vi } from 'vitest';

import { IdentitySourceError } from '@ccd-agent-kit/config-utils';
import { IdentityProviderError } from '../../src/core/providers/error.js';
import type { IdentitySourceService } from '../../src/core/sources/types.js';
import { IdentityWorkflowError } from '../../src/core/workflowErrors.js';
import { identityProviderServiceFixture } from '../helpers.js';
import { identityWorkflowFixture } from '../mcpTestHelpers.js';
import { captureIdentityMcpAdapter, tool, toolText } from './mcpAdapterHarness.js';

const networkMocks = vi.hoisted(() => ({ resolve: vi.fn(() => ({
  caip2: `ccd:${'12'.repeat(16)}`, genesisHash: '12'.repeat(32),
})) }));
vi.mock('../../src/core/providers/serviceFactory.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/core/providers/serviceFactory.js')>(),
  resolveProviderNetwork: networkMocks.resolve,
}));

function sources(): IdentitySourceService {
  return {
    resolve: vi.fn(), list: vi.fn(async () => []), records: vi.fn(async () => []),
    inspect: vi.fn(), createAgreement: vi.fn(), refresh: vi.fn(async () => undefined),
  };
}

const input = { identityProvider: 4 };

describe('workflow MCP error adapter', () => {
  it.each([
    new IdentityWorkflowError('AUTHORIZATION_REQUIRED'),
    new IdentitySourceError('NO_DEFAULT_SOURCE'),
    new IdentityProviderError('PROVIDER_NOT_FOUND'),
  ])('renders producer-owned $name without unrelated properties', async error => {
    Object.assign(error, { detail: 'secret /Users/alice/private-state' });
    const workflow = identityWorkflowFixture({ request: vi.fn(async () => { throw error; }) });
    await captureIdentityMcpAdapter({ workflow, sources: sources(), providers: identityProviderServiceFixture() });

    const response = await tool('request_identity')(input);
    const payload = toolText(response);

    expect(response.isError).toBe(true);
    expect(payload).toContain(error.message);
    expect(payload).not.toMatch(/Users\/alice|private-state|secret/);
  });

  it('sanitizes unstructured workflow failures', async () => {
    const workflow = identityWorkflowFixture({
      request: vi.fn(async () => { throw new Error('secret /Users/alice/private-state'); }),
    });
    await captureIdentityMcpAdapter({ workflow, sources: sources(), providers: identityProviderServiceFixture() });

    const response = await tool('request_identity')(input);
    const payload = toolText(response);

    expect(response.isError).toBe(true);
    expect(payload).toContain('Identity workflow operation failed.');
    expect(payload).not.toMatch(/Users\/alice|private-state|secret/);
  });
});
