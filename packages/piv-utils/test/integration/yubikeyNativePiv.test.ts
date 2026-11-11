import { Buffer } from 'node:buffer';
import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildEd25519SignData,
  createNativePivYubiKeyService,
  createNativePivYubiKeyServiceForTesting,
  type YubiKeyService,
} from '../../src/index.js';
import type { Ed25519PrivateKeyHex, Ed25519PublicKeyHex } from '../../src/yubikeyService.js';

const testEd25519PublicKey = (byteHex: string) => byteHex.repeat(32) as Ed25519PublicKeyHex;
const testEd25519PrivateKey = (byteHex: string) => byteHex.repeat(32) as Ed25519PrivateKeyHex;
const TEST_PUBLIC_KEY_AB = testEd25519PublicKey('ab');
const TEST_PUBLIC_KEY_CD = testEd25519PublicKey('cd');

const PUBLIC_KEY = TEST_PUBLIC_KEY_AB;
const IMPORT_PUBLIC_KEY = TEST_PUBLIC_KEY_CD;
const PRIVATE_KEY = testEd25519PrivateKey('11');
const SIGNATURE = 'ef'.repeat(64);

describe('native PIV APDU service', () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
  it('keeps generation diagnostics silent by default', async () => {
    vi.stubEnv('CCD_SIGNER_YUBIKEY_GENERATE_DIAGNOSTICS', '');
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    await createFakeNativeService({ emptyInitialSlot: true }).service.generateEd25519Key(generationInput());
    expect(stderr).not.toHaveBeenCalled();
  });

  it('reports only fixed generation stages when diagnostics are enabled', async () => {
    vi.stubEnv('CCD_SIGNER_YUBIKEY_GENERATE_DIAGNOSTICS', '1');
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    await createFakeNativeService({ emptyInitialSlot: true }).service.generateEd25519Key(generationInput());
    expect(stderr.mock.calls.map(([line]) => line)).toEqual([
      '[yubikey-generate] management-authentication started\n', '[yubikey-generate] management-authentication succeeded\n',
      '[yubikey-generate] pin-verification started\n', '[yubikey-generate] pin-verification succeeded\n',
      '[yubikey-generate] key-generation started\n', '[yubikey-generate] key-generation succeeded\n',
    ]);
  });
  it('reboots after a mutating key command but not after a pre-mutation guard', async () => {
    const generated = createFakeNativeService({ emptyInitialSlot: true });
    await generated.service.generateEd25519Key(generationInput());
    expect(generated.reader.commands).toEqual(expect.arrayContaining([
      '00a4040008a00000052747111700',
      '001c000003020c0000',
    ]));

    const guarded = createFakeNativeService();
    const guardError = await guarded.service.generateEd25519Key({ ...generationInput(), slot: '9c' }).catch(value => value);
    expect(guardError).toMatchObject({ message: expect.stringContaining('occupied') });
    expect(guardError).not.toHaveProperty('mutation');
    expect(guarded.reader.commands.some(command => command.startsWith('001c'))).toBe(false);
  });

  it.each([false, true])('restores initial PIN verification=%s after mutation reboot', async (initiallyVerified) => {
    const { reader, service } = createFakeNativeService({ emptyInitialSlot: true, initiallyPinVerified: initiallyVerified });
    const input = generationInput();
    input.interaction.promptPin = vi.fn(async () => '123456');

    await service.generateEd25519Key(input);

    expect(input.interaction.promptPin).toHaveBeenCalledOnce();
    expect(reader.commands.filter(command => command.startsWith('001c'))).toHaveLength(1);
    expect(reader.commands.filter(command => command.startsWith('00200080') && command.length > 10)).toHaveLength(initiallyVerified ? 2 : 1);
    expect(reader.commands.filter(command => command === '0020ff8000')).toHaveLength(initiallyVerified ? 0 : 1);
  });

  it('preserves a mutating APDU failure and reports reboot failure facts without retrying', async () => {
    const { reader, service } = createFakeNativeService({ emptyInitialSlot: true, generateStatus: 0x6982, rebootStatus: 0x6985 });

    const error = await service.generateEd25519Key(generationInput()).catch(value => value);

    expect(error).toMatchObject({ status: 0x6982, mutation: {
      attempted: true, confirmed: false, rebootFailed: true, restorationFailed: false,
    } });
    expect(reader.commands.filter(command => command.startsWith('0047'))).toHaveLength(1);
    expect(reader.commands.filter(command => command.startsWith('001c'))).toHaveLength(1);
  });
  it('lists and inspects PIV devices through APDUs', async () => {
    const { reader, service } = createFakeNativeService();

    await expect(service.listDevices()).resolves.toEqual([
      {
        firmwareVersion: '5.8.0',
        readerName: 'YubiKey 5C',
        serial: '12345678',
      },
    ]);
    await expect(service.inspectDevice('12345678')).resolves.toMatchObject({
      ed25519Supported: true,
      firmwareVersion: '5.8.0',
      slots: expect.arrayContaining([
        expect.objectContaining({ algorithm: 'Ed25519', publicKey: PUBLIC_KEY, slot: '9c', status: 'occupied' }),
        { slot: '82', status: 'empty' },
      ]),
    });

    expect(reader.commands).toContain('00a404000ba00000030800001000010000');
    expect(reader.commands).toContain('00f8000000');
    expect(reader.commands).toContain('00f7009c00');
    expect(reader.commands).not.toContain('001d000000');
    expect(reader.disconnectDispositions).toContain(0);
  });

  it('reuses and closes a persistent device session for inspection and signing', async () => {
    const reader = new FakeReader();
    const { service } = createFakeNativeServiceWithReaders([reader], true);

    await expect(service.listDevices()).resolves.toHaveLength(1);
    await expect(service.listAndInspectDeviceKeys(['12345678'])).resolves.toMatchObject({ inspections: [{ serial: '12345678' }] });
    await expect(service.inspectDevice('12345678')).resolves.toMatchObject({ serial: '12345678' });
    await expect(service.signEd25519Digest({
      digest: Buffer.from('aa'.repeat(32), 'hex'),
      devices: [{ kind: 'yubikey', serial: '12345678', slot: '9c' }],
      publicKey: PUBLIC_KEY,
    })).resolves.toEqual({ signatureHex: SIGNATURE });
    const metadataReadsAfterFirstSign = reader.commands.filter(command => command.startsWith('00f7009c')).length;
    await expect(service.signEd25519Digest({
      digest: Buffer.from('bb'.repeat(32), 'hex'),
      devices: [{ kind: 'yubikey', serial: '12345678', slot: '9c' }],
      publicKey: PUBLIC_KEY,
    })).resolves.toEqual({ signatureHex: SIGNATURE });
    await service.close?.();

    expect(reader.commands.filter(command => command.startsWith('00f7009c'))).toHaveLength(metadataReadsAfterFirstSign);
    expect(reader.disconnectDispositions).toContain(0);
  });

  it('does not load native hardware bindings while constructing public services', async () => {
    await createNativePivYubiKeyService().close?.();
    await createNativePivYubiKeyService({ persistent: true }).close?.();
  });
  it('generates, imports, unlocks, and signs through expected APDUs', async () => {
    const { reader, service } = createFakeNativeService({ emptyInitialSlot: true });
    const promptPin = async () => '123456';
    const promptManagementKey = async () => '01'.repeat(24);
    const confirm = async () => true;

    await expect(
      service.generateEd25519Key({
        force: false,
        interaction: { confirm, promptManagementKey, promptPin },
        pinPolicy: 'once',
        serial: '12345678',
        slot: '9c',
        touchPolicy: 'never',
      }),
    ).resolves.toMatchObject({ publicKey: PUBLIC_KEY, replacedExistingKey: false, serial: '12345678', slot: '9c' });

    await expect(
      service.importEd25519Key({
        force: false,
        interaction: { confirm, promptManagementKey, promptPin },
        pinPolicy: 'always',
        privateKeyHex: PRIVATE_KEY,
        publicKey: IMPORT_PUBLIC_KEY,
        serial: '12345678',
        slot: '82',
        touchPolicy: 'cached',
      }),
    ).resolves.toMatchObject({ publicKey: IMPORT_PUBLIC_KEY, replacedExistingKey: false, slot: '82' });

    await expect(service.unlockDevice({ interaction: { promptPin }, serial: '12345678' })).resolves.toMatchObject({ serial: '12345678' });
    await expect(
      service.signEd25519Digest({
        digest: Buffer.from('aa'.repeat(32), 'hex'),
        devices: [{ kind: 'yubikey', serial: '12345678', slot: '9c' }],
        publicKey: PUBLIC_KEY,
      }),
    ).resolves.toEqual({ signatureHex: SIGNATURE });

    expect(reader.commands).toContain('0020008008313233343536ffff00');
    expect(reader.commands.some((command) => command.startsWith('0047009c0bac098001e0aa0102ab010100'))).toBe(true);
    expect(reader.commands.some((command) => command.startsWith('00fee0822801201111111111111111111111111111111111111111111111111111111111111111aa0103ab010300'))).toBe(true);
    expect(reader.commands.some((command) => command.startsWith(`0087e09c26${buildEd25519SignData(Buffer.from('aa'.repeat(32), 'hex')).toString('hex')}00`))).toBe(true);
    expect(reader.disconnectDispositions).toContain(0);
  });

  it('watches PC/SC reader status, end, and error events for device changes', async () => {
    const reader = new FakeReader();
    const { service } = createFakeNativeServiceWithReaders([reader]);
    const errors: string[] = [];
    let changes = 0;

    const watcher = await service.watchDevices?.({
      onChanged: () => { changes += 1; },
      onError: (error) => errors.push(error.message),
    });
    await tick();
    expect(changes).toBe(1);

    reader.emit('status', { state: 0x0020 });
    expect(changes).toBe(2);
    reader.emit('status', { state: 0x0122 });
    reader.emit('status', { state: 0x0022 });
    reader.emit('status', { state: 0x0020 });
    expect(changes).toBe(2);
    reader.emit('status', { state: 0x0012 });
    expect(changes).toBe(3);
    reader.emit('status', { state: 0x0010 });
    expect(changes).toBe(3);
    reader.emit('status', { state: 0x0022 });
    expect(changes).toBe(4);
    reader.emit('error', new Error('reader failed'));
    reader.emit('end');

    expect(changes).toBe(6);
    expect(errors).toEqual(['reader failed']);
    await watcher?.close();
  });
});
interface FakeNativeOptions {
  initiallyPinVerified?: boolean;
  managementChallenge?: string;
  managementFinal?: string;
  generateStatus?: number;
  generateError?: Error;
  connectError?: boolean;
  closeError?: boolean;
  deviceInfoStatus?: number;
  disconnectError?: boolean;
  emptyInitialSlot?: boolean;
  importPublicKey?: string;
  malformedGeneratedPublicKey?: boolean;
  malformedResponseForIns?: number;
  malformedSignature?: boolean;
  managementSuccessAlgorithms?: number[];
  metadataStatus?: number;
  pinQueryStatus?: number;
  pinStatus?: number;
  pcscError?: Error;
  requirePivSelectedForPivCommands?: boolean;
  requirePinForSigning?: boolean;
  rebootStatus?: number;
  selectPivStatus?: number;
  serial?: string;
  serialStatus?: number;
  signStatus?: number;
  signStatusSequence?: number[];
  slotPublicKey?: string;
  firmwareVersion?: [number, number, number];
  versionStatus?: number;
}

function createFakeNativeService(options: FakeNativeOptions = {}): { reader: FakeReader; service: YubiKeyService } {
  const reader = new FakeReader(options);
  const service = createFakeNativeServiceWithReaders([reader]).service;
  return { reader, service };
}

function createFakeNativeServiceWithReaders(readers: FakeReader[], persistent = false): { service: YubiKeyService } {
  const service = createNativePivYubiKeyServiceForTesting(() => {
    const pcsc = new FakePcsc();
    process.nextTick(() => {
      for (const reader of readers) {
        if (reader.options.pcscError) pcsc.emit('error', reader.options.pcscError);
        else pcsc.emit('reader', reader);
      }
    });
    return pcsc;
  }, 1, persistent);
  return { service };
}

class FakePcsc extends EventEmitter {
  close(): void {}
}

class FakeReader extends EventEmitter {
  public commands: string[] = [];
  public disconnectDispositions: number[] = [];
  public closeCount = 0;
  public name = 'YubiKey 5C';
  private selectedApplet?: 'management' | 'piv';
  private pinVerified = false;
  private signAttempts = 0;
  private slotKeys = new Map<string, string>();

  constructor(public readonly options: FakeNativeOptions = {}) {
    super();
    if (!options.emptyInitialSlot) this.slotKeys.set('9c', options.slotPublicKey ?? PUBLIC_KEY);
    this.pinVerified = options.initiallyPinVerified ?? false;
  }

  close(): void {
    this.closeCount += 1;
    if (this.options.closeError) throw new Error('close failed');
  }

  connect(_options: { share_mode?: number }, callback: (error: Error | null, protocol: number) => void): void {
    if (this.options.connectError) {
      callback(new Error('connect failed'), 0);
      return;
    }
    if (this.disconnectDispositions.length > 0) this.pinVerified = false;
    callback(null, 1);
  }

  disconnect(disposition: number, callback: (error: Error | null) => void): void {
    this.disconnectDispositions.push(disposition);
    this.pinVerified = false;
    if (this.options.disconnectError) {
      callback(new Error('disconnect failed'));
      return;
    }
    callback(null);
  }

  transmit(command: Buffer, _responseLength: number, _protocol: number, callback: (error: Error | null, data: Buffer) => void): void {
    this.commands.push(command.toString('hex'));
    if (command[1] === 0x47 && this.options.generateError !== undefined) {
      callback(this.options.generateError, Buffer.alloc(0));
      return;
    }
    if (command[1] === this.options.malformedResponseForIns) {
      callback(null, Buffer.from([0x90]));
      return;
    }
    callback(null, this.response(command));
  }

  private response(command: Buffer): Buffer {
    const ins = command[1];
    if (ins === 0xa4 && command.subarray(5, command.length - 1).toString('hex') === 'a000000308000010000100') {
      if ((this.options.selectPivStatus ?? 0x9000) === 0x9000) this.selectedApplet = 'piv';
      return status(this.options.selectPivStatus ?? 0x9000);
    }
    if (ins === 0xa4) {
      if (command.subarray(5, command.length - 1).toString('hex') === 'a000000527471117') this.selectedApplet = 'management';
      return ok();
    }
    if (ins === 0xf8) return this.options.serialStatus === undefined ? ok(serialBytes(this.options.serial ?? '12345678')) : status(this.options.serialStatus);
    if (this.options.requirePivSelectedForPivCommands && (ins === 0xfd || ins === 0xf7) && this.selectedApplet !== 'piv') return status(0x6985);
    if (ins === 0xfd) return this.options.versionStatus === undefined ? ok(Buffer.from(this.options.firmwareVersion ?? [5, 8, 0])) : status(this.options.versionStatus);
    if (ins === 0x1d) return this.options.deviceInfoStatus === undefined ? ok(Buffer.from('0401030503050800', 'hex')) : status(this.options.deviceInfoStatus);
    if (ins === 0x1c) return status(this.options.rebootStatus ?? 0x9000);
    if (ins === 0xf7) return this.metadataResponse(command[3]!);
    if (ins === 0x20) {
      if (command[2] === 0xff) {
        this.pinVerified = false;
        return ok();
      }
      if (command.length === 5) return status(this.pinVerified ? 0x9000 : (this.options.pinQueryStatus ?? 0x63c3));
      const pinStatus = this.options.pinStatus ?? 0x9000;
      if (pinStatus === 0x9000) this.pinVerified = true;
      return status(pinStatus);
    }
    if (ins === 0x47) {
      if (this.options.generateStatus !== undefined) return status(this.options.generateStatus);
      this.slotKeys.set(slotName(command[3]!), PUBLIC_KEY);
      return ok(this.options.malformedGeneratedPublicKey ? Buffer.from('7f4900', 'hex') : Buffer.from(`7f49228620${PUBLIC_KEY}`, 'hex'));
    }
    if (ins === 0xfe) {
      this.slotKeys.set(slotName(command[3]!), this.options.importPublicKey ?? IMPORT_PUBLIC_KEY);
      return ok();
    }
    if (ins === 0x87 && command[2] === 0xe0) {
      const signStatus = this.options.signStatusSequence?.[this.signAttempts++];
      if (signStatus !== undefined) return status(signStatus);
      if (this.options.signStatus !== undefined) return status(this.options.signStatus);
      if (this.options.requirePinForSigning && !this.pinVerified) return status(0x6982);
      return ok(this.options.malformedSignature ? Buffer.from('7c03820100', 'hex') : Buffer.from(`7c428240${SIGNATURE}`, 'hex'));
    }
    if (ins === 0x87) return this.managementAuthResponse(command);
    throw new Error(`unexpected APDU ${command.toString('hex')}`);
  }

  private metadataResponse(slot: number): Buffer {
    if (this.options.metadataStatus !== undefined) return status(this.options.metadataStatus);
    const key = this.slotKeys.get(slotName(slot));
    if (key === undefined) return status(0x6a88);
    return ok(Buffer.from(`0101e00202020103010104228620${key}`, 'hex'));
  }

  private managementAuthResponse(command: Buffer): Buffer {
    const allowed = this.options.managementSuccessAlgorithms ?? [0x0a];
    if (!allowed.includes(command[2]!)) return status(0x6982);
    const data = command.subarray(5, command.length - 1);
    if (data[2] === 0x81) return ok(Buffer.from(this.options.managementChallenge ?? `7c128110${'22'.repeat(16)}`, 'hex'));
    return ok(Buffer.from(this.options.managementFinal ?? '', 'hex'));
  }
}

function generationInput() {
  return {
    serial: '12345678', slot: '85' as const, pinPolicy: 'never' as const, touchPolicy: 'never' as const, force: false,
    interaction: { promptPin: async () => '123456', promptManagementKey: async () => '11'.repeat(24), confirm: async () => false },
  };
}

async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function ok(data = Buffer.alloc(0)): Buffer {
  return Buffer.concat([data, Buffer.from('9000', 'hex')]);
}

function status(value: number): Buffer {
  const data = Buffer.alloc(2);
  data.writeUInt16BE(value);
  return data;
}

function serialBytes(value: string): Buffer<ArrayBuffer> {
  const data = Buffer.alloc(4);
  data.writeUInt32BE(Number(value));
  return data;
}

function slotName(value: number): string {
  return value.toString(16).padStart(2, '0');
}
