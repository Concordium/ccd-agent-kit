import type { Buffer } from 'node:buffer';
import type { EventEmitter } from 'node:events';

/** Neutral PIV PIN verification policy; consumers enforce their own slot policy. */
export type PivPinPolicy = 'never' | 'once' | 'always';

/** Neutral PIV physical-touch policy; cached touch is distinct from always. */
export type PivTouchPolicy = 'never' | 'cached' | 'always';

/** Current device-wide PIV application PIN security status. */
export type PivPinStatus =
  | { status: 'verified' }
  | { status: 'required'; retries: number }
  | { status: 'blocked' };

/** Creates a PC/SC context. Injectable factories do not load native bindings. */
export type PcscliteFactory = () => Pcsclite;

/** Native event context emitting reader and error events; owned by one operation or watcher. */
export interface Pcsclite extends EventEmitter {
  /** Releases the native context after listeners and readers are cleaned up. */
  close(): void;
}

/** Injectable native reader boundary; never exposed on a scoped card session. */
export interface PcscReader extends EventEmitter {
  /** Safe human-readable reader name, not a sensitive local path. */
  name: string;
  /** Releases reader resources. */
  close(): void;
  /** Connects in shared mode 2 or explicitly requested exclusive mode 1. */
  connect(options: { share_mode?: number }, callback: (error: Error | null, protocol: number) => void): void;
  /** Ends a connection using the requested PC/SC disposition. */
  disconnect(disposition: number, callback: (error: Error | null) => void): void;
  /** Exchanges an APDU with the connected protocol. Buffers may contain secrets. */
  transmit(data: Buffer, responseLength: number, protocol: number, callback: (error: Error | null, data: Buffer) => void): void;
}

/** Reader status event; present/empty bits drive device-change notifications. */
export interface PcscReaderStatus {
  /** Native PC/SC state bitmask. */
  state: number;
}

/** Scheme-neutral metadata; unsupported status must not be confused with confirmed absence. */
export interface PivSlotMetadata {
  /** Hexadecimal PIV slot identifier; no signer-specific allowlist is applied. */
  slot: string;
  /** Only confirmed absence is empty; unsupported observations are unknown. */
  status: 'empty' | 'occupied' | 'unknown';
  /** Raw algorithm byte, including algorithms unknown to consumers. */
  algorithm?: number;
  /** Complete tag-04 value, with all nested public-key template bytes preserved. */
  publicKeyTemplate?: Buffer;
  /** Observed key provenance, retaining unsupported values as unknown. */
  origin?: 'generated' | 'imported' | 'unknown';
  /** Recognized PIN policy, absent for unsupported policy bytes. */
  pinPolicy?: PivPinPolicy;
  /** Recognized touch policy, absent for unsupported policy bytes. */
  touchPolicy?: PivTouchPolicy;
}

/** Connection owned by one callback; callers must not retain it beyond native cleanup. */
export interface PivCardSession {
  /** Safe reader name; native handles and protocol are intentionally private. */
  readonly readerName: string;
  /** Selects the PIV application. */
  selectPiv(): Promise<void>;
  /** Reads the card serial as a decimal string. */
  getSerial(): Promise<string>;
  /** Reads the firmware version as a dotted string. */
  getVersion(): Promise<string>;
  /** Reads device facts; may change applet, so consumers must reselect PIV. */
  getDeviceInfo(): Promise<{ formFactor?: string; model?: string }>;
  /** Reads strict TLV metadata; malformed payloads reject rather than returning partial data. */
  getSlotMetadata(slot: string): Promise<PivSlotMetadata>;
  /** Tries default AES-192/TDES then caller-supplied keys; never logs or persists secrets. */
  authenticateManagementKey(prompt: () => Promise<string>): Promise<void>;
  /** Verifies a caller-provided PIN using the original eight-byte padding/truncation behavior. */
  verifyPin(prompt: () => Promise<string>): Promise<void>;
  /** Queries device PIN status without consuming a retry. */
  getPinStatus(): Promise<PivPinStatus>;
  /** Clears device PIN verification without disconnecting or changing retries. */
  clearPinVerification(): Promise<void>;
  /** Requests a full YubiKey reboot through the management applet. The card will disconnect. */
  reboot(): Promise<void>;
  /** Exchanges a raw APDU with original signer status handling; no implicit buffer clearing. Not tool-facing. */
  transmit(command: Buffer, responseLength: number): Promise<Buffer>;
  /** Disconnects using the supplied disposition, as in the committed signer implementation. */
  disconnect(disposition: number): Promise<void>;
}

/** Result of one P-256 agreement operation. Ownership of the secret transfers to the caller. */
export interface P256AgreementResult {
  /** Canonical uncompressed SEC1 public key used by this operation. */
  publicKey: Uint8Array;
  /** Fixed-width 32-byte ECDH x coordinate, including leading zeroes. */
  sharedSecret: Buffer;
}

/** Public boundary implemented by a P-256 hardware agreement provider. */
export interface P256Agreement {
  /** Performs agreement with one canonical uncompressed SEC1 peer point. */
  agree(peerPublicKey: Uint8Array): Promise<P256AgreementResult>;
}

/** Payload-free description of one TLV frame observed at the start of an APDU response. */
export interface PivResponseFrame {
  /** Outer frame is depth 0; its first nested frame, when present, is depth 1. */
  readonly depth: 0 | 1;
  /** Encoded BER-TLV tag represented as an unsigned number. */
  readonly tag: number;
  /** Declared value length when a complete supported length header was present. */
  readonly declaredLength?: number;
  /** Whether the observed response contained the complete declared frame. */
  readonly complete: boolean;
}

/** Safe, payload-free APDU response metadata emitted before status handling. */
export interface PivResponseObservation {
  /** Total native response size, including status bytes when present. */
  readonly responseByteCount: number;
  /** Response data size excluding status bytes; absent when no complete status exists. */
  readonly dataByteCount?: number;
  /** Numeric APDU status; absent when the native response is shorter than two bytes. */
  readonly status?: number;
  /** At most the outer and first nested TLV frame; never contains response values. */
  readonly framing: readonly PivResponseFrame[];
}

/** Connection and cleanup choices for one scoped operation; no fallback or retry is implicit. */
export interface PivOperationOptions {
  /** Requests exclusive mode 1 with surfaced sharing violations; shared mode 2 retains original failed-reader skipping. */
  exclusive?: boolean;
  /** Final disconnect disposition; defaults to SCARD_LEAVE_CARD (0). */
  disconnectDisposition?: number;
  /** Omits final native disconnect while still releasing reader/context resources. */
  skipFinalDisconnect?: boolean;
  /** Observes payload-free response metadata before status handling; callback failures are ignored. */
  onResponse?: (observation: PivResponseObservation) => void | Promise<void>;
  /** Ends a pending callback when the selected reader reports card removal. */
  endOnRemoval?: boolean;
}

/** Factory injection and discovery timing; native pcsclite loads lazily only when needed. */
export interface CreatePivTransportInput {
  /** Resolves a native or deterministic test factory. */
  factoryLoader?: () => Promise<PcscliteFactory>;
  /** Reader discovery deadline in milliseconds, measured after native factory and context creation. */
  discoveryWaitMs?: number;
}

/** Device notifications without signer inventory or readiness policy. */
export interface WatchPivDevicesInput {
  /** Called on reader arrival, card present/empty, removal, or recoverable reader error. */
  onChanged: () => void;
  /** Receives native errors without secret material. */
  onError?: (error: Error) => void;
}

/** Closeable device watcher owning its listeners, readers and native context. */
export interface PivDeviceWatcher {
  /** Releases resources and stops future notifications. */
  close(): void;
}

/** Shared neutral transport; consumers must honor callback lifetime and must not retain sessions. */
export interface PivTransport {
  /** Discovers cards in one pass and cleans up connections/readers/context using lifted signer semantics. */
  withCards<T>(callback: (cards: PivCardSession[]) => Promise<T> | T, options?: PivOperationOptions): Promise<T>;
  /** Selects the first exact explicit serial immediately; without a serial, waits the full window and rejects zero or ambiguous matches. */
  withSelectedCard<T>(serial: string | undefined, callback: (card: PivCardSession) => Promise<T>, options?: PivOperationOptions): Promise<T>;
  /** Starts notifications without connecting cards; close removes native listeners and resources. */
  watchDevices(input: WatchPivDevicesInput): Promise<PivDeviceWatcher>;
}

/** Process-owned shared card connections that preserve device state until closed. */
export interface PivSessionPool {
  /** Runs serialized work on a shared connection retained for the selected serial. */
  withCard<T>(serial: string, callback: (card: PivCardSession) => Promise<T>): Promise<T>;
  /** Opens and retains a shared connection without running card work. */
  retain(serial: string): Promise<void>;
  /** Releases one retained connection after queued work completes; unknown serials are ignored. */
  release(serial: string): Promise<void>;
  /** Releases all retained connections. */
  close(): Promise<void>;
}
