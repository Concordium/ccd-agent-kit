import { describe, expect, it, vi } from 'vitest';

import type { IdentitySourceService } from '../../src/core/sources/types.js';
import { identityProviderServiceFixture } from '../helpers.js';
import { identityWorkflowFixture } from '../mcpTestHelpers.js';
import { captureIdentityMcpAdapter, resource, resourcePayload, tool, toolPayload } from './mcpAdapterHarness.js';

const SOURCE_ID = 'ir:2abcdefghijklmn';

function sources(list: IdentitySourceService['list']): IdentitySourceService {
  return {
    list, resolve: vi.fn(), records: vi.fn(async () => []), inspect: vi.fn(), createAgreement: vi.fn(),
    refresh: vi.fn(async () => undefined),
  };
}

describe('identity-source MCP resource adapter', () => {
  it.each([
    [true, { sources: [{ id: SOURCE_ID, label: 'Primary', availability: 'locked' }], default: SOURCE_ID }],
    [false, { sources: [{ id: SOURCE_ID, label: 'Primary', availability: 'locked' }] }],
  ] as const)('projects safe fields and default=%s', async (isDefault, expected) => {
    const record = {
      id: SOURCE_ID, label: 'Primary', availability: 'locked' as const, isDefault,
      backend: 'yubikey-piv', locator: '/private/device',
    };
    const sourceService = sources(vi.fn(async () => [record]));
    await captureIdentityMcpAdapter({
      workflow: identityWorkflowFixture(), sources: sourceService, providers: identityProviderServiceFixture(),
    });

    expect(resourcePayload(await resource('identity-sources')(new URL('ccd://identity-sources')))).toEqual(expected);
    expect(sourceService.resolve).not.toHaveBeenCalled();
    expect(sourceService.inspect).not.toHaveBeenCalled();
  });

  it.each([
    'ccd://identity-sources/',
    'ccd://identity-sources?detail=1',
    'ccd://identity-sources/extra',
    'https://identity-sources',
  ])('rejects non-literal URI %s without listing sources', async uri => {
    const list = vi.fn<IdentitySourceService['list']>(async () => []);
    await captureIdentityMcpAdapter({
      workflow: identityWorkflowFixture(), sources: sources(list), providers: identityProviderServiceFixture(),
    });

    await expect(resource('identity-sources')(new URL(uri))).rejects.toMatchObject({ code: -32602 });
    expect(list).not.toHaveBeenCalled();
  });

  it('translates source failures to a stable resource error', async () => {
    const list = vi.fn<IdentitySourceService['list']>(async () => { throw new Error('PIN=123456 /private/device'); });
    await captureIdentityMcpAdapter({
      workflow: identityWorkflowFixture(), sources: sources(list), providers: identityProviderServiceFixture(),
    });

    await expect(resource('identity-sources')(new URL('ccd://identity-sources')))
      .rejects.toThrow('Identity-source inventory is unavailable.');
  });

  it('publishes a safe soft-label mutation result', async () => {
    const sourceRegistry = {
      setSoftLabel: vi.fn(async () => ({ id: SOURCE_ID, label: '@Primary' })),
    };
    await captureIdentityMcpAdapter({
      workflow: identityWorkflowFixture(), sources: sources(vi.fn(async () => [])),
      providers: identityProviderServiceFixture(),
      sourceRegistry: sourceRegistry as never,
    });

    expect(toolPayload(await tool('label_identity_source')({ source: SOURCE_ID, label: 'Primary' })))
      .toEqual({ id: SOURCE_ID, label: 'Primary' });
  });
});
