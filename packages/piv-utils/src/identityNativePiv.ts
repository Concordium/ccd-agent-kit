import { apdu, isPinRetryStatus, isStatusError, pinPolicyByte, tlv, touchPolicyByte } from './codecs.js';
import { parseAllTlvsStrict as parseAllTlvs } from './strictCodecs.js';
import { isPivSharingViolation, PivDeviceNotFoundError } from './errors.js';
import { deriveP256PublicKey, validateP256PrivateScalarHex, validateP256PublicKey } from './p256.js';
import { withPivPinVerified } from './transport.js';
import type { PivCardSession, PivSessionPool, PivSlotMetadata, PivTransport } from './types.js';
import type {
  IdentityDeviceSummary,
  IdentityRootGenerationInput,
  IdentityRootImportInput,
  IdentityRootInspection,
  IdentityYubiKeyService,
} from './identityService.js';

/** Stable identity hardware failures; backend diagnostics are never retained. */
export type IdentityHardwareErrorCode =
  | 'INVALID_DEVICE'
  | 'INVALID_POLICY'
  | 'INVALID_PUBLIC_KEY'
  | 'SLOT_OCCUPIED'
  | 'INVALID_PRIVATE_KEY'
  | 'OCCUPANCY_UNKNOWN'
  | 'CANCELLED'
  | 'GENERATION_UNCERTAIN'
  | 'IMPORT_UNCERTAIN'
  | 'ROOT_UNAVAILABLE'
  | 'ROOT_KEY_MISMATCH'
  | 'AUTHORIZATION_REQUIRED'
  | 'DEVICE_MISSING'
  | 'DEVICE_BUSY'
  | 'DEVICE_FAILED';

const messages: Record<IdentityHardwareErrorCode, string> = {
  INVALID_DEVICE: 'A decimal YubiKey serial is required.',
  INVALID_POLICY: 'Explicit known PIN and touch policies are required.',
  INVALID_PUBLIC_KEY: 'A canonical uncompressed P-256 public key is required.',
  INVALID_PRIVATE_KEY: 'A valid 32-byte P-256 private scalar is required.',
  SLOT_OCCUPIED: 'Identity slot 9d is occupied; replacement requires --force and typed confirmation.',
  OCCUPANCY_UNKNOWN: 'Identity slot 9d occupancy cannot be established; no key mutation was attempted.',
  CANCELLED: 'Identity key replacement was cancelled.',
  GENERATION_UNCERTAIN:
    'Generation was attempted but could not be verified. Slot 9d may have changed. Inspect and verify the device before proceeding; do not retry generation automatically.',
  IMPORT_UNCERTAIN:
    'Import was attempted but could not be verified. Slot 9d may have changed. Inspect and verify the device before proceeding; do not retry import automatically.',
  ROOT_UNAVAILABLE: 'A valid P-256 identity root in slot 9d is unavailable.',
  ROOT_KEY_MISMATCH: 'The identity root does not match the pinned public key.',
  AUTHORIZATION_REQUIRED:
    'Device authorization is required. PIN verification or touch may be needed through the CLI for this operation.',
  DEVICE_MISSING: 'The identity device was not found.',
  DEVICE_BUSY: 'The identity device is busy. Close other applications using it and try again.',
  DEVICE_FAILED: 'The identity device operation failed.',
};

/** Sanitized hardware error containing only a stable code and fixed public guidance. */
export class IdentityHardwareError extends Error {
  /** Construct a failure without retaining native exceptions or secret material. */
  constructor(
    public readonly code: IdentityHardwareErrorCode,
    /** Stable mutation lifecycle facts, present only after a mutating APDU was attempted. */
    public readonly mutation?: Readonly<{
      attempted: true;
      confirmed: boolean;
      rebootFailed: boolean;
      restorationFailed: boolean;
    }>,
  ) {
    super(messages[code]);
    this.name = 'IdentityHardwareError';
  }
}

function serialGuard(serial: string): void {
  if (typeof serial !== 'string' || !/^\d+$/.test(serial)) throw new IdentityHardwareError('INVALID_DEVICE');
}

function publicKey(value: unknown): Buffer {
  try {
    return validateP256PublicKey(value);
  } catch {
    throw new IdentityHardwareError('INVALID_PUBLIC_KEY');
  }
}

function singleTlv(data: Buffer, tag: number): Buffer {
  const values = parseAllTlvs(data);
  if (values.length !== 1 || values[0]!.tag !== tag) throw new Error();
  return values[0]!.value;
}

function templateKey(template: Buffer | undefined): Buffer {
  if (!Buffer.isBuffer(template)) throw new Error();
  const values = parseAllTlvs(template);
  if (values.length !== 1) throw new Error();
  const item = values[0]!;
  return publicKey(item.tag === 0x7f49 ? singleTlv(item.value, 0x86) : singleTlv(template, 0x86));
}

function rootKey(metadata: PivSlotMetadata): Buffer {
  if (metadata.status !== 'occupied' || metadata.algorithm !== 0x11) {
    throw new IdentityHardwareError('ROOT_UNAVAILABLE');
  }
  try {
    return templateKey(metadata.publicKeyTemplate);
  } catch {
    throw new IdentityHardwareError('ROOT_UNAVAILABLE');
  }
}

function pinnedKey(metadata: PivSlotMetadata, expected: Buffer): Buffer {
  const key = rootKey(metadata);
  if (!key.equals(expected)) throw new IdentityHardwareError('ROOT_KEY_MISMATCH');
  return key;
}

function sanitized(error: unknown): IdentityHardwareError {
  if (error instanceof IdentityHardwareError && Object.hasOwn(messages, error.code))
    return new IdentityHardwareError(error.code);
  if (error instanceof PivDeviceNotFoundError) return new IdentityHardwareError('DEVICE_MISSING');
  if (isPivSharingViolation(error)) return new IdentityHardwareError('DEVICE_BUSY');
  if (isStatusError(error, 0x6982) || isPinRetryStatus(error))
    return new IdentityHardwareError('AUTHORIZATION_REQUIRED');
  return new IdentityHardwareError('DEVICE_FAILED');
}

async function facts(card: PivCardSession) {
  await card.selectPiv();
  const serial = await card.getSerial();
  const firmwareVersion = await card.getVersion();
  return { readerName: card.readerName, serial, firmwareVersion };
}

function inspection(
  serial: string,
  summary: IdentityDeviceSummary,
  metadata: PivSlotMetadata,
  pinStatus: IdentityRootInspection['pinStatus'],
): IdentityRootInspection {
  let key: Buffer | undefined;
  try {
    key = rootKey(metadata);
  } catch {
    /* Unusable public observations are not trusted roots. */
  }
  return {
    ...summary,
    pinStatus,
    serial,
    slot: '9d',
    status: metadata.status,
    ...(metadata.algorithm === undefined ? {} : { algorithm: `0x${metadata.algorithm.toString(16)}` }),
    ...(key === undefined ? {} : { publicKey: key.toString('hex') }),
    ...(metadata.origin === undefined ? {} : { origin: metadata.origin }),
    ...(metadata.pinPolicy === undefined ? {} : { pinPolicy: metadata.pinPolicy }),
    ...(metadata.touchPolicy === undefined ? {} : { touchPolicy: metadata.touchPolicy }),
  };
}

/**
 * Create fixed P-256/9d identity orchestration over shared PIV connections.
 * Mutations never retry; agreements verify the pinned key before and after use.
 * Raw agreement responses are cleared, and only the returned secret transfers ownership.
 */
export function createIdentityYubiKeyService(
  transport: PivTransport,
  sessions?: PivSessionPool,
): IdentityYubiKeyService {
  const withCard = <T>(serial: string, callback: (card: PivCardSession) => Promise<T>) =>
    sessions === undefined ? transport.withSelectedCard(serial, callback) : sessions.withCard(serial, callback);

  const provisionRoot = async (
    input: IdentityRootGenerationInput | IdentityRootImportInput,
    uncertainCode: 'GENERATION_UNCERTAIN' | 'IMPORT_UNCERTAIN',
    mutate: (card: PivCardSession, attempted: () => void, confirmed: () => void) => Promise<Buffer>,
    verifyOrigin?: string,
  ) => {
    serialGuard(input.serial);
    if (
      !['never', 'once', 'always'].includes(input.pinPolicy) ||
      !['never', 'cached', 'always'].includes(input.touchPolicy)
    ) {
      throw new IdentityHardwareError('INVALID_POLICY');
    }
    let mutationAttempted = false;
    let mutationConfirmed = false;
    let rebootFailed = false;
    let restorationFailed = false;
    let initiallyVerified = false;
    let pin: string | undefined;
    try {
      let result:
        (IdentityRootInspection & { status: 'occupied'; publicKey: string; replacedExistingKey: boolean }) | undefined;
      let originalError: unknown;
      try {
        result = await transport.withSelectedCard(input.serial, async (card) => {
          try {
            const summary = await facts(card);
            const before = await card.getSlotMetadata('9d');
            if (before.status === 'unknown') throw new IdentityHardwareError('OCCUPANCY_UNKNOWN');
            if (before.status === 'occupied') {
              try {
                rootKey(before);
              } catch {
                throw new IdentityHardwareError('OCCUPANCY_UNKNOWN');
              }
              if (!input.force) throw new IdentityHardwareError('SLOT_OCCUPIED');
              if (!(await input.interaction.confirm(`REPLACE ${input.serial} 9d`)))
                throw new IdentityHardwareError('CANCELLED');
            }
            await card.authenticateManagementKey(input.interaction.promptManagementKey);
            initiallyVerified = (await card.getPinStatus()).status === 'verified';
            pin = await input.interaction.promptPin();
            const { after, expected } = await withPivPinVerified(
              card,
              async () => pin!,
              async () => {
                const expected = await mutate(
                  card,
                  () => {
                    mutationAttempted = true;
                  },
                  () => {
                    mutationConfirmed = true;
                  },
                );
                const after = await card.getSlotMetadata('9d');
                return { after, expected };
              },
            );
            if (
              !rootKey(after).equals(expected) ||
              after.pinPolicy !== input.pinPolicy ||
              after.touchPolicy !== input.touchPolicy ||
              (verifyOrigin !== undefined && after.origin !== verifyOrigin)
            )
              throw new Error();
            return {
              ...inspection(input.serial, summary, after, await card.getPinStatus()),
              status: 'occupied' as const,
              publicKey: expected.toString('hex'),
              replacedExistingKey: before.status === 'occupied',
            };
          } finally {
            if (mutationAttempted) {
              try {
                await card.reboot();
              } catch {
                rebootFailed = true;
              }
            }
          }
        });
      } catch (error) {
        originalError = error;
      }
      if (mutationAttempted && initiallyVerified && pin !== undefined) {
        try {
          await transport.withSelectedCard(input.serial, (card) => card.verifyPin(async () => pin!));
        } catch {
          restorationFailed = true;
        }
      }
      if (originalError !== undefined || rebootFailed || restorationFailed) throw originalError ?? new Error();
      return result!;
    } catch (error) {
      if (mutationAttempted) {
        throw new IdentityHardwareError(uncertainCode, {
          attempted: true,
          confirmed: mutationConfirmed,
          rebootFailed,
          restorationFailed,
        });
      }
      throw sanitized(error);
    } finally {
      pin = undefined;
    }
  };

  return {
    async listDevices() {
      try {
        const devices = await transport.withCards(async (cards) => {
          const devices: Awaited<ReturnType<typeof facts>>[] = [];
          for (const card of cards) {
            try {
              devices.push(await facts(card));
            } catch {
              /* Non-PIV cards are not identity devices. */
            }
          }
          return devices;
        });
        await Promise.all(
          devices.flatMap((device) => (sessions === undefined ? [] : [sessions.retain(device.serial)])),
        );
        return devices;
      } catch (error) {
        throw sanitized(error);
      }
    },
    async inspectRoot(serial) {
      serialGuard(serial);
      try {
        return await withCard(serial, async (card) => {
          const summary = await facts(card);
          return inspection(serial, summary, await card.getSlotMetadata('9d'), await card.getPinStatus());
        });
      } catch (error) {
        throw sanitized(error);
      }
    },
    async generateRoot(input) {
      return provisionRoot(input, 'GENERATION_UNCERTAIN', async (card, attempted, confirmed) => {
        const command = apdu(
          0,
          0x47,
          0,
          0x9d,
          tlv(
            0xac,
            Buffer.concat([
              tlv(0x80, Buffer.from([0x11])),
              tlv(0xaa, Buffer.from([pinPolicyByte(input.pinPolicy)])),
              tlv(0xab, Buffer.from([touchPolicyByte(input.touchPolicy)])),
            ]),
          ),
        );
        attempted();
        const response = await card.transmit(command, 512);
        confirmed();
        return templateKey(response);
      });
    },
    async importRoot(input) {
      let scalar: Buffer;
      try {
        scalar = validateP256PrivateScalarHex(input.privateKeyHex);
      } catch {
        throw new IdentityHardwareError('INVALID_PRIVATE_KEY');
      }
      try {
        const expected = deriveP256PublicKey(scalar);
        return await provisionRoot(
          input,
          'IMPORT_UNCERTAIN',
          async (card, attempted, confirmed) => {
            const privateKeyTlv = tlv(0x06, scalar);
            const pinPolicyTlv = tlv(0xaa, Buffer.from([pinPolicyByte(input.pinPolicy)]));
            const touchPolicyTlv = tlv(0xab, Buffer.from([touchPolicyByte(input.touchPolicy)]));
            const data = Buffer.concat([privateKeyTlv, pinPolicyTlv, touchPolicyTlv]);
            const command = apdu(0, 0xfe, 0x11, 0x9d, data);
            try {
              attempted();
              await card.transmit(command, 512);
              confirmed();
              return expected;
            } finally {
              command.fill(0);
              data.fill(0);
              privateKeyTlv.fill(0);
              pinPolicyTlv.fill(0);
              touchPolicyTlv.fill(0);
            }
          },
          'imported',
        );
      } finally {
        scalar.fill(0);
      }
    },
    async pinStatus(serial) {
      serialGuard(serial);
      try {
        return await transport.withSelectedCard(serial, async (card) => {
          await card.selectPiv();
          return card.getPinStatus();
        });
      } catch (error) {
        throw sanitized(error);
      }
    },
    async pinUnlock(serial, promptPin) {
      serialGuard(serial);
      try {
        await transport.withSelectedCard(serial, async (card) => {
          await card.selectPiv();
          await card.verifyPin(promptPin);
        });
      } catch (error) {
        throw sanitized(error);
      }
    },
    async pinLock(serial) {
      serialGuard(serial);
      try {
        await transport.withSelectedCard(serial, async (card) => {
          await card.selectPiv();
          await card.clearPinVerification();
        });
      } catch (error) {
        throw sanitized(error);
      }
    },
    createAgreement(input) {
      serialGuard(input.serial);
      const serial = input.serial;
      const expected = publicKey(input.expectedPublicKey);
      const promptPin = input.promptPin;
      return {
        async agree(peerPublicKey) {
          const peer = publicKey(peerPublicKey);
          let raw: Buffer | undefined;
          let secret: Buffer | undefined;
          try {
            const result = await withCard(serial, async (card) => {
              await card.selectPiv();
              const before = await card.getSlotMetadata('9d');
              pinnedKey(before, expected);
              const agree = async () =>
                card.transmit(
                  apdu(0, 0x87, 0x11, 0x9d, tlv(0x7c, Buffer.concat([tlv(0x82, Buffer.alloc(0)), tlv(0x85, peer)]))),
                  512,
                );
              raw =
                promptPin && before.pinPolicy !== 'never'
                  ? await withPivPinVerified(card, promptPin, agree)
                  : await agree();
              const value = singleTlv(singleTlv(raw, 0x7c), 0x82);
              if (value.length !== 32 || value.every((byte) => byte === 0)) throw new Error();
              secret = Buffer.from(value);
              const boundKey = pinnedKey(await card.getSlotMetadata('9d'), expected);
              return { publicKey: boundKey, sharedSecret: secret };
            });
            secret = undefined;
            return result;
          } catch (error) {
            throw sanitized(error);
          } finally {
            raw?.fill(0);
            secret?.fill(0);
          }
        },
      };
    },
    async close() {
      try {
        await sessions?.close();
      } catch (error) {
        throw sanitized(error);
      }
    },
  };
}
