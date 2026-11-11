import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ed25519PublicKey } from '@ccd-agent-kit/sdk-utils';
import { listSignerKeys } from '../../../../src/core/keys/listSignerKeys.js';
import { formatKeysResource, keysResource, readKeysResource } from '../../../../src/mcp/resources/keysResource.js';

vi.mock('../../../../src/core/keys/listSignerKeys.js', () => ({ listSignerKeys: vi.fn() }));

describe('keysResource', () => {
  const publicKey = ed25519PublicKey.require('11'.repeat(32));

  beforeEach(() => {
    vi.mocked(listSignerKeys).mockReset().mockReturnValue({
      keys: [{ label: 'agent', publicKey, scheme: 'Ed25519', status: 'unlocked' }],
    });
  });

  it('declares stable public metadata', () => {
    expect(keysResource).toMatchObject({
      name: 'ccd://keys', uri: 'ccd://keys', title: 'Concordium Signer Keys', mimeType: 'application/json',
    });
  });

  it('projects the core bare-label catalogue unchanged', () => {
    expect(formatKeysResource()).toEqual({
      keys: [{ label: 'agent', publicKey, scheme: 'Ed25519', status: 'unlocked' }],
    });
    expect(listSignerKeys).toHaveBeenCalledOnce();
  });

  it('wraps the projection as JSON MCP resource content', () => {
    const result = readKeysResource('ccd://keys');

    expect(result.uri).toBe('ccd://keys');
    expect(result.mimeType).toBe('application/json');
    expect(JSON.parse(result.text)).toEqual(formatKeysResource());
  });
});
