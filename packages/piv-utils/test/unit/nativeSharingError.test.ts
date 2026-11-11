import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { createPivTransport } from '../../src/index.js';

describe('native pcsclite sharing errors', () => {
  it('surfaces the message-only status emitted by pcsclite instead of treating a busy card as absent', async () => {
    // pcsclite 1.0.1 constructs plain Nan::Error values with the status in the message.
    const failure = new Error('SCardConnect error: Sharing violation.(0x8010000b)');
    const reader = Object.assign(new EventEmitter(), {
      name: 'busy test device',
      close: vi.fn(),
      connect: vi.fn((_options: { share_mode?: number }, callback: (error: Error | null, protocol: number) => void) => {
        callback(failure, 0);
      }),
      disconnect: vi.fn(),
      transmit: vi.fn(),
    });
    const context = Object.assign(new EventEmitter(), { close: vi.fn() });
    const transport = createPivTransport({
      discoveryWaitMs: 1,
      factoryLoader: async () => () => {
        process.nextTick(() => context.emit('reader', reader));
        return context;
      },
    });
    const operation = vi.fn();
    await expect(transport.withCards(operation, { exclusive: true })).rejects.toBe(failure);
    expect(operation).not.toHaveBeenCalled();
    expect(reader.connect).toHaveBeenCalledOnce();
    expect(reader.close).toHaveBeenCalledOnce();
    expect(context.close).toHaveBeenCalledOnce();
  });
});
