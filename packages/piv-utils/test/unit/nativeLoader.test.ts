import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('pcsclite', () => { throw new Error('Cannot load /sensitive/local/native.node'); });

import { createPivTransport } from '../../src/index.js';

describe('lazy native loading', () => {
  afterEach(() => { vi.doUnmock('pcsclite'); vi.resetModules(); });

  it('reports an actionable failure without leaking native-loader paths', async () => {
    const transport = createPivTransport();
    const operation = vi.fn();
    const error = await transport.withCards(operation).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('PC/SC support is unavailable');
    expect((error as Error).message).not.toContain('/sensitive');
    expect((error as Error).cause).toBeUndefined();
    expect(operation).not.toHaveBeenCalled();
  });

  it('loads the native default factory lazily and closes the empty context', async () => {
    const context = Object.assign(new EventEmitter(), { close: vi.fn() });
    const factory = vi.fn(() => context);
    vi.doMock('pcsclite', () => ({ default: factory }));
    vi.resetModules();
    const { createPivTransport: create } = await import('../../src/transport.js');
    const transport = create({ discoveryWaitMs: 1 });
    expect(factory).not.toHaveBeenCalled();
    await expect(transport.withCards(cards => cards.length)).resolves.toBe(0);
    expect(factory).toHaveBeenCalledOnce();
    expect(context.close).toHaveBeenCalledOnce();
  });

  it('rejects an invalid native export without exposing loader details', async () => {
    vi.doMock('pcsclite', () => ({ default: {} }));
    vi.resetModules();
    const { createPivTransport: create } = await import('../../src/transport.js');
    await expect(create().withCards(() => undefined)).rejects.toThrow('PC/SC support is unavailable');
  });
});
