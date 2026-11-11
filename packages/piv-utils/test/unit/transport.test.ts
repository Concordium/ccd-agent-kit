import { Buffer } from 'node:buffer';
import { createCipheriv } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

import { ApduStatusError, createPivSessionPool, createPivTransport, PivDeviceNotFoundError, withPivPinVerified } from '../../src/index.js';
import type { PcscReader, Pcsclite, PivCardSession, PivTransport } from '../../src/types.js';

// A scripted transport boundary, not a second signer/device emulator.
class Reader extends EventEmitter implements PcscReader {
  name = 'Test PIV reader';
  close = vi.fn();
  connectError: Error | null = null;
  respond: (command: Buffer) => Buffer = () => Buffer.from('9000', 'hex');
  connect = vi.fn((_: { share_mode?: number }, callback: (error: Error | null, protocol: number) => void) => callback(this.connectError, 1));
  disconnect = vi.fn((_: number, callback: (error: Error | null) => void) => callback(null));
  transmit = vi.fn((data: Buffer, _: number, protocol: number, callback: (error: Error | null, data: Buffer) => void) => {
    expect(protocol).toBe(1);
    callback(null, this.respond(data));
  });
}

function setup(readers = [new Reader()]) {
  const context = Object.assign(new EventEmitter(), { close: vi.fn() }) satisfies Pcsclite;
  const factory = vi.fn(() => {
    setTimeout(() => readers.forEach((reader) => context.emit('reader', reader)), 0);
    return context;
  });
  const loader = vi.fn(async () => factory);
  const transport = createPivTransport({ factoryLoader: loader, discoveryWaitMs: 5 });
  return { context, factory, loader, transport, reader: readers[0]! };
}

function response(hex: string, status = '9000') { return Buffer.from(hex + status, 'hex'); }

function fakePoolTransport() {
  const card = {
    readerName: 'Structural PIV card',
    selectPiv: vi.fn(async () => {}),
    getSerial: vi.fn(async () => '12345678'),
    getVersion: vi.fn(async () => '5.8.0'),
    getDeviceInfo: vi.fn(async () => ({})),
    getSlotMetadata: vi.fn(async (slot: string) => ({ slot, status: 'empty' as const })),
    authenticateManagementKey: vi.fn(async (_prompt: () => Promise<string>) => {}),
    verifyPin: vi.fn(async (_prompt: () => Promise<string>) => {}),
    getPinStatus: vi.fn(async () => ({ status: 'required' as const, retries: 3 })),
    clearPinVerification: vi.fn(async () => {}),
    reboot: vi.fn(async () => {}),
    transmit: vi.fn(async (_command: Buffer, _responseLength: number) => Buffer.alloc(0)),
    disconnect: vi.fn(async (_disposition: number) => {}),
  } satisfies PivCardSession;
  const selectedSerials: string[] = [];
  const transport = {
    withCards: <T>(callback: (cards: PivCardSession[]) => Promise<T> | T): Promise<T> =>
      Promise.resolve(callback([card])),
    async withSelectedCard<T>(serial: string | undefined, callback: (selected: PivCardSession) => Promise<T>): Promise<T> {
      selectedSerials.push(serial ?? '');
      try {
        return await callback(card);
      } finally {
        await card.disconnect(0);
      }
    },
    watchDevices: vi.fn(async () => ({ close() {} })),
  } satisfies PivTransport;
  return { card, selectedSerials, transport };
}

describe('scoped PC/SC transport', () => {
  it('loads lazily, defaults shared, returns callback result and releases all resources', async () => {
    const { reader, context, loader, transport } = setup();
    expect(loader).not.toHaveBeenCalled();
    await expect(transport.withCards((cards) => {
      expect(cards).toHaveLength(1);
      expect(cards[0]!.readerName).toBe(reader.name);
      return 42;
    })).resolves.toBe(42);
    expect(reader.connect.mock.calls[0]![0]).toEqual({ share_mode: 2 });
    expect(reader.disconnect.mock.calls[0]![0]).toBe(0);
    expect(reader.close).toHaveBeenCalledOnce();
    expect(context.close).toHaveBeenCalledOnce();
    expect(context.listenerCount('reader')).toBe(0);
    expect(context.listenerCount('error')).toBe(0);
  });

  it('handles context errors during a pending callback and removes listeners afterward', async () => {
    const { context, transport } = setup();
    await expect(transport.withCards(async () => {
      await Promise.resolve();
      expect(() => context.emit('error', new Error('native context failed'))).not.toThrow();
      return 'complete';
    })).resolves.toBe('complete');
    expect(context.listenerCount('reader')).toBe(0);
    expect(context.listenerCount('error')).toBe(0);
    expect(context.close).toHaveBeenCalledOnce();
  });

  it('uses exclusive mode only when requested and preserves callback errors', async () => {
    const { reader, context, transport } = setup();
    const failure = new Error('callback failed');
    await expect(transport.withCards(async () => { throw failure; }, { exclusive: true, disconnectDisposition: 2 })).rejects.toBe(failure);
    expect(reader.connect.mock.calls[0]![0]).toEqual({ share_mode: 1 });
    expect(reader.disconnect.mock.calls[0]![0]).toBe(2);
    expect(reader.close).toHaveBeenCalledOnce();
    expect(context.close).toHaveBeenCalledOnce();
  });

  it.each([false, true])('preserves the operation failure when context cleanup fails: %s', async operationFails => {
    const { context, transport } = setup();
    const operationFailure = new Error('operation failed');
    const cleanupFailure = new Error('context close failed');
    context.close.mockImplementation(() => { throw cleanupFailure; });
    const operation = () => {
      if (operationFails) throw operationFailure;
      return 'complete';
    };
    await expect(transport.withCards(operation)).rejects.toBe(operationFails ? operationFailure : cleanupFailure);
  });

  it('preserves sharing failure identity without retry or callback even when cleanup fails', async () => {
    const { reader, context, transport } = setup();
    const failure = Object.assign(new Error('busy'), { code: 'SCARD_E_SHARING_VIOLATION' });
    reader.connectError = failure;
    context.close.mockImplementation(() => { throw new Error('context close failed'); });
    const callback = vi.fn();
    await expect(transport.withCards(callback, { exclusive: true })).rejects.toBe(failure);
    expect(callback).not.toHaveBeenCalled();
    expect(reader.connect).toHaveBeenCalledOnce();
    expect(reader.close).toHaveBeenCalledOnce();
    expect(context.close).toHaveBeenCalledOnce();
  });

  it('ignores absent cards without fabricating a session', async () => {
    const { reader, transport } = setup();
    reader.connectError = new Error('no card');
    await expect(transport.withCards((cards) => cards.length)).resolves.toBe(0);
    expect(reader.disconnect).not.toHaveBeenCalled();
  });

  it('retains the original explicit-disconnect behavior without an added session-state machine', async () => {
    const { reader, transport } = setup();
    let retained!: PivCardSession;
    await transport.withCards(async ([card]) => {
      retained = card!;
      expect(reader.listenerCount('end')).toBe(0);
      reader.emit('end');
      await retained.disconnect(2);
      await retained.disconnect(0);
      await retained.selectPiv();
    });
    const prompt = vi.fn(async () => '123456');
    await retained.verifyPin(prompt);
    expect(prompt).toHaveBeenCalledOnce();
    expect(reader.disconnect).toHaveBeenCalledTimes(3);
  });

  it('leaves session lifetime to callback ownership and honors skip-final-disconnect', async () => {
    for (const skipFinalDisconnect of [false, true]) {
      const { reader, transport } = setup();
      const retained = await transport.withCards(([card]) => card!, { skipFinalDisconnect });
      await retained.selectPiv();
      expect(reader.disconnect).toHaveBeenCalledTimes(skipFinalDisconnect ? 0 : 1);
      expect(reader.close).toHaveBeenCalledOnce();
    }
  });

  it('selects serials in a single pass and rejects absent or ambiguous matches', async () => {
    const first = new Reader();
    const second = new Reader();
    first.respond = (command) => response(command[1] === 0xf8 ? '00000001' : '');
    second.respond = (command) => response(command[1] === 0xf8 ? '00000002' : '');
    const { transport, factory } = setup([first, second]);
    await expect(transport.withSelectedCard('2', (card) => card.getSerial(), { exclusive: true })).resolves.toBe('2');
    expect(factory).toHaveBeenCalledOnce();
    expect(second.connect.mock.calls[0]![0]).toEqual({ share_mode: 1 });
    await expect(transport.withSelectedCard('3', async () => undefined)).rejects.toThrow();
    await expect(transport.withSelectedCard(undefined, async () => undefined)).rejects.toThrow();
  });

  it.each([
    [undefined, 'No YubiKey found.'],
    ['12345678', 'YubiKey 12345678 not found.'],
  ] as const)('uses the typed missing-device error for selector %j', async (serial, message) => {
    const { transport } = setup([]);
    const pending = transport.withSelectedCard(serial, async () => undefined);

    await expect(pending).rejects.toBeInstanceOf(PivDeviceNotFoundError);
    await expect(pending).rejects.toThrow(message);
  });

  it('retains optional selection when the original serial lookup is unavailable', async () => {
    const { reader, transport } = setup();
    reader.respond = command => command[1] === 0xf8 ? response('', '6d00') : response('');
    await expect(transport.withSelectedCard(undefined, async card => card.readerName)).resolves.toBe(reader.name);
    await expect(transport.withSelectedCard('1', async () => undefined)).rejects.toThrow();
  });

  it('closes the native context after a discovery error', async () => {
    const { transport, context } = setup([]);
    const failure = new Error('context failed');
    const pending = transport.withCards(() => undefined);
    setTimeout(() => context.emit('error', failure), 0);
    await expect(pending).rejects.toBe(failure);
    expect(context.close).toHaveBeenCalledOnce();
    expect(context.listenerCount('reader')).toBe(0);
    expect(context.listenerCount('error')).toBe(0);
  });
});

describe('neutral card protocol', () => {
  it('selects PIV and reads serial, firmware and management device facts', async () => {
    const { reader, transport } = setup();
    reader.respond = (command) => response(command[1] === 0xf8 ? '00bc614e' : command[1] === 0xfd ? '050800' : command[1] === 0x1d ? '0401030503050800' : '');
    await transport.withCards(async ([card]) => {
      await card!.selectPiv();
      await expect(card!.getSerial()).resolves.toBe('12345678');
      await expect(card!.getVersion()).resolves.toBe('5.8.0');
      await expect(card!.getDeviceInfo()).resolves.toMatchObject({ formFactor: 'USB-C keychain', model: 'YubiKey 5C' });
    });
    expect(reader.transmit.mock.calls[0]![0].toString('hex')).toBe('00a404000ba00000030800001000010000');
  });

  it('reboots a YubiKey through the management applet write-config command', async () => {
    const { reader, transport } = setup();
    const commands: string[] = [];
    reader.respond = command => { commands.push(command.toString('hex')); return response(''); };
    await transport.withCards(async ([card]) => {
      const reboot = (card as PivCardSession & { reboot(): Promise<void> }).reboot;
      expect(reboot).toBeTypeOf('function');
      await reboot.call(card);
    });
    expect(commands).toEqual([
      '00a4040008a00000052747111700',
      '001c000003020c0000',
    ]);
    expect(reader.connect).toHaveBeenCalledOnce();
  });

  it('reports reboot write failure without retrying the mutation or issuing factory reset', async () => {
    const { reader, transport } = setup();
    const commands: string[] = [];
    reader.respond = command => {
      commands.push(command.toString('hex'));
      return response('', command[1] === 0x1c ? '6982' : '9000');
    };
    await expect(transport.withCards(async ([card]) => card!.reboot())).rejects.toBeInstanceOf(ApduStatusError);
    expect(commands.filter(command => command.startsWith('001c'))).toEqual(['001c000003020c0000']);
    expect(commands).not.toEqual(expect.arrayContaining([expect.stringMatching(/^00fb/)]));
  });

  it('strips success status, propagates numeric failures and rejects truncated responses', async () => {
    const { reader, transport } = setup();
    await transport.withCards(async ([card]) => {
      reader.respond = () => response('aabb');
      await expect(card!.transmit(Buffer.alloc(5), 64)).resolves.toEqual(Buffer.from('aabb', 'hex'));
      reader.respond = () => response('', '6982');
      await expect(card!.transmit(Buffer.alloc(5), 64)).rejects.toMatchObject({ status: 0x6982 });
      await expect(card!.transmit(Buffer.alloc(5), 64)).rejects.toBeInstanceOf(ApduStatusError);
      const truncated = Buffer.from([0x90]);
      reader.respond = () => truncated;
      await expect(card!.transmit(Buffer.alloc(5), 64)).rejects.toThrow();
      expect(truncated).toEqual(Buffer.from([0x90]));
    });
  });

  it('observes malformed and long-form TLV framing without exposing response bytes', async () => {
    const { reader, transport } = setup();
    const observations: unknown[] = [];
    await transport.withCards(async ([card]) => {
      for (const hex of ['9f8180', '7c85', '7c8100']) {
        reader.respond = () => response(hex);
        await card!.transmit(Buffer.alloc(1), 64);
      }
    }, { onResponse: observation => { observations.push(observation); } });
    expect(observations).toEqual([
      { dataByteCount: 3, framing: [{ complete: false, depth: 0, tag: 0x9f8180 }], responseByteCount: 5, status: 0x9000 },
      { dataByteCount: 2, framing: [{ complete: false, depth: 0, tag: 0x7c }], responseByteCount: 4, status: 0x9000 },
      { dataByteCount: 3, framing: [{ complete: true, declaredLength: 0, depth: 0, tag: 0x7c }], responseByteCount: 5, status: 0x9000 },
    ]);
  });

  it('preserves the complete scheme-neutral public template and raw algorithm', async () => {
    const { reader, transport } = setup();
    const publicKeyTemplate = Buffer.from(`864104${'ab'.repeat(64)}`, 'hex');
    reader.respond = () => response(`010111020202030301010443${publicKeyTemplate.toString('hex')}`);
    await transport.withCards(async ([card]) => {
      await expect(card!.getSlotMetadata('9d')).resolves.toEqual({
        slot: '9d', status: 'occupied', algorithm: 0x11, publicKeyTemplate,
        origin: 'generated', pinPolicy: 'once', touchPolicy: 'cached',
      });
    });
  });

  it('distinguishes confirmed empty, unsupported, unknown fields and malformed metadata', async () => {
    const { reader, transport } = setup();
    await transport.withCards(async ([card]) => {
      for (const status of ['6a88', '6a82']) {
        reader.respond = () => response('', status);
        await expect(card!.getSlotMetadata('9d')).resolves.toEqual({ slot: '9d', status: 'empty' });
      }
      reader.respond = () => response('', '6d00');
      await expect(card!.getSlotMetadata('9d')).resolves.toEqual({ slot: '9d', status: 'unknown' });
      reader.respond = () => response('0101990202ffff030103');
      await expect(card!.getSlotMetadata('9d')).resolves.toMatchObject({ algorithm: 0x99, status: 'occupied', origin: 'unknown' });
      for (const malformed of ['0101e00402ff', '0101e002', '0100', '020101', '0300']) {
        reader.respond = () => response(malformed);
        await expect(card!.getSlotMetadata('9d')).rejects.toThrow();
      }
    });
  });

  it('encodes PIN padding and propagates prompt and verification failures', async () => {
    const { reader, transport } = setup();
    await transport.withCards(async ([card]) => {
      let commandHex = '';
      reader.respond = (command) => { commandHex = command.toString('hex'); return response(''); };
      await card!.verifyPin(async () => '123456');
      expect(commandHex).toBe('0020008008313233343536ffff00');
      expect(reader.transmit.mock.calls[0]![0].toString('hex')).toBe(commandHex);
      const failure = new Error('prompt cancelled');
      await expect(card!.verifyPin(async () => { throw failure; })).rejects.toBe(failure);
      reader.respond = () => response('', '63c2');
      await expect(card!.verifyPin(async () => '000000')).rejects.toMatchObject({ status: 0x63c2 });
    });
  });

  it.each(['', '123456789', 'ééééé'])('retains eight-byte PIN truncation and padding for %j', async pin => {
    const { reader, transport } = setup();
    await transport.withCards(async ([card]) => card!.verifyPin(async () => pin));
    const encoded = Buffer.alloc(8, 0xff);
    Buffer.from(pin).copy(encoded, 0, 0, Math.min(Buffer.byteLength(pin), 8));
    expect(reader.transmit.mock.calls[0]![0]).toEqual(
      Buffer.concat([Buffer.from('0020008008', 'hex'), encoded, Buffer.from([0])]),
    );
  });

  it('queries, verifies, restores, and clears device-wide PIN status', async () => {
    const { reader, transport } = setup();
    const statuses = ['63c3', '63c3', '9000', '9000', '9000'];
    reader.respond = command => response('', command[1] === 0x20 ? statuses.shift()! : '9000');
    await transport.withCards(async ([card]) => {
      await expect(card!.getPinStatus()).resolves.toEqual({ status: 'required', retries: 3 });
      await expect(withPivPinVerified(card!, async () => '123456', async () => 42)).resolves.toBe(42);
      await card!.clearPinVerification();
      reader.respond = () => response('');
      await expect(card!.getPinStatus()).resolves.toEqual({ status: 'verified' });
      reader.respond = () => response('', '6983');
      await expect(card!.getPinStatus()).resolves.toEqual({ status: 'blocked' });
      reader.respond = () => response('', '6a80');
      await expect(card!.getPinStatus()).rejects.toThrow('0x6a80');
    });
    expect(reader.transmit.mock.calls.map(call => call[0].toString('hex')).filter(hex => hex.startsWith('0020'))).toEqual([
      '0020008000', '0020008000', '0020008008313233343536ffff00', '0020ff8000', '0020ff8000',
      '0020008000', '0020008000', '0020008000',
    ]);
  });

  it('retains one shared connection until close or removal, then reconnects', async () => {
    const { reader, transport } = setup();
    reader.respond = command => response(command[1] === 0xf8 ? '00bc614e' : '');
    const pool = createPivSessionPool(transport);
    await pool.retain('12345678');
    await expect(pool.withCard('12345678', card => card.getSerial())).resolves.toBe('12345678');
    expect(reader.connect).toHaveBeenCalledOnce();
    expect(reader.disconnect).not.toHaveBeenCalled();
    reader.emit('status', { state: 0x10 });
    await new Promise(resolve => setImmediate(resolve));
    expect(reader.disconnect).toHaveBeenCalledOnce();
    await pool.retain('12345678');
    expect(reader.connect).toHaveBeenCalledTimes(2);
    await pool.close();
    expect(reader.disconnect).toHaveBeenCalledTimes(2);
    expect(reader.disconnect).toHaveBeenLastCalledWith(0, expect.any(Function));
  });

  it('releases one retained serial without closing the pool or other connections', async () => {
    const first = setup();
    first.reader.respond = command => response(command[1] === 0xf8 ? '00bc614e' : '');
    const pool = createPivSessionPool(first.transport);
    await pool.retain('12345678');

    await pool.release('12345678');
    expect(first.reader.disconnect).toHaveBeenCalledOnce();
    await pool.retain('12345678');
    expect(first.reader.connect).toHaveBeenCalledTimes(2);

    await pool.release('87654321');
    await pool.close();
    expect(first.reader.disconnect).toHaveBeenCalledTimes(2);
  });

  it('keeps a replacement session reachable when the released session closes later', async () => {
    const { reader, transport } = setup();
    reader.respond = command => response(command[1] === 0xf8 ? '00bc614e' : '');
    const pool = createPivSessionPool(transport);
    await pool.retain('12345678');
    let unblock!: () => void;
    const blocked = pool.withCard('12345678', async () => new Promise<void>(resolve => { unblock = resolve; }));

    const releasing = pool.release('12345678');
    await pool.retain('12345678');
    expect(reader.connect).toHaveBeenCalledTimes(2);
    unblock();
    await blocked;
    await releasing;

    await pool.withCard('12345678', async () => undefined);
    expect(reader.connect).toHaveBeenCalledTimes(2);
    await pool.close();
    expect(reader.disconnect).toHaveBeenCalledTimes(2);
  });

  it.each([0x0a, 0x03, 0x08, 0x0c])('authenticates management algorithm %i with correct encrypted challenge', async (algorithm) => {
    const { reader, transport } = setup();
    const defaultKey = '010203040506070801020304050607080102030405060708';
    const key = Buffer.from(algorithm === 0x08 ? '11'.repeat(16) : algorithm === 0x0c ? '22'.repeat(32) : defaultKey, 'hex');
    const challenge = Buffer.alloc(algorithm === 3 ? 8 : 16, 0x5a);
    const cipher = createCipheriv(algorithm === 3 ? 'des-ede3' : algorithm === 8 ? 'aes-128-ecb' : algorithm === 12 ? 'aes-256-ecb' : 'aes-192-ecb', key, null);
    cipher.setAutoPadding(false);
    const encrypted = Buffer.concat([cipher.update(challenge), cipher.final()]);
    reader.respond = (command) => {
      if (command[2] !== algorithm) return response('', '6a80');
      if (command[7] === 0x81) return response(`7c${(challenge.length + 2).toString(16).padStart(2, '0')}81${challenge.length.toString(16).padStart(2, '0')}${challenge.toString('hex')}`);
      expect(command.subarray(9, -1)).toEqual(encrypted);
      // Yubico single authentication returns status 9000 with no data on success.
      return response('');
    };
    const prompt = vi.fn(async () => key.toString('hex'));
    await transport.withCards(async ([card]) => card!.authenticateManagementKey(prompt));
    expect(prompt).toHaveBeenCalledTimes(algorithm === 8 || algorithm === 12 ? 1 : 0);
  });

  it('rejects failed authentication and invalid prompted keys without exposing the key', async () => {
    const { reader, transport } = setup();
    reader.respond = () => response('', '6982');
    const prompt = vi.fn(async () => 'not a key');
    await expect(transport.withCards(async ([card]) => card!.authenticateManagementKey(prompt))).rejects.toThrow();
    expect(prompt).toHaveBeenCalledOnce();
  });

  it('does not mistake an empty initial challenge for authentication success', async () => {
    const { reader, transport } = setup();
    reader.respond = () => response('');
    const prompt = vi.fn(async () => '11'.repeat(24));
    await expect(transport.withCards(async ([card]) => card!.authenticateManagementKey(prompt))).rejects.toThrow();
    expect(prompt).toHaveBeenCalledOnce();
  });

  it('still requires a successful status for the final empty authentication response', async () => {
    const { reader, transport } = setup();
    reader.respond = command => command[7] === 0x81
      ? response(`7c128110${'5a'.repeat(16)}`)
      : response('', '6982');
    const prompt = vi.fn(async () => '11'.repeat(24));
    await expect(transport.withCards(async ([card]) => card!.authenticateManagementKey(prompt))).rejects.toThrow();
    expect(prompt).toHaveBeenCalledOnce();
  });

  it.each(['7d00', '7c00', '7c028200'])('rejects a nonempty successful-status final management response %s', async hex => {
    const { reader, transport } = setup();
    reader.respond = command => command[7] === 0x81 ? response(`7c128110${'22'.repeat(16)}`) : response(hex);
    const prompt = vi.fn(async () => '11'.repeat(24));
    await expect(transport.withCards(async ([card]) => card!.authenticateManagementKey(prompt))).rejects.toThrow();
    expect(prompt).toHaveBeenCalledOnce();
  });
});

describe('structural session pool lifecycle', () => {
  it('rejects card work and retain synchronously after awaited close without reconnecting', async () => {
    const fake = fakePoolTransport();
    const pool = createPivSessionPool(fake.transport);
    await pool.retain('12345678');
    await pool.withCard('12345678', async card => card.getVersion());
    await pool.close();
    const callback = vi.fn(async () => undefined);

    expect(() => pool.withCard('12345678', callback)).toThrow('closed');
    expect(() => pool.retain('12345678')).toThrow('closed');
    expect(callback).not.toHaveBeenCalled();
    expect(fake.selectedSerials).toEqual(['12345678']);
    expect(fake.card.disconnect).toHaveBeenCalledOnce();
  });

  it('performs only one cleanup across sequential close calls', async () => {
    const fake = fakePoolTransport();
    const pool = createPivSessionPool(fake.transport);
    await pool.retain('12345678');

    await pool.close();
    await pool.close();

    expect(fake.card.disconnect).toHaveBeenCalledOnce();
  });

  it('first close drains queued work in order and rejects new work while closing', async () => {
    const fake = fakePoolTransport();
    const pool = createPivSessionPool(fake.transport);
    await pool.retain('12345678');
    const events: string[] = [];
    let unblock!: () => void;
    const blocked = pool.withCard('12345678', async () => {
      events.push('first:start');
      await new Promise<void>(resolve => { unblock = resolve; });
      events.push('first:end');
    });
    const queued = pool.withCard('12345678', async () => { events.push('second'); });
    await vi.waitFor(() => expect(events).toEqual(['first:start']));

    const closing = pool.close();
    const callback = vi.fn(async () => undefined);
    expect(() => pool.withCard('12345678', callback)).toThrow('closed');
    expect(() => pool.retain('87654321')).toThrow('closed');
    expect(callback).not.toHaveBeenCalled();
    expect(fake.card.disconnect).not.toHaveBeenCalled();

    unblock();
    await Promise.all([blocked, queued, closing]);
    expect(events).toEqual(['first:start', 'first:end', 'second']);
    expect(fake.card.disconnect).toHaveBeenCalledOnce();
  });

  it('repeated retains share one connection and one release rather than reference counting', async () => {
    const fake = fakePoolTransport();
    const pool = createPivSessionPool(fake.transport);

    await pool.retain('12345678');
    await pool.retain('12345678');
    expect(fake.selectedSerials).toEqual(['12345678']);

    await pool.release('12345678');
    expect(fake.card.disconnect).toHaveBeenCalledOnce();
    await expect(pool.withCard('12345678', async card => card.getSerial())).resolves.toBe('12345678');
    expect(fake.selectedSerials).toEqual(['12345678', '12345678']);
    await pool.close();
    expect(fake.card.disconnect).toHaveBeenCalledTimes(2);
  });
});

describe('device watcher', () => {
  it('notifies changes/errors and removes listeners on close', async () => {
    const { reader, context, transport } = setup();
    const onChanged = vi.fn();
    const onError = vi.fn();
    const watcher = await transport.watchDevices({ onChanged, onError });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(onChanged).toHaveBeenCalledOnce();
    reader.emit('status', { state: 0x20 });
    reader.emit('status', { state: 0x10 });
    const failure = new Error('reader failed');
    reader.emit('error', failure);
    expect(onError).toHaveBeenCalledWith(failure);
    expect(onChanged).toHaveBeenCalledTimes(4);
    watcher.close();
    expect(reader.close).toHaveBeenCalledOnce();
    expect(context.close).toHaveBeenCalledOnce();
    for (const event of ['status', 'end', 'error']) expect(reader.listenerCount(event)).toBe(0);
    expect(context.listenerCount('reader')).toBe(0);
    expect(context.listenerCount('error')).toBe(0);
    reader.emit('status', { state: 0x20 });
    expect(onChanged).toHaveBeenCalledTimes(4);
  });

  it('detaches removed readers and reports context errors', async () => {
    const { reader, context, transport } = setup();
    const onChanged = vi.fn();
    const onError = vi.fn();
    const watcher = await transport.watchDevices({ onChanged, onError });
    await new Promise((resolve) => setTimeout(resolve, 5));
    reader.emit('end');
    for (const event of ['status', 'end', 'error']) expect(reader.listenerCount(event)).toBe(0);
    expect(reader.close).toHaveBeenCalledOnce();
    const failure = new Error('context failure');
    context.emit('error', failure);
    expect(onError).toHaveBeenCalledWith(failure);
    watcher.close();
    expect(reader.close).toHaveBeenCalledOnce();
  });
});
