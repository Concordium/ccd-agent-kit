import {
  InMemoryTransport,
  LATEST_PROTOCOL_VERSION,
  type JSONRPCMessage,
} from '@modelcontextprotocol/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createMcpServer } from '../../../src/mcp/server.js';

let client: InMemoryTransport;
let server: ReturnType<typeof createMcpServer>;
let requestId = 0;

function rpc(method: string, params: Record<string, unknown>): Promise<JSONRPCMessage> {
  const id = ++requestId;
  return new Promise((resolve, reject) => {
    client.onmessage = (message) => {
      if ('id' in message && message.id === id) resolve(message);
    };
    void client.send({ jsonrpc: '2.0', id, method, params }).catch(reject);
  });
}

describe('signer MCP skill boundary', () => {
  beforeAll(async () => {
    server = createMcpServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = clientTransport;
    await server.connect(serverTransport);
    await rpc('initialize', {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'signer-skills-test', version: '0' },
    });
    await client.send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
  });

  afterAll(async () => server.close());

  it('serves the signer skills through the MCP extension methods', async () => {
    const listResponse = await rpc('skills/list', {});
    expect(listResponse).toMatchObject({
      result: {
        skills: expect.arrayContaining([
          expect.objectContaining({
            frontmatter: expect.objectContaining({ name: 'ccd-network-discovery' }),
          }),
          expect.objectContaining({
            frontmatter: expect.objectContaining({ name: 'ccd-signer-key-discovery' }),
          }),
        ]),
      },
    });

    const getResponse = await rpc('skills/get', {
      uri: 'skill://ccd-signer-key-discovery/SKILL.md',
    });
    expect(getResponse).toMatchObject({
      result: { skill: { frontmatter: { name: 'ccd-signer-key-discovery' } } },
    });

    const missingResponse = await rpc('skills/get', { uri: 'skill://missing/SKILL.md' });
    expect(missingResponse).toMatchObject({ error: { code: -32602 } });
  });
});
