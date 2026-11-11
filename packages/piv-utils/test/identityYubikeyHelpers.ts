import type {
  IdentityRootGenerationInput,
  IdentityRootImportInput,
  PivCardSession,
  PivPinStatus,
  PivSessionPool,
  PivSlotMetadata,
  PivTransport,
} from '../src/index.js';
import { createECDH } from 'node:crypto';
import { vi } from 'vitest';

export const SERIAL = '12345678';
function point(privateByte: number): Buffer {
  const ecdh = createECDH('prime256v1');
  const scalar = Buffer.alloc(32);
  scalar[31] = privateByte;
  ecdh.setPrivateKey(scalar);
  return ecdh.getPublicKey(undefined, 'uncompressed');
}
export const PUBLIC_KEY = point(1);
export const OTHER_KEY = point(2);
export const PRIVATE_KEY_HEX = `${'00'.repeat(31)}01`;

export function publicTemplate(key = PUBLIC_KEY): Buffer {
  return Buffer.concat([Buffer.from('8641', 'hex'), key]);
}

export function occupied(key = PUBLIC_KEY): PivSlotMetadata {
  return {
    slot: '9d',
    status: 'occupied',
    algorithm: 0x11,
    publicKeyTemplate: publicTemplate(key),
    origin: 'generated',
    pinPolicy: 'once',
    touchPolicy: 'always',
  } as const;
}

/** Structural shared-PIV fake: no native reader, live hardware, or filesystem state. */
export function hardware() {
  const events: string[] = [];
  const card = {
    readerName: 'Test YubiKey reader',
    selectPiv: vi.fn(async () => {
      events.push('select');
    }),
    getSerial: vi.fn(async () => SERIAL),
    getVersion: vi.fn(async () => '5.8.0'),
    getDeviceInfo: vi.fn(async () => ({ model: 'YubiKey 5 NFC', formFactor: 'USB-A Keychain' })),
    getSlotMetadata: vi.fn(async (_slot: string) => occupied()),
    authenticateManagementKey: vi.fn(async (_prompt: () => Promise<string>) => {
      events.push('management');
    }),
    verifyPin: vi.fn(async (_prompt: () => Promise<string>) => {
      events.push('pin');
    }),
    getPinStatus: vi.fn(async (): Promise<PivPinStatus> => ({ status: 'required', retries: 3 })),
    clearPinVerification: vi.fn(async () => {}),
    reboot: vi.fn(async () => {}),
    transmit: vi.fn(async (_command: Buffer, _responseLength: number) =>
      Buffer.concat([Buffer.from('7f4943', 'hex'), publicTemplate()]),
    ),
    disconnect: vi.fn(async () => {}),
  } satisfies PivCardSession;
  const transport = {
    withCards<T>(callback: (cards: PivCardSession[]) => Promise<T> | T): Promise<T> {
      return Promise.resolve(callback([card]));
    },
    withSelectedCard<T>(
      _serial: string | undefined,
      callback: (selected: PivCardSession) => Promise<T>,
    ): Promise<T> {
      return callback(card);
    },
    watchDevices: vi.fn(async () => ({ close() {} })),
  } satisfies PivTransport;
  const withCards = vi.spyOn(transport, 'withCards');
  const withSelectedCard = vi.spyOn(transport, 'withSelectedCard');
  return { card, transport, withCards, withSelectedCard, events };
}

export function sessionPool(card: PivCardSession | (() => PivCardSession)) {
  const pool = {
    withCard<T>(_serial: string, callback: (selected: PivCardSession) => Promise<T>): Promise<T> {
      return callback(typeof card === 'function' ? card() : card);
    },
    retain: vi.fn(async (_serial: string) => {}),
    release: vi.fn(async (_serial: string) => {}),
    close: vi.fn(async () => {}),
  } satisfies PivSessionPool;
  const withCard = vi.spyOn(pool, 'withCard');
  return { pool, withCard };
}

export function generationInput(): IdentityRootGenerationInput {
  return {
    serial: SERIAL,
    pinPolicy: 'once',
    touchPolicy: 'always',
    force: false,
    interaction: {
      promptPin: vi.fn(async () => '123456'),
      promptManagementKey: vi.fn(async () => '010203040506070801020304050607080102030405060708'),
      confirm: vi.fn(async () => true),
    },
  };
}

export function importInput(): IdentityRootImportInput {
  return { ...generationInput(), privateKeyHex: PRIVATE_KEY_HEX };
}
