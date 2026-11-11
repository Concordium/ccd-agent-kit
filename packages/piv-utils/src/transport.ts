import { Buffer } from 'node:buffer';
import { createCipheriv } from 'node:crypto';
import { promisify } from 'node:util';
import { apdu, tlv, parseSlotMetadata, ApduStatusError, isPinRetryStatus, isStatusError, managementKeyAuthenticationBlockSize } from './codecs.js';
import { decodeDeviceInfo } from './deviceInfo.js';
import { PivDeviceNotFoundError, isPivSharingViolation } from './errors.js';
import type { CreatePivTransportInput, PivTransport, PivOperationOptions, PivResponseFrame, PivResponseObservation, PivCardSession, PivPinStatus, PivSessionPool, PcscliteFactory, Pcsclite, PcscReader, PcscReaderStatus, WatchPivDevicesInput } from './types.js';

const PIV_AID = Buffer.from('a000000308000010000100', 'hex');
const MANAGEMENT_AID = Buffer.from('a000000527471117', 'hex');
const DEFAULT_MANAGEMENT_KEY = '010203040506070801020304050607080102030405060708';

/** Native PIV transport whose callers own each card callback's lifetime. */
export function createPivTransport(input: CreatePivTransportInput = {}): PivTransport {
  return new NativePivTransport(input.factoryLoader ?? loadPcsclite, input.discoveryWaitMs ?? 2_000);
}

/** Retain shared card connections and serialize operations on each selected device. */
export function createPivSessionPool(transport: PivTransport): PivSessionPool {
  const connections = new Map<string, ReturnType<typeof pooledConnection>>();
  let closed = false;
  const get = (serial: string) => {
    if (closed) throw new Error('PIV session pool is closed.');
    let connection = connections.get(serial);
    if (connection === undefined) {
      const created = pooledConnection(transport, serial, () => { if (connections.get(serial) === created) connections.delete(serial); });
      connections.set(serial, created);
      connection = created;
    }
    return connection;
  };
  return {
    withCard: (serial, callback) => get(serial).run(callback),
    retain: serial => get(serial).run(async () => undefined),
    async release(serial) {
      const connection = connections.get(serial);
      if (connection === undefined) return;
      connections.delete(serial);
      await connection.close();
    },
    async close() {
      if (closed) return;
      closed = true;
      const retained = [...connections.values()];
      connections.clear();
      await Promise.all(retained.map(connection => connection.close()));
    },
  };
}

/** Always prove current PIN knowledge for one operation and restore prior locked state. */
export async function withPivPinVerified<T>(
  card: PivCardSession,
  promptPin: () => Promise<string>,
  operation: () => Promise<T>,
  runVerification: (verify: () => Promise<void>) => Promise<void> = verify => verify(),
): Promise<T> {
  let clearVerification = false;
  try {
    await runVerification(async () => {
      const initiallyVerified = (await card.getPinStatus()).status === 'verified';
      await card.verifyPin(promptPin);
      clearVerification = !initiallyVerified;
    });
    return await operation();
  } finally {
    if (clearVerification) await card.clearPinVerification();
  }
}

function pooledConnection(transport: PivTransport, serial: string, onClosed: () => void) {
  let resolveReady!: (card: PivCardSession) => void;
  let rejectReady!: (error: unknown) => void;
  let release!: () => void;
  let tail = Promise.resolve();
  let closing = false;
  const ready = new Promise<PivCardSession>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const released = new Promise<void>(resolve => { release = resolve; });
  const background = transport.withSelectedCard(serial, async card => {
    await card.selectPiv();
    resolveReady(card);
    await released;
  }, { endOnRemoval: true }).then(() => undefined, rejectReady).finally(onClosed);
  return {
    run<T>(operation: (card: PivCardSession) => Promise<T>): Promise<T> {
      if (closing) return Promise.reject(new Error('PIV connection is closing.'));
      const result = tail.then(async () => operation(await ready));
      tail = result.then(() => undefined, () => undefined);
      return result;
    },
    async close(): Promise<void> {
      if (closing) return background;
      closing = true;
      await tail;
      release();
      await background;
    },
  };
}

async function loadPcsclite(): Promise<PcscliteFactory> {
  try {
    const imported = (await import('pcsclite')) as { default?: PcscliteFactory } | PcscliteFactory;
    const factory = typeof imported === 'function' ? imported : imported.default;
    if (typeof factory !== 'function') throw new Error('Invalid native factory.');
    return factory;
  } catch {
    // Native loader errors can contain sensitive local paths; do not forward them.
    throw new Error('PC/SC support is unavailable. Ensure pcsclite is installed and rebuilt for this Node version.');
  }
}

class NativePivTransport implements PivTransport {
  constructor(private readonly factoryLoader: () => Promise<PcscliteFactory>, private readonly discoveryWaitMs: number) {}

  async withCards<T>(callback: (cards: PivCardSession[]) => Promise<T> | T, options: PivOperationOptions = {}): Promise<T> {
    const factory = await this.factoryLoader();
    const pcsc = factory();
    // Discovery handles its own errors; keep later context errors from escaping the operation.
    const onContextError = () => undefined;
    pcsc.on('error', onContextError);
    try {
      const readers: PcscReader[] = [];
      const cards: PivCard[] = [];
      let result!: T;
      try {
        await collectReaders(pcsc, this.discoveryWaitMs, readers);
        for (const reader of readers) {
          try {
            const connect = promisify(reader.connect.bind(reader)) as (options: { share_mode: number }) => Promise<number>;
            const protocol = await connect({ share_mode: options.exclusive === true ? 1 : 2 });
            cards.push(new PivCard(reader.name, reader, protocol, options.onResponse));
          } catch (error) {
            if (options.exclusive === true && isPivSharingViolation(error)) throw error;
            // Preserve absent-card handling from the original signer discovery.
          }
        }
        result = await callback(cards);
      } catch (error) {
        await cleanupCards(pcsc, readers, cards, options, true);
        throw error;
      }
      await cleanupCards(pcsc, readers, cards, options, false);
      return result;
    } finally {
      pcsc.off('error', onContextError);
    }
  }

  async withSelectedCard<T>(serial: string | undefined, callback: (card: PivCardSession) => Promise<T>, options?: PivOperationOptions): Promise<T> {
    if (serial !== undefined) return this.withExplicitSerial(serial, callback, options ?? {});
    return this.withCards(async (cards) => {
      const pivCards: Array<{ card: PivCardSession; serial: string | undefined }> = [];
      for (const card of cards) {
        try {
          await card.selectPiv();
          pivCards.push({ card, serial: await card.getSerial().catch(() => undefined) });
        } catch { /* Ignore non-PIV cards without querying management metadata. */ }
      }
      if (pivCards.length === 0) throw new PivDeviceNotFoundError();
      if (pivCards.length > 1) throw new Error('Multiple YubiKeys found. Use --serial <serial>.');
      return callback(pivCards[0]!.card);
    }, options);
  }

  private async withExplicitSerial<T>(serial: string, callback: (card: PivCardSession) => Promise<T>, options: PivOperationOptions): Promise<T> {
    const factory = await this.factoryLoader();
    const pcsc = factory();
    type Probe = { reader: PcscReader | undefined; card: PivCard | undefined };
    const probes: Probe[] = [];
    let active = true;
    let selected: Probe | undefined;

    const closeReader = (probe: Probe) => {
      const reader = probe.reader;
      probe.reader = undefined;
      if (reader === undefined) return;
      try { reader.close(); } catch { /* best-effort native cleanup */ }
    };
    const cleanupProbe = (probe: Probe) => {
      const card = probe.card;
      probe.card = undefined;
      let disconnect = Promise.resolve();
      if (card !== undefined && options.skipFinalDisconnect !== true) {
        disconnect = card.disconnect(options.disconnectDisposition ?? 0).catch(() => undefined);
      }
      closeReader(probe);
      return disconnect;
    };
    const closeContext = (preserveFailure: boolean) => {
      try { pcsc.close(); } catch (error) { if (!preserveFailure) throw error; }
    };
    const detach = (removeError = true) => {
      clearTimeout(timer);
      pcsc.off('reader', onReader);
      if (removeError) pcsc.off('error', onError);
    };
    const cleanupUnselected = () => {
      for (const probe of probes) if (probe !== selected) void cleanupProbe(probe);
    };

    let resolveSelection!: (probe: Probe) => void;
    let rejectSelection!: (error: unknown) => void;
    const selection = new Promise<Probe>((resolve, reject) => {
      resolveSelection = resolve;
      rejectSelection = reject;
    });
    const fail = (error: unknown) => {
      if (!active) return;
      active = false;
      detach();
      cleanupUnselected();
      closeContext(true);
      rejectSelection(error);
    };
    const probeReader = async (probe: Probe) => {
      try {
        const reader = probe.reader!;
        const connect = promisify(reader.connect.bind(reader)) as (options: { share_mode: number }) => Promise<number>;
        const protocol = await connect({ share_mode: options.exclusive === true ? 1 : 2 });
        probe.card = new PivCard(reader.name, reader, protocol, options.onResponse);
        if (!active) { void cleanupProbe(probe); return; }
        await probe.card.selectPiv();
        if (!active) { void cleanupProbe(probe); return; }
        const foundSerial = await probe.card.getSerial();
        if (!active) { void cleanupProbe(probe); return; }
        if (foundSerial !== serial) return;
        active = false;
        selected = probe;
        detach(false);
        cleanupUnselected();
        resolveSelection(probe);
      } catch (error) {
        if (active && options.exclusive === true && isPivSharingViolation(error)) fail(error);
      }
    };
    function onReader(reader: PcscReader) {
      if (!active) return;
      const probe: Probe = { reader, card: undefined };
      probes.push(probe);
      void probeReader(probe);
    }
    function onError(error: Error) { fail(error); }

    const timer = setTimeout(() => fail(new PivDeviceNotFoundError(serial)), this.discoveryWaitMs);
    pcsc.on('reader', onReader);
    pcsc.on('error', onError);

    const probe = await selection;
    const reader = probe.reader!;
    let onStatus: ((status: PcscReaderStatus) => void) | undefined;
    let onEnd: (() => void) | undefined;
    let onReaderError: (() => void) | undefined;
    const removed = options.endOnRemoval === true
      ? new Promise<never>((_resolve, reject) => {
        const removedError = () => reject(new PivDeviceNotFoundError(serial));
        onStatus = status => { if ((status.state & 0x20) === 0) removedError(); };
        onEnd = removedError;
        onReaderError = removedError;
        reader.on('status', onStatus);
        reader.on('end', onEnd);
        reader.on('error', onReaderError);
      })
      : undefined;
    const detachRemoval = () => {
      if (onStatus !== undefined) reader.off('status', onStatus);
      if (onEnd !== undefined) reader.off('end', onEnd);
      if (onReaderError !== undefined) reader.off('error', onReaderError);
    };
    try {
      const operation = callback(probe.card!);
      const result = removed === undefined ? await operation : await Promise.race([operation, removed]);
      detachRemoval();
      await cleanupProbe(probe);
      detach();
      closeContext(false);
      return result;
    } catch (error) {
      detachRemoval();
      await cleanupProbe(probe);
      detach();
      closeContext(true);
      throw error;
    }
  }

  async watchDevices(input: WatchPivDevicesInput) {
    const factory = await this.factoryLoader();
    const pcsc = factory();
    const cleanup = new Map<PcscReader, () => void>();
    let closed = false;
    const changed = () => { if (!closed) input.onChanged(); };
    const failed = (error: Error) => {
      if (closed) return;
      input.onError?.(error);
      input.onChanged();
    };
    const attach = (reader: PcscReader) => {
      if (closed) return;
      let wasPresent: boolean | undefined;
      const status = (value: PcscReaderStatus) => {
        const present = (value.state & 0x20) !== 0;
        const presenceChanged = wasPresent === undefined || present !== wasPresent;
        wasPresent = present;
        if (presenceChanged) changed();
      };
      const end = () => {
        cleanup.get(reader)?.();
        cleanup.delete(reader);
        try { reader.close(); } catch { /* best-effort native cleanup */ }
        changed();
      };
      reader.on('status', status);
      reader.on('end', end);
      reader.on('error', failed);
      cleanup.set(reader, () => {
        reader.off('status', status);
        reader.off('end', end);
        reader.off('error', failed);
      });
      changed();
    };
    pcsc.on('reader', attach);
    pcsc.on('error', failed);
    return { close() {
      closed = true;
      pcsc.off('reader', attach);
      pcsc.off('error', failed);
      for (const reader of cleanup.keys()) {
        cleanup.get(reader)?.();
        try { reader.close(); } catch { /* best-effort native cleanup */ }
      }
      cleanup.clear();
      pcsc.close();
    } };
  }
}

async function collectReaders(pcsc: Pcsclite, waitMs: number, readers: PcscReader[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const finish = (result: () => void) => {
      clearTimeout(timer);
      pcsc.off('reader', onReader);
      pcsc.off('error', onError);
      result();
    };
    const onReader = (reader: PcscReader) => readers.push(reader);
    const onError = (error: Error) => finish(() => reject(error));
    const timer = setTimeout(() => finish(resolve), waitMs);
    pcsc.on('reader', onReader);
    pcsc.on('error', onError);
  });
}

async function cleanupCards(
  pcsc: Pcsclite,
  readers: PcscReader[],
  cards: PivCard[],
  options: PivOperationOptions,
  preserveFailure: boolean,
): Promise<void> {
  await Promise.all(cards.map(async (card) => {
    try {
      if (options.skipFinalDisconnect !== true) await card.disconnect(options.disconnectDisposition ?? 0);
    } catch { /* Cleanup must preserve operation failures. */ }
  }));
  for (const reader of readers) {
    try { reader.close(); } catch { /* best-effort native cleanup */ }
  }
  try { pcsc.close(); } catch (error) { if (!preserveFailure) throw error; }
}

class PivCard implements PivCardSession {
  readonly #reader: PcscReader;
  readonly #protocol: number;
  constructor(
    public readonly readerName: string,
    reader: PcscReader,
    protocol: number,
    private readonly onResponse?: (observation: PivResponseObservation) => void | Promise<void>,
  ) {
    this.#reader = reader;
    this.#protocol = protocol;
  }
  async selectPiv(): Promise<void> { await this.transmit(apdu(0, 0xa4, 4, 0, PIV_AID), 256); }
  async getSerial(): Promise<string> {
    const data = await this.transmit(apdu(0, 0xf8, 0, 0), 64);
    return data.readUInt32BE(0).toString();
  }
  async getVersion(): Promise<string> { return [...await this.transmit(apdu(0, 0xfd, 0, 0), 16)].join('.'); }
  async getDeviceInfo(): Promise<{ formFactor?: string; model?: string }> {
    await this.transmit(apdu(0, 0xa4, 4, 0, MANAGEMENT_AID), 256);
    const { formFactor, model } = decodeDeviceInfo(await this.transmit(apdu(0, 0x1d, 0, 0), 1024));
    // Preserve the lifted runtime shape, including present-but-undefined facts.
    return { formFactor, model } as { formFactor?: string; model?: string };
  }
  async getSlotMetadata(slot: string) {
    if (!/^[0-9a-f]{2}$/i.test(slot)) throw new Error('Invalid PIV slot.');
    try {
      return parseSlotMetadata(await this.transmit(apdu(0, 0xf7, 0, Number.parseInt(slot, 16)), 512), slot);
    } catch (error) {
      if (isStatusError(error, 0x6a88) || isStatusError(error, 0x6a82)) return { slot, status: 'empty' as const };
      if (error instanceof ApduStatusError) return { slot, status: 'unknown' as const };
      throw error;
    }
  }
  async authenticateManagementKey(prompt: () => Promise<string>): Promise<void> {
    const defaultKey = Buffer.from(DEFAULT_MANAGEMENT_KEY, 'hex');
    if (await this.tryAuthenticate(defaultKey, 0x0a)) return;
    if (await this.tryAuthenticate(defaultKey, 3)) return;
    const prompted = Buffer.from((await prompt()).trim(), 'hex');
    if (prompted.length === 24) {
      if (await this.tryAuthenticate(prompted, 0x0a)) return;
      if (await this.tryAuthenticate(prompted, 3)) return;
    }
    if (prompted.length === 16 && await this.tryAuthenticate(prompted, 8)) return;
    if (prompted.length === 32 && await this.tryAuthenticate(prompted, 12)) return;
    throw new Error('PIV management key authentication failed.');
  }
  async verifyPin(prompt: () => Promise<string>): Promise<void> {
    const pin = await prompt();
    const encoded = Buffer.alloc(8, 0xff);
    Buffer.from(pin, 'utf8').copy(encoded, 0, 0, Math.min(Buffer.byteLength(pin), 8));
    await this.transmit(apdu(0, 0x20, 0, 0x80, encoded), 16);
  }
  async getPinStatus(): Promise<PivPinStatus> {
    try {
      await this.transmit(apdu(0, 0x20, 0, 0x80), 16);
      return { status: 'verified' };
    } catch (error) {
      if (error instanceof ApduStatusError && isPinRetryStatus(error)) {
        return { status: 'required', retries: error.status & 0x0f };
      }
      if (isStatusError(error, 0x6983)) return { status: 'blocked' };
      throw error;
    }
  }
  async clearPinVerification(): Promise<void> {
    await this.transmit(apdu(0, 0x20, 0xff, 0x80), 16);
  }
  async reboot(): Promise<void> {
    await this.transmit(apdu(0, 0xa4, 4, 0, MANAGEMENT_AID), 256);
    await this.transmit(apdu(0, 0x1c, 0, 0, Buffer.from([0x02, 0x0c, 0x00])), 16);
  }
  async disconnect(disposition: number): Promise<void> {
    const disconnect = promisify(this.#reader.disconnect.bind(this.#reader)) as (disposition: number) => Promise<void>;
    await disconnect(disposition);
  }
  async transmit(command: Buffer, responseLength: number): Promise<Buffer> {
    const transmit = promisify(this.#reader.transmit.bind(this.#reader)) as (data: Buffer, length: number, protocol: number) => Promise<Buffer>;
    const response = await transmit(command, responseLength, this.#protocol);
    if (this.onResponse !== undefined) {
      try {
        const pending = this.onResponse(observeResponse(response));
        if (pending !== undefined) void Promise.resolve(pending).catch(() => undefined);
      } catch { /* Observation must not alter, retry or disclose an operation failure. */ }
    }
    if (response.length < 2) {
      throw new Error('YubiKey returned a malformed APDU response.');
    }
    const status = response.readUInt16BE(response.length - 2);
    if (status !== 0x9000) {
      throw new ApduStatusError(status);
    }
    return response.subarray(0, -2);
  }
  private async tryAuthenticate(key: Buffer, algorithm: number): Promise<boolean> {
    try {
      const challengeResponse = await this.managementStep(algorithm, tlv(0x81, Buffer.alloc(0)));
      const size = managementKeyAuthenticationBlockSize(algorithm);
      if (challengeResponse.length !== size + 4 || challengeResponse[0] !== 0x7c
        || challengeResponse[1] !== size + 2 || challengeResponse[2] !== 0x81 || challengeResponse[3] !== size) return false;
      const challenge = challengeResponse.subarray(4);
      const cipher = createCipheriv(algorithm === 3 ? 'des-ede3' : algorithm === 8 ? 'aes-128-ecb' : algorithm === 12 ? 'aes-256-ecb' : 'aes-192-ecb', key, null);
      cipher.setAutoPadding(false);
      const encrypted = Buffer.concat([cipher.update(challenge), cipher.final()]);
      return (await this.managementStep(algorithm, tlv(0x82, encrypted))).length === 0;
    } catch { return false; }
  }
  private async managementStep(algorithm: number, inner: Buffer): Promise<Buffer> {
    return this.transmit(apdu(0, 0x87, algorithm, 0x9b, tlv(0x7c, inner)), 256);
  }
}


function observeResponse(response: Buffer): PivResponseObservation {
  if (response.length < 2) return { framing: [], responseByteCount: response.length };
  const data = response.subarray(0, -2);
  return {
    dataByteCount: data.length,
    framing: observeTlvFraming(data),
    responseByteCount: response.length,
    status: response.readUInt16BE(response.length - 2),
  };
}

function observeTlvFraming(data: Buffer): PivResponseFrame[] {
  const outer = observeTlvFrame(data, 0, 0);
  if (outer === undefined) return [];
  const frames = [outer.frame];
  if (outer.valueOffset < data.length) {
    const nested = observeTlvFrame(data, outer.valueOffset, 1);
    if (nested !== undefined) frames.push(nested.frame);
  }
  return frames;
}

function observeTlvFrame(data: Buffer, offset: number, depth: 0 | 1): { frame: PivResponseFrame; valueOffset: number } | undefined {
  if (offset >= data.length) return undefined;
  let cursor = offset;
  let tag = data[cursor++]!;
  if ((tag & 0x1f) === 0x1f) {
    let continuation = true;
    while (continuation) {
      if (cursor >= data.length || cursor - offset >= 4) return { frame: { complete: false, depth, tag }, valueOffset: data.length };
      const next = data[cursor++]!;
      tag = tag * 0x100 + next;
      continuation = (next & 0x80) !== 0;
    }
  }
  if (cursor >= data.length) return { frame: { complete: false, depth, tag }, valueOffset: data.length };
  const firstLength = data[cursor++]!;
  let declaredLength = firstLength;
  if ((firstLength & 0x80) !== 0) {
    const octets = firstLength & 0x7f;
    if (octets === 0 || octets > 4 || cursor + octets > data.length) {
      return { frame: { complete: false, depth, tag }, valueOffset: data.length };
    }
    declaredLength = 0;
    for (let index = 0; index < octets; index += 1) declaredLength = declaredLength * 0x100 + data[cursor++]!;
  }
  return {
    frame: { complete: cursor + declaredLength <= data.length, declaredLength, depth, tag },
    valueOffset: cursor,
  };
}
