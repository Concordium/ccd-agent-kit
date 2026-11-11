import { describe,expect,it } from 'vitest';
import { IdentityProviderError } from '../../src/core/providers/error.js';

describe('identity-provider public domain contract', () => {
  it.each([
    'INVALID_NETWORK',
    'INVALID_SELECTOR',
    'INVALID_CONFIGURATION',
    'INVALID_LABEL',
    'DUPLICATE_LABEL',
    'PROVIDER_NOT_FOUND',
    'PROVIDER_NOT_CONFIGURED',
    'ISSUANCE_NOT_CONFIGURED',
    'RECOVERY_NOT_CONFIGURED',
    'PROVIDER_DISABLED',
    'STORAGE_FAILED',
    'NODE_FAILED',
    'CONTEXT_MISMATCH',
  ] as const)('publishes a sanitized stable provider error code: %s', (code) => {
    const error = new IdentityProviderError(code);
    expect(error).toBeInstanceOf(Error);
    expect(error).toHaveProperty('code', code);
    expect(error).not.toHaveProperty('cause');
    expect(`${error} ${JSON.stringify(error)}`).not.toMatch(/\/private|XDG_|genesisHash/i);
  });
});
