import { describe,expect,it,vi } from 'vitest';
import { deriveIdentityRoot,RootDerivationError } from '../../src/core/identityRoot.js';
import { expectSanitized,softwareDevice } from '../helpers.js';
import { ROOT_CONTEXT } from '../identityCryptoFixtures.js';

vi.mock('node:crypto', async importOriginal => ({
  ...await importOriginal<typeof import('node:crypto')>(),
  hkdfSync: vi.fn(() => { throw new Error('native KDF failure: deadbeef /protected/identity/private-state'); }),
}));

describe('identity root KDF failure boundary', () => {
  it('clears the transferred secret and sanitizes unexpected native KDF errors', async () => {
    const device = softwareDevice();
    const operation = deriveIdentityRoot({ ...ROOT_CONTEXT, expectedPublicKey: device.publicKey, agreement: device });
    await expect(operation).rejects.toBeInstanceOf(RootDerivationError);
    await operation.catch(error => expectSanitized(error, RootDerivationError, 'AGREEMENT_FAILED'));
    expect(device.transferred).toHaveLength(1);
    expect(device.transferred[0]).toEqual(Buffer.alloc(32));
  });
});
