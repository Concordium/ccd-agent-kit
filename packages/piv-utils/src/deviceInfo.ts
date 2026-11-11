import type { Buffer } from 'node:buffer';
import { parseAllTlvs } from './codecs.js';

/** Decodes Yubico management device facts without exposing native handles. */
export function decodeDeviceInfo(data: Buffer): { firmwareVersion?: string; formFactor?: string; model?: string } {
  let firmwareVersion: string | undefined;
  let formFactorValue: number | undefined;
  const payload = data[0] === data.length - 1 ? data.subarray(1) : data;
  for (const { tag, value } of parseAllTlvs(payload)) {
    if (tag === 4 && value.length === 1) formFactorValue = value[0];
    if (tag === 5 && value.length === 3) firmwareVersion = `${value[0]}.${value[1]}.${value[2]}`;
  }
  const factor = formFactorValue === undefined ? undefined : formFactorValue & 0x7f;
  const names = ['USB-A keychain', 'USB-A nano', 'USB-C keychain', 'USB-C nano', 'USB-C and Lightning', 'USB-A biometric', 'USB-C biometric'];
  const formFactor = factor === undefined ? undefined : names[factor - 1] ?? `0x${formFactorValue!.toString(16)}`;
  const suffix = formFactorValue !== undefined && (formFactorValue & 0x80) !== 0 ? ' FIPS' : '';
  const models = ['YubiKey 5 NFC', 'YubiKey 5 Nano', 'YubiKey 5C', 'YubiKey 5C Nano', 'YubiKey 5Ci'];
  let model: string | undefined;
  if (firmwareVersion?.split('.')[0] === '5' && factor !== undefined && factor >= 1 && factor <= 5) model = models[factor - 1]! + suffix;
  if (factor === 6) model = `YubiKey Bio USB-A${suffix}`;
  if (factor === 7) model = `YubiKey Bio USB-C${suffix}`;
  return {
    ...(firmwareVersion === undefined ? {} : { firmwareVersion }),
    ...(formFactor === undefined ? {} : { formFactor }),
    ...(model === undefined ? {} : { model }),
  };
}
