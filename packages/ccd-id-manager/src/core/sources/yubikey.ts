import { IdentityHardwareError, type IdentityRootInspection, type IdentityYubiKeyService } from '@ccd-agent-kit/piv-utils';
import type { IdentitySourceBackend, IdentitySourceBackendInspection } from './types.js';

function serial(locator: Record<string, unknown>): string {
  return locator.serial as string;
}

/** Adapt strict slot-9d YubiKey inspection to the backend-neutral source contract. */
export function createYubiKeySourceBackend(hardware: IdentityYubiKeyService): IdentitySourceBackend {
  const observations = new Map<string, IdentityRootInspection>();
  let referenced: Set<string> | undefined;
  const unavailable = (reason: 'DEVICE_MISSING' | 'DEVICE_BUSY' | 'UNSUPPORTED_METADATA' | 'UNREADABLE') => ({ status: 'unavailable' as const, reason });
  const cachedInspection = async (locator: Record<string, unknown>): Promise<IdentitySourceBackendInspection> => {
    const deviceSerial = serial(locator);
    const cached = observations.get(deviceSerial);
    if (cached === undefined) return unavailable('DEVICE_MISSING');
    let pinStatus = cached.pinStatus;
    try { pinStatus = await hardware.pinStatus(deviceSerial); }
    catch (error) {
      const failure = hardwareFailure(error);
      if (failure.status === 'unavailable') return failure;
    }
    return project({ ...cached, pinStatus });
  };
  return {
    backend: 'yubikey-piv',
    async refresh(locators) {
      for (const locator of locators) {
        const deviceSerial = serial(locator);
        try { observations.set(deviceSerial, await hardware.inspectRoot(deviceSerial)); }
        catch { observations.delete(deviceSerial); }
      }
    },
    async retain(locators) {
      const retained = new Set(locators.map(locator => serial(locator)));
      referenced = retained;
      for (const deviceSerial of observations.keys()) if (!retained.has(deviceSerial)) observations.delete(deviceSerial);
    },
    async inspect(locator) {
      const deviceSerial = serial(locator);
      if (referenced !== undefined && !referenced.has(deviceSerial)) return unavailable('DEVICE_MISSING');
      if (!observations.has(deviceSerial)) {
        try {
          const observed = await hardware.inspectRoot(deviceSerial);
          observations.set(deviceSerial, observed);
          return project(observed);
        } catch (error) { return hardwareFailure(error); }
      }
      return cachedInspection(locator);
    },
    createAgreement(input) {
      const agreement = hardware.createAgreement({
        serial: serial(input.locator), expectedPublicKey: Buffer.from(input.expectedPublicKey),
        ...(input.promptPin === undefined ? {} : { promptPin: input.promptPin }),
      });
      return agreement;
    },
  };

  function project(result: IdentityRootInspection): IdentitySourceBackendInspection {
    if (result.status !== 'occupied' || result.publicKey === undefined
      || !['never', 'once', 'always'].includes(result.pinPolicy ?? '')) return unavailable('UNSUPPORTED_METADATA');
    return {
      status: 'present', rootPublicKey: result.publicKey,
      authorization: result.pinPolicy === 'never'
        || result.pinPolicy === 'once' && result.pinStatus.status === 'verified' ? 'unlocked' : 'locked',
      pinPolicy: result.pinPolicy!,
      ...(result.touchPolicy === undefined ? {} : { touchPolicy: result.touchPolicy }),
    };
  }

  function hardwareFailure(error: unknown): IdentitySourceBackendInspection {
    if (error instanceof IdentityHardwareError) {
      if (error.code === 'DEVICE_MISSING') return unavailable('DEVICE_MISSING');
      if (error.code === 'DEVICE_BUSY') return unavailable('DEVICE_BUSY');
      if (error.code === 'ROOT_UNAVAILABLE') return unavailable('UNSUPPORTED_METADATA');
    }
    return unavailable('UNREADABLE');
  }
}
