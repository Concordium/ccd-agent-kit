import { Buffer } from 'node:buffer';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createPivTransport, PivDeviceNotFoundError } from '../../src/index.js';
import type { PcscReader, Pcsclite } from '../../src/types.js';

type NativeCallback = (error: Error | null, data: Buffer) => void;

class Reader extends EventEmitter implements PcscReader {
  close = vi.fn();
  connect = vi.fn((_options: { share_mode?: number }, done: (error: Error | null, protocol: number) => void) => done(null, 1));
  disconnect = vi.fn((_disposition: number, done: (error: Error | null) => void) => done(null));
  transmit = vi.fn((command: Buffer, _length: number, _protocol: number, done: NativeCallback) => this.exchange(command, done));

  constructor(
    readonly name: string,
    private readonly exchange: (command: Buffer, done: NativeCallback) => void = serialExchange(1),
  ) { super(); }
}

function serialExchange(serial: number) {
  return (command: Buffer, done: NativeCallback) => {
    const data = command[1] === 0xf8
      ? Buffer.from(serial.toString(16).padStart(8, '0') + '9000', 'hex')
      : Buffer.from('9000', 'hex');
    done(null, data);
  };
}

function harness(discoveryWaitMs = 2_000) {
  const context = Object.assign(new EventEmitter(), { close: vi.fn() }) satisfies Pcsclite;
  const factory = vi.fn(() => context);
  const loader = vi.fn(async () => factory);
  const transport = createPivTransport({ discoveryWaitMs, factoryLoader: loader });
  return { context, factory, loader, transport };
}

async function tick(ms = 0) {
  await vi.advanceTimersByTimeAsync(ms);
  await Promise.resolve();
}

describe('explicit serial discovery timing', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('returns the operation result as soon as the matching serial responds', async () => {
    const h = harness();
    const reader = new Reader('matching reader', serialExchange(42));
    const operation = vi.fn(async card => card.readerName);
    const pending = h.transport.withSelectedCard('42', operation);

    await tick();
    h.context.emit('reader', reader);
    await tick();

    expect(operation).toHaveBeenCalledOnce();
    await expect(pending).resolves.toBe(reader.name);
    expect(vi.getTimerCount()).toBe(0);
    expect(h.context.listenerCount('reader')).toBe(0);
    expect(h.context.listenerCount('error')).toBe(0);
  });

  it('probes arriving readers independently so a stalled reader cannot delay a later match', async () => {
    const h = harness();
    let releaseStalled!: NativeCallback;
    const stalled = new Reader('stalled reader', (_command, done) => { releaseStalled = done; });
    const matching = new Reader('matching reader', serialExchange(7));
    const operation = vi.fn(async card => card.readerName);
    let result: string | undefined;
    const pending = h.transport.withSelectedCard('7', operation).then(value => { result = value; });

    await tick();
    h.context.emit('reader', stalled);
    await tick(1);
    h.context.emit('reader', matching);
    await tick();

    expect(result).toBe(matching.name);
    expect(operation).toHaveBeenCalledOnce();
    releaseStalled(null, Buffer.from('9000', 'hex'));
    await tick();
    expect(stalled.transmit).toHaveBeenCalledOnce();
    await pending;
  });

  it('uses the first exact match without waiting for a later duplicate', async () => {
    const h = harness();
    const first = new Reader('first', serialExchange(9));
    const duplicate = new Reader('duplicate', serialExchange(9));
    let result: string | undefined;
    void h.transport.withSelectedCard('9', async card => card.readerName).then(value => { result = value; }, () => undefined);

    await tick();
    h.context.emit('reader', first);
    await tick();
    const resultAtFirstResponse = result;
    h.context.emit('reader', duplicate);
    await tick(100);
    expect(resultAtFirstResponse).toBe(first.name);
    expect(duplicate.connect).not.toHaveBeenCalled();
  });

  it.each([false, true])('preserves operation options on the early selected path (skip disconnect: %s)', async skipFinalDisconnect => {
    const h = harness();
    const reader = new Reader('matching reader', serialExchange(12));
    const onResponse = vi.fn();
    let result: string | undefined;
    void h.transport.withSelectedCard('12', async card => card.readerName, {
      disconnectDisposition: 2,
      exclusive: true,
      onResponse,
      skipFinalDisconnect,
    }).then(value => { result = value; }, () => undefined);

    await tick();
    h.context.emit('reader', reader);
    await tick();

    expect(result).toBe(reader.name);
    expect(reader.connect).toHaveBeenCalledWith({ share_mode: 1 }, expect.any(Function));
    expect(onResponse).toHaveBeenCalledTimes(2);
    if (skipFinalDisconnect) expect(reader.disconnect).not.toHaveBeenCalled();
    else expect(reader.disconnect).toHaveBeenCalledWith(2, expect.any(Function));
  });

  it('skips a shared-mode connection failure and still accepts a later exact match', async () => {
    const h = harness();
    const failed = new Reader('unavailable reader');
    failed.connect.mockImplementation((_options, done) => done(new Error('unavailable'), 0));
    const matching = new Reader('matching reader', serialExchange(13));
    let result: string | undefined;
    void h.transport.withSelectedCard('13', async card => card.readerName)
      .then(value => { result = value; }, () => undefined);

    await tick();
    h.context.emit('reader', failed);
    h.context.emit('reader', matching);
    await tick();

    expect(result).toBe(matching.name);
    expect(failed.connect).toHaveBeenCalledWith({ share_mode: 2 }, expect.any(Function));
  });

  it('surfaces an exclusive sharing violation instead of choosing another reader', async () => {
    const h = harness();
    const busyFailure = Object.assign(new Error('busy'), { code: 'SCARD_E_SHARING_VIOLATION' });
    const busy = new Reader('busy reader');
    busy.connect.mockImplementation((_options, done) => done(busyFailure, 0));
    const matching = new Reader('other matching reader', serialExchange(14));
    const operation = vi.fn();
    let failure: unknown;
    void h.transport.withSelectedCard('14', operation, { exclusive: true })
      .catch(error => { failure = error; });

    await tick();
    h.context.emit('reader', busy);
    await tick();
    h.context.emit('reader', matching);
    await tick();

    expect(failure).toBe(busyFailure);
    expect(operation).not.toHaveBeenCalled();
    expect(matching.connect).not.toHaveBeenCalled();
  });

  it('does not apply the discovery deadline to an operation after an exact match', async () => {
    const h = harness();
    const reader = new Reader('matching reader', serialExchange(11));
    let finish!: (value: string) => void;
    const operation = vi.fn(() => new Promise<string>(resolve => { finish = resolve; }));
    let settled = false;
    const pending = h.transport.withSelectedCard('11', operation).finally(() => { settled = true; });

    await tick();
    h.context.emit('reader', reader);
    await tick();
    expect(operation).toHaveBeenCalledOnce();
    await tick(5_000);
    expect(settled).toBe(false);
    finish('complete');
    await expect(pending).resolves.toBe('complete');
  });

  it('starts the discovery interval only after asynchronous factory creation', async () => {
    const context = Object.assign(new EventEmitter(), { close: vi.fn() }) satisfies Pcsclite;
    let finishLoading!: (factory: () => Pcsclite) => void;
    const loader = vi.fn(() => new Promise<() => Pcsclite>(resolve => { finishLoading = resolve; }));
    const transport = createPivTransport({ discoveryWaitMs: 2_000, factoryLoader: loader });
    let failure: unknown;
    const pending = transport.withSelectedCard('4', async () => undefined).catch(error => { failure = error; });

    await tick(5_000);
    expect(failure).toBeUndefined();
    finishLoading(() => context);
    await tick();
    await tick(1_999);
    expect(failure).toBeUndefined();
    await tick(1);
    expect(failure).toBeInstanceOf(PivDeviceNotFoundError);
    await pending;
  });

  it('waits through nonmatches, non-PIV cards and unreadable serials before rejecting', async () => {
    const h = harness();
    const operation = vi.fn();
    const other = new Reader('other serial', serialExchange(2));
    const nonPiv = new Reader('non-PIV', (_command, done) => done(null, Buffer.from('6a82', 'hex')));
    const unreadable = new Reader('unreadable serial', (command, done) => {
      done(null, Buffer.from(command[1] === 0xf8 ? '6d00' : '9000', 'hex'));
    });
    let failure: unknown;
    const pending = h.transport.withSelectedCard('1', operation).catch(error => { failure = error; });

    await tick();
    for (const reader of [other, nonPiv, unreadable]) h.context.emit('reader', reader);
    await tick(1_999);
    expect(failure).toBeUndefined();
    expect(operation).not.toHaveBeenCalled();
    await tick(1);
    expect(failure).toBeInstanceOf(PivDeviceNotFoundError);
    expect(failure).toMatchObject({ message: 'YubiKey 1 not found.' });
    await pending;
  });

  it('keeps full-window discovery for withCards and serial-less selection', async () => {
    for (const selected of [false, true]) {
      const h = harness();
      const reader = new Reader('only reader', serialExchange(3));
      const operation = vi.fn(async () => 'complete');
      const pending = selected
        ? h.transport.withSelectedCard(undefined, operation)
        : h.transport.withCards(operation);
      await tick();
      h.context.emit('reader', reader);

      await tick(1_999);
      expect(operation).not.toHaveBeenCalled();
      await tick(1);
      await expect(pending).resolves.toBe('complete');
    }
  });

  it('times out a stalled APDU without invoking the operation after the native callback arrives', async () => {
    const h = harness();
    let release!: NativeCallback;
    const reader = new Reader('stalled APDU', (_command, done) => { release = done; });
    const operation = vi.fn();
    let failure: unknown;
    const pending = h.transport.withSelectedCard('5', operation).catch(error => { failure = error; });

    await tick();
    h.context.emit('reader', reader);
    await tick(2_000);
    const failureAtDeadline = failure;
    release(null, Buffer.from('9000', 'hex'));
    await tick();

    expect(failureAtDeadline).toBeInstanceOf(PivDeviceNotFoundError);
    expect(operation).not.toHaveBeenCalled();
    expect(reader.transmit).toHaveBeenCalledOnce();
    expect(reader.disconnect).toHaveBeenCalledOnce();
    expect(reader.close).toHaveBeenCalledOnce();
    expect(h.context.close).toHaveBeenCalledOnce();
    await pending;
  });

  it('times out a stalled connect and cleans up a connection that completes later', async () => {
    const h = harness();
    const reader = new Reader('stalled connect');
    let finishConnect!: (error: Error | null, protocol: number) => void;
    reader.connect.mockImplementation((_options, done) => { finishConnect = done; });
    const operation = vi.fn();
    let failure: unknown;
    const pending = h.transport.withSelectedCard('6', operation).catch(error => { failure = error; });

    await tick();
    h.context.emit('reader', reader);
    await tick(2_000);
    const failureAtDeadline = failure;
    finishConnect(null, 1);
    await tick();

    expect(failureAtDeadline).toBeInstanceOf(PivDeviceNotFoundError);
    expect(operation).not.toHaveBeenCalled();
    expect(reader.transmit).not.toHaveBeenCalled();
    expect(reader.disconnect).toHaveBeenCalledOnce();
    expect(reader.close).toHaveBeenCalledOnce();
    expect(h.context.close).toHaveBeenCalledOnce();
    await pending;
  });
});
