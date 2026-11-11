import { describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/server';
import { createServerFactory } from '../../../../src/mcp/server.js';
import { startHttp } from '../../../../src/mcp/transports/httpTransport.js';
import { FakeConcordiumClient, makeContext } from '../../../helpers/fakes.js';

const ADDRESS = '32dZpZpu929J81XPFPbBxhwdig3v18U8KnBTXK3vrwdhUAk1Bp';

const SSE_ACCEPT = 'application/json, text/event-stream';

async function listenPort(httpServer: Server): Promise<number> {
  const address = httpServer.address();
  if (address === null || typeof address === 'string') throw new Error('Expected a bound TCP address');
  return address.port;
}

/** Extracts JSON-RPC messages (by matching `id`) from an SSE response body. */
async function sseRpc(response: Response, id: number): Promise<Record<string, unknown>> {
  const text = await response.text();
  const messages = text
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .filter((line) => line.includes('"jsonrpc"'))
    .map((line) => JSON.parse(line.slice(5).trim()) as Record<string, unknown>)
    .filter((message) => message.id === id);
  if (messages.length === 0) {
    throw new Error(`No JSON-RPC response for id ${id} in SSE body: ${text}`);
  }
  return messages[0] as Record<string, unknown>;
}

async function post(baseUrl: string, body: unknown, extraHeaders: Record<string, string> = {}): Promise<Response> {
  return fetch(baseUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: SSE_ACCEPT, ...extraHeaders },
    body: JSON.stringify(body),
  });
}

describe('streamable HTTP transport', () => {
  it('serves initialize and tools/call over stateless requests (no sessions)', async () => {
    const client = new FakeConcordiumClient({
      accounts: {
        [ADDRESS]: {
          address: ADDRESS,
          'CCD Balance': { value: '123456789', decimals: 6, display: '123.456789 CCD' },
          sequenceNumber: '5',
          index: '42',
          accountType: 'Account',
          keys: { threshold: 1, credentialCount: 2, credentialIds: ['cred-1'] },
          PLTs: [],
        },
      },
      sequenceNumbers: { [ADDRESS]: { sequenceNumber: '6', allFinal: true } },
    });
    const { config, clients } = makeContext(client);
    const httpConfig = { ...config, transport: 'http' as const, http: { port: 0, path: '/mcp' } };
    const httpServer = await startHttp(httpConfig, createServerFactory({ config: httpConfig, clients }));

    try {
      const baseUrl = `http://localhost:${await listenPort(httpServer)}/mcp`;

      const initResponse = await post(baseUrl, {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: LATEST_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'http-test', version: '0.0.0' },
        },
      });
      expect(initResponse.status).toBe(200);
      expect(initResponse.headers.get('access-control-allow-origin')).toBe('*');
      expect(initResponse.headers.get('mcp-session-id')).toBeNull();
      const initBody = await sseRpc(initResponse, 1);
      expect(initBody.result).toMatchObject({ serverInfo: { name: 'ccd-chain-client' } });
      const capabilities = (
        initBody.result as {
          capabilities: { tools?: unknown; resources?: { subscribe?: boolean } };
        }
      ).capabilities;
      expect(capabilities.tools).toBeDefined();
      expect(capabilities.resources?.subscribe).not.toBe(true);

      const callResponse = await post(baseUrl, {
        jsonrpc: '2.0',
        id: 2,
        method: 'resources/read',
        params: { uri: `ccd://account/${ADDRESS}/next-sequence-number` },
      });
      expect(callResponse.status).toBe(200);
      expect(callResponse.headers.get('mcp-session-id')).toBeNull();
      const callBody = await sseRpc(callResponse, 2);
      const content = (callBody.result as { contents: { text: string }[] }).contents;
      const dto = JSON.parse(content.map((block) => block.text).join('\n')) as {
        result: { address: string; sequenceNumber: string; allFinal: boolean };
      };
      expect(dto.result.sequenceNumber).toBe('6');
      expect(dto.result).toEqual({
        address: ADDRESS,
        sequenceNumber: '6',
        allFinal: true,
      });
    } finally {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
  });

  it('answers 405 for DELETE, 404 for unknown paths and 204 for CORS preflight', async () => {
    const client = new FakeConcordiumClient({});
    const { config, clients } = makeContext(client);
    const httpConfig = { ...config, transport: 'http' as const, http: { port: 0, path: '/mcp' } };
    const httpServer = await startHttp(httpConfig, createServerFactory({ config: httpConfig, clients }));

    try {
      const baseUrl = `http://localhost:${await listenPort(httpServer)}`;

      const del = await fetch(`${baseUrl}/mcp`, { method: 'DELETE' });
      expect(del.status).toBe(405);

      const missing = await fetch(`${baseUrl}/nope`, { method: 'POST' });
      expect(missing.status).toBe(404);

      const preflight = await fetch(`${baseUrl}/mcp`, { method: 'OPTIONS' });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get('access-control-allow-origin')).toBe('*');
      expect(preflight.headers.get('access-control-allow-headers')).toBe(
        'Content-Type, MCP-Protocol-Version, Accept, Mcp-Method, Mcp-Name',
      );
    } finally {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
  });
});
