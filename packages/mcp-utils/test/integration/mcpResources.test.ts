import {
  InMemoryTransport,
  LATEST_PROTOCOL_VERSION,
  McpServer,
  type JSONRPCMessage,
} from '@modelcontextprotocol/server';
import { describe, expect, it, vi } from 'vitest';

import { ResourceSubscriptionManager, bindResourceSubscriptions, registerMcpResources } from '../../src/resources.js';

function rpc(transport: InMemoryTransport, request: JSONRPCMessage): Promise<JSONRPCMessage> {
  return new Promise((resolve, reject) => {
    transport.onmessage = (message) => {
      if ('id' in message && message.id === (request as { id: number }).id) resolve(message);
    };
    void transport.send(request).catch(reject);
  });
}

describe('shared MCP SDK boundary', () => {
  it('serves reads and one exact stdio subscription without leaking callback errors', async () => {
    const globals = [
      {
        name: 'keys',
        uri: 'ccd://keys',
        title: 'Keys',
        description: 'Runtime key status.',
        subscribable: true,
        read: (uri: string) => ({ uri, mimeType: 'application/json', text: '{"keys":[]}' }),
      },
      {
        name: 'unsafe',
        uri: 'ccd://unsafe',
        title: 'Unsafe',
        description: 'Failure.',
        read: () => {
          throw new Error('/Users/operator/.config/ccd/secret.json');
        },
      },
    ];
    const server = new McpServer({ name: 'test', version: '0.0.0' });
    const manager = new ResourceSubscriptionManager({
      registrations: [],
      globals: [{ name: 'keys', uri: 'ccd://keys' }],
      notify: (uri) => server.server.sendResourceUpdated({ uri }),
    });
    registerMcpResources(server, globals);
    bindResourceSubscriptions(server, manager, { transport: 'stdio' });
    const [client, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    try {
      const initialized = await rpc(client, {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: LATEST_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'test', version: '0.0.0' },
        },
      });
      expect(initialized).toMatchObject({ result: { capabilities: { resources: { subscribe: true } } } });
      await client.send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
      let id = 1;
      const request = (method: string, params: Record<string, unknown>) =>
        rpc(client, { jsonrpc: '2.0', id: ++id, method, params });

      const read = await request('resources/read', { uri: 'ccd://keys' });
      expect(read).toMatchObject({ result: { contents: [{ text: '{"keys":[]}' }] } });
      const failure = await request('resources/read', { uri: 'ccd://unsafe' });
      expect(failure).toMatchObject({
        error: {
          code: -32603,
          message: 'The resource could not be read.',
          data: { error: { code: 'RESOURCE_READ_FAILED' } },
        },
      });

      await request('resources/subscribe', { uri: 'ccd://keys' });
      const updated: JSONRPCMessage[] = [];
      client.onmessage = (message) => {
        updated.push(message);
      };
      manager.invalidate({ resourceName: 'keys' });
      await vi.waitFor(() =>
        expect(updated).toContainEqual(
          expect.objectContaining({
            method: 'notifications/resources/updated',
            params: { uri: 'ccd://keys' },
          }),
        ),
      );
      await request('resources/unsubscribe', { uri: 'ccd://keys' });
      client.onmessage = (message) => {
        updated.push(message);
      };
      manager.invalidate({ resourceName: 'keys' });
      await Promise.resolve();
      expect(updated).toHaveLength(1);
    } finally {
      await server.close();
    }
  });
});
