import { Buffer } from 'node:buffer';
import { writeSync } from 'node:fs';
import type { Ed25519PrivateKeyHex, Ed25519PublicKeyHex } from './yubikeyService.js';
import { apdu, tlv, pinPolicyByte, touchPolicyByte, isPinRetryStatus, isStatusError } from './codecs.js';
import { parseAllTlvsStrict } from './strictCodecs.js';
import { ApduStatusError } from './codecs.js';
import { createPivSessionPool, createPivTransport, withPivPinVerified } from './transport.js';
import type {
  PcscliteFactory, PivTransport, PivCardSession, PivSessionPool, PivOperationOptions,
  PivResponseObservation, PivSlotMetadata,
} from './types.js';
import {
  ALLOWED_YUBIKEY_SIGNING_SLOTS, assertAllowedYubiKeySigningSlot,
  type YubiKeyPinPolicy, type YubiKeySigningSlot, type YubiKeyTouchPolicy,
} from './yubikeyPolicy.js';
import type {
  GenerateYubiKeyInput, GenerateYubiKeyResult, ImportYubiKeyInput, ImportYubiKeyResult,
  LockYubiKeyInput, LockYubiKeyResult, SignYubiKeyDigestInput, SignYubiKeyDigestResult,
  UnlockYubiKeyInput, UnlockYubiKeyResult, WatchYubiKeyDevicesInput,
  YubiKeyDeviceInspectionResult, YubiKeyDeviceSummary, YubiKeyDeviceWatcher,
  YubiKeyInspection, YubiKeyService, YubiKeySlotInspection,
} from './yubikeyService.js';

const ALGORITHM_ED25519 = 0xe0;

// Temporary, opt-in diagnostics: fixed vocabulary and response metadata only, never payloads/errors.
type GenerationStage = 'management-authentication' | 'pin-verification' | 'key-generation';

interface GenerationDiagnostics {
  readonly operationOptions?: PivOperationOptions;
  run<T>(stage: GenerationStage, operation: () => Promise<T>): Promise<T>;
}

function createGenerationDiagnostics(): GenerationDiagnostics {
  if (process.env.CCD_SIGNER_YUBIKEY_GENERATE_DIAGNOSTICS !== '1') {
    return { run: (_stage, operation) => operation() };
  }
  let activeStage: GenerationStage | undefined;
  const report = (stage: GenerationStage, event: string) => {
    try { process.stderr.write(`[yubikey-generate] ${stage} ${event}\n`); }
    catch { /* Diagnostic output must not prevent or retry an operation. */ }
  };
  return {
    operationOptions: {
      onResponse(observation) {
        if (activeStage === undefined) return;
        try { writeSync(process.stderr.fd, `[yubikey-generate] ${activeStage} ${formatResponseObservation(observation)}\n`); }
        catch { /* Diagnostic output must not prevent or retry an operation. */ }
      },
    },
    async run<T>(stage: GenerationStage, operation: () => Promise<T>): Promise<T> {
      activeStage = stage;
      report(stage, 'started');
      try {
        const result = await operation();
        report(stage, 'succeeded');
        return result;
      } catch (error) {
        report(stage, `failed${error instanceof ApduStatusError ? ` status=0x${error.status.toString(16).padStart(4, '0')}` : ''}`);
        throw error;
      } finally {
        activeStage = undefined;
      }
    },
  };
}

function formatResponseObservation(observation: PivResponseObservation): string {
  const status = observation.status === undefined ? 'absent' : `0x${observation.status.toString(16).padStart(4, '0')}`;
  const data = observation.dataByteCount === undefined ? 'unknown' : observation.dataByteCount.toString();
  const framing = observation.framing.length === 0
    ? 'none'
    : observation.framing.map(frame => `0x${frame.tag.toString(16)}(${frame.declaredLength ?? 'unknown'},${frame.complete ? 'complete' : 'incomplete'})`).join('>');
  return `response status=${status} bytes=${observation.responseByteCount} data=${data} framing=${framing}`;
}

/** Creates a PC/SC-backed YubiKey service; the shared native factory loads lazily. */
export function createNativePivYubiKeyService(options: { persistent?: boolean } = {}): YubiKeyService {
  const transport = createPivTransport();
  return composePivYubiKeyService(
    transport,
    options.persistent === true ? createPivSessionPool(transport) : undefined,
  );
}

/** Creates an APDU-test service without loading native bindings. @internal */
export function createNativePivYubiKeyServiceForTesting(pcscliteFactory: PcscliteFactory, discoveryWaitMs = 1, persistent = false): YubiKeyService {
  const transport = createPivTransport({ factoryLoader: async () => pcscliteFactory, discoveryWaitMs });
  return composePivYubiKeyService(transport, persistent ? createPivSessionPool(transport) : undefined);
}

/** Composes a YubiKey service over a structured PIV transport and optional session pool. @internal */
export function composePivYubiKeyService(
  transport: PivTransport,
  sessions?: PivSessionPool,
): YubiKeyService {
  return new NativePivYubiKeyService(transport, sessions);
}

class NativePivYubiKeyService implements YubiKeyService {
  private retainedSerials = new Set<string>();
  private slotObservations = new WeakMap<PivCardSession, Map<YubiKeySigningSlot, YubiKeySlotInspection>>();

  constructor(private readonly transport: PivTransport, private readonly sessions?: PivSessionPool) {}

  async listDevices(): Promise<YubiKeyDeviceSummary[]> {
    return this.transport.withCards(async (cards) => (await queryPivCards(cards)).map((entry) => entry.device));
  }

  async listAndInspectDeviceKeys(serials?: readonly string[]): Promise<YubiKeyDeviceInspectionResult> {
    this.slotObservations = new WeakMap();
    return this.transport.withCards(async (cards) => {
      const entries = await queryPivCards(cards);
      const requested = serials === undefined ? undefined : new Set(serials);
      const inspectionEntries = entries.filter(
        (entry): entry is PivCardQueryResult & { serial: string } =>
          entry.serial !== undefined && (requested === undefined || requested.has(entry.serial)),
      );
      const seen = new Set<string>();
      for (const entry of inspectionEntries) {
        if (seen.has(entry.serial)) throw new Error('Multiple YubiKeys found. Use --serial <serial>.');
        seen.add(entry.serial);
      }
      const inspections: YubiKeyInspection[] = [];
      for (const entry of inspectionEntries) inspections.push(await inspectPivCard(entry.card, entry.serial));
      const devices = entries.map((entry) => entry.device);
      await this.updateRetainedSerials(serials === undefined ? [] : inspectionEntries.map((entry) => entry.serial));
      return { devices, inspections };
    });
  }

  async watchDevices(input: WatchYubiKeyDevicesInput): Promise<YubiKeyDeviceWatcher> {
    return this.transport.watchDevices(input);
  }

  async inspectDevice(serial?: string): Promise<YubiKeyInspection> {
    if (serial !== undefined && this.sessions !== undefined) return this.sessions.withCard(serial, card => inspectPivCard(card));
    return this.transport.withSelectedCard(serial, card => inspectPivCard(card));
  }

  async generateEd25519Key(input: GenerateYubiKeyInput): Promise<GenerateYubiKeyResult> {
    const slot = assertAllowedYubiKeySigningSlot(input.slot);
    const diagnostics = createGenerationDiagnostics();
    return runRebootingMutation(this.transport, input.serial, input.interaction.promptPin, async (session, mutate) => {
      const card = new Ed25519PivCard(session);
      const serial = await session.getSerial();
      const existing = await card.getSlotInspection(slot);
      if (existing.status === 'unknown') throw new Error(`Slot ${slot} occupancy is unknown; no key mutation was attempted.`);
      if (existing.status === 'occupied') {
        if (!input.force) throw new Error(`Slot ${slot} is occupied. Re-run with --force to replace it.`);
        const confirmed = await input.interaction.confirm(
          `Replacing YubiKey ${serial} slot ${slot} will destroy the existing private key and may break accounts that use its public key.`,
        );
        if (!confirmed) throw new Error('YubiKey key generation cancelled.');
      }
      await diagnostics.run('management-authentication', () => session.authenticateManagementKey(input.interaction.promptManagementKey));
      const publicKey = await mutate(
        confirm => diagnostics.run('key-generation', () => card.generateEd25519(slot, input.pinPolicy, input.touchPolicy, confirm)),
        verify => diagnostics.run('pin-verification', verify),
      );
      return {
        readerName: session.readerName, pinPolicy: input.pinPolicy, publicKey,
        replacedExistingKey: existing.status === 'occupied',
        ...(existing.publicKey !== undefined ? { replacedPublicKey: existing.publicKey } : {}),
        serial, slot, touchPolicy: input.touchPolicy,
      };
    }, diagnostics.operationOptions);
  }

  async importEd25519Key(input: ImportYubiKeyInput): Promise<ImportYubiKeyResult> {
    const slot = assertAllowedYubiKeySigningSlot(input.slot);
    return runRebootingMutation(this.transport, input.serial, input.interaction.promptPin, async (session, mutate) => {
      const card = new Ed25519PivCard(session);
      const serial = await session.getSerial();
      const existing = await card.getSlotInspection(slot);
      if (existing.status === 'unknown') throw new Error(`Slot ${slot} occupancy is unknown; import was not attempted.`);
      if (existing.status === 'occupied') {
        if (!input.force) throw new Error(`Slot ${slot} is occupied. Re-run with --force to replace it.`);
        const confirmed = await input.interaction.confirm(
          `Replacing YubiKey ${serial} slot ${slot} will destroy the existing private key and may break accounts that use its public key.`,
        );
        if (!confirmed) throw new Error('YubiKey key import cancelled.');
      }
      await session.authenticateManagementKey(input.interaction.promptManagementKey);
      const imported = await mutate(async confirm => {
          await card.importEd25519(slot, input.privateKeyHex, input.pinPolicy, input.touchPolicy, confirm);
          return card.getSlotInspection(slot);
      });
      if (imported.publicKey !== input.publicKey) throw new Error('YubiKey imported key public key did not match the prompted private key.');
      return {
        readerName: session.readerName, pinPolicy: input.pinPolicy, publicKey: input.publicKey,
        replacedExistingKey: existing.status === 'occupied',
        ...(existing.publicKey !== undefined ? { replacedPublicKey: existing.publicKey } : {}),
        serial, slot, touchPolicy: input.touchPolicy,
      }
    });
  }

  async unlockDevice(input: UnlockYubiKeyInput): Promise<UnlockYubiKeyResult> {
    return this.transport.withSelectedCard(input.serial, async card => {
      const serial = await card.getSerial();
      await card.verifyPin(input.interaction.promptPin);
      return { readerName: card.readerName, serial };
    });
  }

  async lockDevice(input: LockYubiKeyInput): Promise<LockYubiKeyResult> {
    return this.transport.withSelectedCard(input.serial, async (card) => {
      const serial = await card.getSerial();
      await card.clearPinVerification();
      return { readerName: card.readerName, serial };
    });
  }

  async signEd25519Digest(input: SignYubiKeyDigestInput): Promise<SignYubiKeyDigestResult> {
    if (input.digest.length !== 32) throw new Error('PIV Ed25519 signing requires a 32-byte digest.');
    let lastError: unknown;
    for (const device of input.devices) {
      try {
        const slot = assertAllowedYubiKeySigningSlot(device.slot);
        if (device.serial !== undefined && this.sessions !== undefined) {
          return await this.sessions.withCard(device.serial, session => signEd25519DigestOnSession(
            session, slot, input, device.pinPolicy, this.slotObservations,
          ));
        }
        return await this.transport.withSelectedCard(device.serial, async (session) => {
          return signEd25519DigestOnSession(session, slot, input, device.pinPolicy);
        });
      } catch (error) { lastError = error; }
    }
    if (lastError instanceof Error) throw lastError;
    throw new Error('No configured PIV signing device is available.');
  }

  async close(): Promise<void> {
    await this.sessions?.close();
  }

  private async updateRetainedSerials(serials: readonly string[]): Promise<void> {
    if (this.sessions === undefined) return;
    const selected = new Set(serials);
    await Promise.all([...this.retainedSerials].flatMap(serial => selected.has(serial) ? [] : [this.sessions!.release(serial)]));
    await Promise.all([...selected].flatMap(serial => this.retainedSerials.has(serial) ? [] : [this.sessions!.retain(serial)]));
    this.retainedSerials = selected;
  }
}

interface MutationFacts {
  attempted: boolean;
  confirmed: boolean;
  rebootFailed: boolean;
  restorationFailed: boolean;
}

async function runRebootingMutation<T>(
  transport: PivTransport,
  requestedSerial: string | undefined,
  promptPin: () => Promise<string>,
  operation: (
    session: PivCardSession,
    mutate: <R>(mutation: (confirm: () => void) => Promise<R>, runVerification?: (verify: () => Promise<void>) => Promise<void>) => Promise<R>,
  ) => Promise<T>,
  options?: PivOperationOptions,
): Promise<T> {
  const facts: MutationFacts = { attempted: false, confirmed: false, rebootFailed: false, restorationFailed: false };
  let initiallyVerified = false;
  let pin: string | undefined;
  let serial: string | undefined;
  let result: T | undefined;
  let originalError: unknown;
  try {
    try {
      result = await transport.withSelectedCard(requestedSerial, async session => {
        serial = await session.getSerial();
        return operation(session, async (mutation, runVerification) => {
          initiallyVerified = (await session.getPinStatus()).status === 'verified';
          pin = await promptPin();
          return withPivPinVerified(session, async () => pin!, async () => {
            facts.attempted = true;
            return mutation(() => { facts.confirmed = true; });
          }, runVerification);
        });
      }, options);
    } catch (error) { originalError = error; }

    if (facts.attempted) {
      try {
        await transport.withSelectedCard(serial ?? requestedSerial, session => session.reboot());
      } catch { facts.rebootFailed = true; }
      if (initiallyVerified && pin !== undefined) {
        try { await transport.withSelectedCard(serial ?? requestedSerial, card => card.verifyPin(async () => pin!)); }
        catch { facts.restorationFailed = true; }
      }
    }
    if (originalError !== undefined) throw facts.attempted ? attachMutationFacts(originalError, facts) : originalError;
    if (facts.rebootFailed || facts.restorationFailed) {
      throw attachMutationFacts(new Error('The PIV key changed, but reboot or PIN-state restoration failed. Manually replug and inspect it before continuing.'), facts);
    }
    return result!;
  } finally {
    pin = undefined;
  }
}

function attachMutationFacts(error: unknown, facts: MutationFacts): Error {
  const reported = error instanceof Error ? error : new Error('PIV mutation failed.', { cause: error });
  try {
    Object.defineProperty(reported, 'mutation', { configurable: true, enumerable: true, value: { ...facts } });
    return reported;
  } catch {
    const wrapped = new Error(reported.message, { cause: reported });
    Object.defineProperty(wrapped, 'mutation', { configurable: true, enumerable: true, value: { ...facts } });
    return wrapped;
  }
}

async function signEd25519DigestOnSession(
  session: PivCardSession,
  slot: YubiKeySigningSlot,
  input: SignYubiKeyDigestInput,
  pinPolicy?: YubiKeyPinPolicy,
  observations?: WeakMap<PivCardSession, Map<YubiKeySigningSlot, YubiKeySlotInspection>>,
): Promise<SignYubiKeyDigestResult> {
  const card = new Ed25519PivCard(session);
  await session.selectPiv();
  let sessionObservations = observations?.get(session);
  if (sessionObservations === undefined && observations !== undefined) {
    sessionObservations = new Map();
    observations.set(session, sessionObservations);
  }
  let inspection = sessionObservations?.get(slot);
  if (inspection === undefined) {
    inspection = await card.getSlotInspection(slot);
    sessionObservations?.set(slot, inspection);
  }
  if (inspection.publicKey !== input.publicKey) throw new Error('Selected PIV slot public key does not match signer inventory.');
  const sign = async () => ({ signatureHex: await card.signEd25519(slot, input.digest) });
  if (input.interaction !== undefined && pinPolicy !== 'never') {
    return withPivPinVerified(session, input.interaction.promptPin, sign);
  }
  return sign();
}

interface PivCardQueryResult {
  card: PivCardSession;
  device: YubiKeyDeviceSummary;
  serial?: string;
}

async function queryPivCards(cards: PivCardSession[]): Promise<PivCardQueryResult[]> {
  const entries: PivCardQueryResult[] = [];
  for (const card of cards) {
    try {
      await card.selectPiv();
      const serial = await card.getSerial().catch(() => undefined);
      const firmwareVersion = await card.getVersion().catch(() => undefined);
      entries.push({
        card,
        device: {
          readerName: card.readerName,
          ...(firmwareVersion === undefined ? {} : { firmwareVersion }),
          ...(serial === undefined ? {} : { serial }),
        },
        ...(serial === undefined ? {} : { serial }),
      });
    } catch { /* Non-PIV smart cards are ignored. */ }
  }
  return entries;
}

async function inspectPivCard(card: PivCardSession, knownSerial?: string): Promise<YubiKeyInspection> {
  await card.selectPiv();
  const serial = knownSerial ?? await card.getSerial().catch(() => undefined);
  const firmwareVersion = await card.getVersion().catch(() => undefined);
  const edCard = new Ed25519PivCard(card);
  const pinStatus = await card.getPinStatus();
  const slots: YubiKeySlotInspection[] = [];
  for (const slot of ALLOWED_YUBIKEY_SIGNING_SLOTS) slots.push(await edCard.getSlotInspection(slot));
  return {
    ed25519Supported: firmwareSupportsEd25519(firmwareVersion), pinStatus, readerName: card.readerName,
    slots, touchPolicySupported: 'unknown',
    ...(firmwareVersion === undefined ? {} : { firmwareVersion }),
    ...(serial === undefined ? {} : { serial }),
  };
}

class Ed25519PivCard {
  constructor(private readonly session: PivCardSession) {}

  async getSlotInspection(slot: YubiKeySigningSlot): Promise<YubiKeySlotInspection> {
    return slotInspection(await this.session.getSlotMetadata(slot));
  }

  async generateEd25519(
    slot: YubiKeySigningSlot,
    pinPolicy: YubiKeyPinPolicy,
    touchPolicy: YubiKeyTouchPolicy,
    confirmed: () => void,
  ): Promise<Ed25519PublicKeyHex> {
    const data = tlv(0xac, Buffer.concat([tlv(0x80, Buffer.from([ALGORITHM_ED25519])), tlv(0xaa, Buffer.from([pinPolicyByte(pinPolicy)])), tlv(0xab, Buffer.from([touchPolicyByte(touchPolicy)]))]));
    const response = await this.session.transmit(apdu(0, 0x47, 0, Number.parseInt(slot, 16), data), 512);
    confirmed();
    const publicKey = parseGeneratedPublicKey(response);
    if (publicKey === undefined) throw new Error('YubiKey did not return an Ed25519 public key.');
    return publicKey;
  }

  async importEd25519(
    slot: YubiKeySigningSlot,
    privateKeyHex: Ed25519PrivateKeyHex,
    pinPolicy: YubiKeyPinPolicy,
    touchPolicy: YubiKeyTouchPolicy,
    confirmed: () => void,
  ): Promise<void> {
    const privateKey = Buffer.from(privateKeyHex, 'hex');
    const privateKeyTlv = tlv(1, privateKey);
    const pinPolicyTlv = tlv(0xaa, Buffer.from([pinPolicyByte(pinPolicy)]));
    const touchPolicyTlv = tlv(0xab, Buffer.from([touchPolicyByte(touchPolicy)]));
    const data = Buffer.concat([privateKeyTlv, pinPolicyTlv, touchPolicyTlv]);
    const command = apdu(0, 0xfe, ALGORITHM_ED25519, Number.parseInt(slot, 16), data);
    try {
      await this.session.transmit(command, 512);
      confirmed();
    } finally {
      command.fill(0);
      data.fill(0);
      privateKeyTlv.fill(0);
      privateKey.fill(0);
    }
  }

  async signEd25519(slot: YubiKeySigningSlot, digest: Uint8Array): Promise<string> {
    try {
      const data = buildEd25519SignData(Buffer.from(digest));
      return parseEd25519SignatureResponse(await this.session.transmit(apdu(0, 0x87, ALGORITHM_ED25519, Number.parseInt(slot, 16), data), 512)).toString('hex');
    } catch (error) {
      if (isStatusError(error, 0x6982) || isPinRetryStatus(error)) throw new Error('PIN verification required for the selected PIV signing key.', { cause: error });
      throw error;
    }
  }
}

function slotInspection(metadata: PivSlotMetadata): YubiKeySlotInspection {
  const publicKey = metadata.publicKeyTemplate === undefined ? undefined : parsePublicKey(metadata.publicKeyTemplate);
  return {
    slot: metadata.slot as YubiKeySigningSlot,
    status: metadata.status,
    ...(metadata.algorithm === undefined ? {} : { algorithm: algorithmName(metadata.algorithm) }),
    ...(metadata.origin === undefined ? {} : { origin: metadata.origin }),
    ...(metadata.pinPolicy === undefined ? {} : { pinPolicy: metadata.pinPolicy }),
    ...(publicKey === undefined ? {} : { publicKey }),
    ...(metadata.touchPolicy === undefined ? {} : { touchPolicy: metadata.touchPolicy }),
  };
}

function parsePublicKey(data: Buffer): Ed25519PublicKeyHex | undefined {
  if (data.length === 32) return data.toString('hex') as Ed25519PublicKeyHex;
  try {
    const values = parseAllTlvsStrict(data);
    if (values.length !== 1) return undefined;
    const item = values[0]!;
    if (item.tag === 0x86 && item.value.length === 32) return item.value.toString('hex') as Ed25519PublicKeyHex;
    return item.tag === 0x7f49 ? parsePublicKey(item.value) : undefined;
  } catch {
    return undefined;
  }
}

function parseGeneratedPublicKey(data: Buffer): Ed25519PublicKeyHex | undefined {
  try {
    const values = parseAllTlvsStrict(data);
    return values.length === 1 && values[0]!.tag === 0x7f49 ? parsePublicKey(values[0]!.value) : undefined;
  } catch {
    return undefined;
  }
}

/** Builds the PIV GENERAL AUTHENTICATE payload for Ed25519 signing. */
export function buildEd25519SignData(digest: Buffer): Buffer {
  return tlv(0x7c, Buffer.concat([tlv(0x82, Buffer.alloc(0)), tlv(0x81, digest)]));
}

/** Extracts a 64-byte Ed25519 signature from a PIV GENERAL AUTHENTICATE response. */
export function parseEd25519SignatureResponse(data: Buffer): Buffer {
  let outer;
  try {
    const values = parseAllTlvsStrict(data);
    outer = values.length === 1 && values[0]!.tag === 0x7c ? values[0] : undefined;
  } catch {
    outer = undefined;
  }
  if (outer === undefined) throw new Error('YubiKey returned a malformed Ed25519 signature response.');
  let inner;
  try {
    const values = parseAllTlvsStrict(outer.value);
    inner = values.length === 1 ? values[0] : undefined;
  } catch {
    inner = undefined;
  }
  if (inner?.tag !== 0x82 || inner.value.length !== 64) throw new Error('YubiKey returned a malformed Ed25519 signature value.');
  return inner.value;
}

function algorithmName(value: number): string {
  if (value === ALGORITHM_ED25519) return 'Ed25519';
  if (value === 0xe1) return 'X25519';
  if (value === 0x11) return 'ECCP256';
  if (value === 0x14) return 'ECCP384';
  return `0x${value.toString(16)}`;
}

function firmwareSupportsEd25519(version: string | undefined): boolean {
  if (version === undefined) return false;
  const [major = 0, minor = 0, patch = 0] = version.split('.').map(Number);
  return major > 5 || (major === 5 && (minor > 7 || minor === 7 && patch >= 4));
}
