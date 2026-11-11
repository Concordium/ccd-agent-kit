import type { PivDeviceLocator } from './inventory.js';

/** Returns the stable custody identity for a parsed PIV signing location. */
export function pivDeviceLocatorIdentity(device: PivDeviceLocator): string {
  return device.kind === 'yubikey'
    ? `${device.kind}\0${device.serial}\0${device.slot}`
    : `${device.kind}\0${device.slot}`;
}
