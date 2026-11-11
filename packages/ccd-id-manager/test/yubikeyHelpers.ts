import { createECDH } from 'node:crypto';
import type { IdentityRootGenerationInput, PivCardSession, PivSlotMetadata, PivTransport } from '@ccd-agent-kit/piv-utils';
import { vi } from 'vitest';

export const SERIAL = '12345678';
function point(privateByte: number): Buffer {
  const ecdh = createECDH('prime256v1'); const scalar = Buffer.alloc(32); scalar[31] = privateByte;
  ecdh.setPrivateKey(scalar); return ecdh.getPublicKey(undefined, 'uncompressed');
}
export const PUBLIC_KEY = point(1);
export const OTHER_KEY = point(2);
export function publicTemplate(key = PUBLIC_KEY): Buffer { return Buffer.concat([Buffer.from('8641', 'hex'), key]); }
export function occupied(key = PUBLIC_KEY): PivSlotMetadata {
  return { slot: '9d', status: 'occupied', algorithm: 0x11, publicKeyTemplate: publicTemplate(key),
    origin: 'generated', pinPolicy: 'once', touchPolicy: 'always' } as const;
}
export function hardware() {
  const events: string[] = [];
  const card = {
    readerName: 'Test YubiKey reader', selectPiv: vi.fn(async () => { events.push('select'); }),
    getSerial: vi.fn(async () => SERIAL), getVersion: vi.fn(async () => '5.8.0'),
    getDeviceInfo: vi.fn(async () => ({ model: 'YubiKey 5 NFC', formFactor: 'USB-A Keychain' })),
    getSlotMetadata: vi.fn(async (_slot: string) => occupied()),
    authenticateManagementKey: vi.fn(async (_prompt: () => Promise<string>) => { events.push('management'); }),
    verifyPin: vi.fn(async (_prompt: () => Promise<string>) => { events.push('pin'); }),
    getPinStatus: vi.fn(async () => ({ status: 'required', retries: 3 } as const)),
    clearPinVerification: vi.fn(async () => {}), reboot: vi.fn(async () => {}),
    transmit: vi.fn(async (_command: Buffer, _responseLength?: number) => Buffer.concat([Buffer.from('7f4943', 'hex'), publicTemplate()])),
    disconnect: vi.fn(async () => {}),
  };
  const withCards = vi.fn(async (callback: (cards: PivCardSession[]) => Promise<unknown>) => callback([card as unknown as PivCardSession]));
  const withSelectedCard = vi.fn(async (_serial: string | undefined, callback: (selected: PivCardSession) => Promise<unknown>, _options?: unknown) => callback(card as unknown as PivCardSession));
  const transport = { withCards, withSelectedCard, watchDevices: vi.fn() } as unknown as PivTransport;
  return { card, transport, withCards, withSelectedCard, events };
}
export function generationInput(): IdentityRootGenerationInput {
  return { serial: SERIAL, pinPolicy: 'once', touchPolicy: 'always', force: false, interaction: {
    promptPin: vi.fn(async () => '123456'),
    promptManagementKey: vi.fn(async () => '010203040506070801020304050607080102030405060708'),
    confirm: vi.fn(async () => true),
  } };
}
