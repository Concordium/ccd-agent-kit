import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  parseJsonCliValue,
  readHiddenLine,
  readProcessStdin,
  validateCliOptions,
} from '../../src/index.js';

describe('CLI argument helpers', () => {
  it('validates parsed options and reports first schema issue', () => {
    const schema = z.object({ count: z.coerce.number().int().positive('count must be positive') });

    expect(validateCliOptions(schema, { count: '2' })).toEqual({ count: 2 });
    expect(() => validateCliOptions(schema, { count: '0' })).toThrow('count must be positive');
  });

});

describe('CLI value helpers', () => {
  it('parses JSON values and maps parse failures to caller usage errors', () => {
    const usageError = (message: string) => new Error(`usage: ${message}`);

    expect(parseJsonCliValue('{"enabled":true}', 'bad json', usageError)).toEqual({ enabled: true });
    expect(() => parseJsonCliValue('{', 'bad json', usageError)).toThrow('usage: bad json');
  });

  it('reads process stdin as utf8 text', async () => {
    const originalStdin = process.stdin;
    Object.defineProperty(process, 'stdin', { configurable: true, value: Readable.from(['hello', Buffer.from(' world')]) });
    try {
      await expect(readProcessStdin()).resolves.toBe('hello world');
    } finally {
      Object.defineProperty(process, 'stdin', { configurable: true, value: originalStdin });
    }
  });
});

describe('readHiddenLine', () => {
  it('rejects non-interactive input before prompting', async () => {
    const input = new FakeHiddenInput(false);
    const output = { write: vi.fn() };

    await expect(readHiddenLine(input, output, 'Secret: ', 'interactive required')).rejects.toThrow('interactive required');
    expect(output.write).not.toHaveBeenCalled();
  });

  it.each([
    { chunk: 'secx\u007fret  \n', raw: true },
    { chunk: Buffer.from('secx\u007fret  \r'), raw: false },
  ])('reads secret input and restores raw mode $raw', async ({ chunk, raw }) => {
    const input = new FakeHiddenInput(true, raw);
    const output = { write: vi.fn() };
    const result = readHiddenLine(input, output, 'Secret: ');

    input.emit('data', chunk);

    await expect(result).resolves.toBe('secret');
    expect(input.rawModes).toEqual([true, raw]);
    expect(input.resume).toHaveBeenCalledOnce();
    expect(input.pause).toHaveBeenCalledOnce();
    expect(input.listenerCount('data')).toBe(0);
    expect(input.listenerCount('error')).toBe(0);
    expect(output.write).toHaveBeenCalledWith('Secret: ');
    expect(output.write).toHaveBeenCalledWith('\n');
  });

  it('rejects on Ctrl-C and stream errors after cleanup', async () => {
    const cancelled = new FakeHiddenInput(true);
    const cancelledResult = readHiddenLine(cancelled, { write: vi.fn() }, 'Secret: ');
    cancelled.emit('data', '\u0003');
    await expect(cancelledResult).rejects.toThrow('Private-key entry cancelled.');
    expect(cancelled.listenerCount('data')).toBe(0);

    const failed = new FakeHiddenInput(true);
    const failedResult = readHiddenLine(failed, { write: vi.fn() }, 'Secret: ');
    failed.isTTY = false;
    failed.emit('error', new Error('terminal failed'));
    await expect(failedResult).rejects.toThrow('terminal failed');
    expect(failed.listenerCount('error')).toBe(0);
    expect(failed.rawModes).toEqual([true]);
    expect(failed.pause).toHaveBeenCalledOnce();
  });
});

class FakeHiddenInput extends EventEmitter {
  public readonly pause = vi.fn();
  public readonly resume = vi.fn();
  public readonly rawModes: boolean[] = [];

  public constructor(
    public isTTY: boolean,
    public isRaw = false,
  ) {
    super();
  }

  public setRawMode(mode: boolean): void {
    this.rawModes.push(mode);
    this.isRaw = mode;
  }
}
