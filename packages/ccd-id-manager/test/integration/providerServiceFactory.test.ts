import { describe,expect,it,vi } from 'vitest';
import {
createDefaultIdentityProviderService,
resolveProviderNetwork,
} from '../../src/core/providers/serviceFactory.js';
import { useProviderScratch } from '../providerHelpers.js';

useProviderScratch('provider-service-factory-');
vi.mock('../../src/core/providers/node.js', () => ({
  readFinalizedIdentityProviderContext: vi.fn(() => { throw new Error('Unexpected node access'); }),
}));

describe('default identity-provider service factory', () => {
  it('persists local timeout settings through the default composition without node access', async () => {
    const service = createDefaultIdentityProviderService();
    const network = resolveProviderNetwork('mainnet');
    await service.configureIdentityRequestTimeout({ network, seconds: 3600 });
    await expect(createDefaultIdentityProviderService().getIdentityRequestTimeoutMs({ network })).resolves.toBe(3_600_000);
  });
});
