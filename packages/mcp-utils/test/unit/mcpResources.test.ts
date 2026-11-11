import { ProtocolErrorCode, type McpServer, type ResourceTemplate } from '@modelcontextprotocol/server';
import { describe, expect, it, vi } from 'vitest';

import {
  NetworkResourceError,
  ResourceSubscriptionManager,
  bindResourceSubscriptions,
  mcpInvalidArgument,
  registerMcpResources,
  type BoundMcpResourceDefinition,
} from '../../src/resources.js';

function definition(uri: string): BoundMcpResourceDefinition {
  return {
    name: uri.includes('{') ? 'templated' : 'static',
    uri,
    title: 'Resource',
    description: 'A resource.',
    mimeType: 'application/json',
    read: (requested) => ({ uri: requested, mimeType: 'application/json', text: '{"ok":true}' }),
    list: () => [{ uri: 'ccd://mainnet/accounts', name: 'Mainnet accounts' }],
    complete: () => ['mainnet'],
  };
}

function registrations(definitions: BoundMcpResourceDefinition[]) {
  const calls: unknown[][] = [];
  registerMcpResources(
    {
      registerResource: (...args: unknown[]) => {
        calls.push(args);
      },
    } as unknown as McpServer,
    definitions,
  );
  return calls;
}

function raises(error: unknown): () => never {
  return () => {
    throw error;
  };
}

describe('registerMcpResources', () => {
  it('delegates static reads and template discovery callbacks', async () => {
    const calls = registrations([
      definition('ccd://{network}/accounts'),
      { ...definition('ccd://{network}/disabled'), list: undefined, complete: undefined },
    ]);
    const read = calls[0]![3] as (uri: URL) => Promise<unknown>;
    await expect(read(new URL('ccd://mainnet/accounts'))).resolves.toEqual({
      contents: [{ uri: 'ccd://mainnet/accounts', mimeType: 'application/json', text: '{"ok":true}' }],
    });
    const template = calls[0]![1] as ResourceTemplate;
    await expect(Promise.resolve(template.listCallback?.({} as never))).resolves.toEqual({
      resources: [{ uri: 'ccd://mainnet/accounts', name: 'Mainnet accounts' }],
    });
    await expect(Promise.resolve(template.completeCallback('network')?.('m'))).resolves.toEqual(['mainnet']);
    const disabled = calls[1]![1] as ResourceTemplate;
    expect(disabled.listCallback).toBeUndefined();
    expect(disabled.completeCallback('network')).toBeUndefined();
  });

  it('maps every callback kind through one stable public error policy', async () => {
    const calls = registrations([
      {
        ...definition('ccd://invalid'),
        read: raises(mcpInvalidArgument('Invalid selector.')),
      },
      {
        ...definition('ccd://{network}/known'),
        list: raises(new NetworkResourceError('RESOURCE_NOT_FOUND', 'The resource was not found.')),
      },
      {
        ...definition('ccd://{network}/unknown'),
        complete: raises(new Error('/Users/operator/private-callback')),
      },
    ]);
    const callbacks = [
      () => (calls[0]![3] as (uri: URL) => Promise<unknown>)(new URL('ccd://invalid')),
      () => Promise.resolve((calls[1]![1] as ResourceTemplate).listCallback?.({} as never)),
      () => Promise.resolve((calls[2]![1] as ResourceTemplate).completeCallback('network')?.('private')),
    ];
    const expected = [
      { code: ProtocolErrorCode.InvalidParams, data: { kind: 'invalid-argument' } },
      { code: ProtocolErrorCode.InvalidParams, data: { error: { code: 'RESOURCE_NOT_FOUND' } } },
      {
        code: ProtocolErrorCode.InternalError,
        data: { error: { code: 'RESOURCE_READ_FAILED' } },
        message: 'The resource could not be read.',
      },
    ];
    for (const [index, callback] of callbacks.entries())
      await expect(callback()).rejects.toMatchObject(expected[index]!);
  });
});

describe('bindResourceSubscriptions', () => {
  it('installs stdio handlers, preserves close, and leaves HTTP untouched', async () => {
    const handlers = new Map<string, (request: { uri: string }) => Promise<unknown>>();
    let capabilities: unknown;
    let priorClosed = 0;
    const protocol = {
      registerCapabilities: (value: unknown) => {
        capabilities = value;
      },
      setRequestHandler: (
        method: string,
        _schema: unknown,
        handler: (request: { uri: string }) => Promise<unknown>,
      ) => {
        handlers.set(method, handler);
      },
      onclose: () => {
        priorClosed += 1;
      },
    };
    const manager = new ResourceSubscriptionManager({ registrations: [], globals: [], notify: vi.fn() });
    const subscribe = vi.spyOn(manager, 'subscribe').mockResolvedValue();
    const unsubscribe = vi.spyOn(manager, 'unsubscribe').mockResolvedValue();
    const close = vi.spyOn(manager, 'close');
    bindResourceSubscriptions({ server: protocol } as unknown as McpServer, manager, { transport: 'stdio' });
    expect(capabilities).toEqual({ resources: { subscribe: true } });
    await handlers.get('resources/subscribe')!({ uri: 'ccd://keys' });
    await handlers.get('resources/unsubscribe')!({ uri: 'ccd://keys' });
    expect(subscribe).toHaveBeenCalledWith('ccd://keys');
    expect(unsubscribe).toHaveBeenCalledWith('ccd://keys');
    protocol.onclose();
    expect(priorClosed).toBe(1);
    expect(close).toHaveBeenCalledOnce();

    const http = { registerCapabilities: vi.fn(), setRequestHandler: vi.fn() };
    bindResourceSubscriptions({ server: http } as unknown as McpServer, manager, { transport: 'http' });
    expect(http.registerCapabilities).not.toHaveBeenCalled();
    expect(http.setRequestHandler).not.toHaveBeenCalled();
  });
});
