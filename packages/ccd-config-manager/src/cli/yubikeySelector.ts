import { assertYubiKeySerial, resolveYubiKeyRegistration } from '@ccd-agent-kit/config-utils';

/** Resolves a decimal serial or registered global friendly YubiKey name to its serial. */
export function resolveYubiKeySelector(selector?: string): string | undefined {
  if (selector === undefined) return undefined;
  if (/^\d+$/.test(selector)) return assertYubiKeySerial(selector);
  const registration = resolveYubiKeyRegistration(selector);
  if (registration === undefined) throw new Error(`YubiKey '${selector}' is not registered.`);
  return registration.serial;
}
