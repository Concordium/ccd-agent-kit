import { describe, expect, it } from 'vitest';
import { createIdentityYubiKeyService, IdentityHardwareError } from '../../src/index.js';
import { PRIVATE_DIAGNOSTIC, expectSanitized } from '../identityTestHelpers.js';
import { hardware, SERIAL } from '../identityYubikeyHelpers.js';

describe('native identity error boundary', () => {
  it('reconstructs recognized errors instead of retaining backend messages or causes', async () => {
    const h = hardware();
    const failure = new IdentityHardwareError('ROOT_UNAVAILABLE');
    failure.message = PRIVATE_DIAGNOSTIC;
    Object.defineProperty(failure, 'cause', { value: new Error(PRIVATE_DIAGNOSTIC), enumerable: true });
    h.withSelectedCard.mockRejectedValue(failure);
    const operation = createIdentityYubiKeyService(h.transport).inspectRoot(SERIAL);
    await expect(operation).rejects.toBeInstanceOf(IdentityHardwareError);
    await operation.catch(error => {
      expect(error).not.toBe(failure);
      expectSanitized(error, IdentityHardwareError, 'ROOT_UNAVAILABLE');
    });
  });

  it('does not expose a backend-modified error classification', async () => {
    const h = hardware();
    const failure = new IdentityHardwareError('ROOT_UNAVAILABLE');
    Object.defineProperty(failure, 'code', { value: PRIVATE_DIAGNOSTIC });
    h.withSelectedCard.mockRejectedValue(failure);
    const operation = createIdentityYubiKeyService(h.transport).inspectRoot(SERIAL);
    await operation.catch(error => expectSanitized(error, IdentityHardwareError, 'DEVICE_FAILED'));
    await expect(operation).rejects.toBeInstanceOf(IdentityHardwareError);
  });
});
