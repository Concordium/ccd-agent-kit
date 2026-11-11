import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from '@modelcontextprotocol/server';
import { createServerFactory } from '../../../../src/mcp/server.js';
import { startHttp } from '../../../../src/mcp/transports/httpTransport.js';
import { installAccountLabelsFixture } from '../../../helpers/accountLabels.js';
import { FakeConcordiumClient, makeContext } from '../../../helpers/fakes.js';

const ADDRESS = '32dZpZpu929J81XPFPbBxhwdig3v18U8KnBTXK3vrwdhUAk1Bp';
const MODERN_REVISION = '2026-07-28';

async function listenPort(httpServer: Server): Promise<number> {
  const address = httpServer.address();
  if (address === null || typeof address === 'string') throw new Error('Expected a bound TCP address');
  return address.port;
}

/** Parses a modern-era JSON response body, failing on RPC errors. */
function resultOf(body: Record<string, unknown>): Record<string, unknown> {
  const error = body.error as { message: string } | undefined;
  if (error !== undefined) throw new Error(`Unexpected RPC error: ${error.message}`);
  return (body.result as Record<string, unknown>) ?? {};
}

/**
 * Sends a modern (2026-07-28) request: a JSON-RPC message whose `params._meta`
 * carries the per-request envelope (protocol version, client capabilities),
 * plus the SEP-2243 standard headers. No `initialize` handshake is involved.
 *
 * `mcpMethod: null` omits the `Mcp-Method` header entirely (to exercise the
 * server's missing-header rejection); `mcpName` adds the required `Mcp-Name`
 * header for methods whose body carries a name/uri.
 */
async function postModern(
  baseUrl: string,
  id: number,
  method: string,
  params: Record<string, unknown>,
  options: { mcpMethod?: string | null; mcpName?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'MCP-Protocol-Version': MODERN_REVISION,
  };
  if (options.mcpMethod !== null) headers['Mcp-Method'] = options.mcpMethod ?? method;
  if (options.mcpName !== undefined) headers['Mcp-Name'] = options.mcpName;
  return fetch(baseUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id,
      method,
      params: {
        ...params,
        _meta: {
          [PROTOCOL_VERSION_META_KEY]: MODERN_REVISION,
          [CLIENT_CAPABILITIES_META_KEY]: {},
          [CLIENT_INFO_META_KEY]: { name: 'modern-test', version: '0.0.0' },
        },
      },
    }),
  });
}

describe('streamable HTTP transport (modern era)', () => {
  let restoreAccountLabels = () => {};

  beforeEach(() => {
    restoreAccountLabels = installAccountLabelsFixture(
      '9dd9ca4d19e9393877d2c44b70f89acb',
      { listed: ADDRESS },
      'ccd-http-test',
    );
  });

  afterEach(() => {
    restoreAccountLabels();
  });

  it('serves modern-era requests with no initialize handshake', async () => {
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

      const discover = await postModern(baseUrl, 1, 'server/discover', {});
      expect(discover.status).toBe(200);
      expect(discover.headers.get('content-type')).toContain('application/json');
      const discoverResult = resultOf((await discover.json()) as Record<string, unknown>);
      expect(discoverResult.supportedVersions).toContain(MODERN_REVISION);
      const capabilities = discoverResult.capabilities as {
        tools?: unknown;
        resources?: { subscribe?: boolean };
      };
      expect(capabilities.tools).toBeDefined();
      expect(capabilities.resources?.subscribe).not.toBe(true);

      const list = await postModern(baseUrl, 2, 'tools/list', {});
      expect(list.status).toBe(200);
      const listResult = resultOf((await list.json()) as Record<string, unknown>);
      expect(listResult.resultType).toBe('complete');
      const resources = await postModern(baseUrl, 21, 'resources/list', {});
      expect(resources.status).toBe(200);
      const resourcesResult = resultOf((await resources.json()) as Record<string, unknown>);
      const resourceUris = (resourcesResult.resources as { uri: string }[]).map((resource) => resource.uri);
      expect(resourceUris).toContain(`ccd://account/${ADDRESS}`);

      const call = await postModern(
        baseUrl,
        3,
        'resources/read',
        { uri: `ccd://account/${ADDRESS}/next-sequence-number` },
        { mcpName: `ccd://account/${ADDRESS}/next-sequence-number` },
      );
      expect(call.status).toBe(200);
      const callResult = resultOf((await call.json()) as Record<string, unknown>);
      expect(callResult.resultType).toBe('complete');
      const content = (callResult.contents as { text: string }[]).map((block) => block.text).join('\n');
      const dto = JSON.parse(content) as {
        result: { address: string; sequenceNumber: string; allFinal: boolean };
      };
      expect(dto.result.sequenceNumber).toBe('6');
      expect(dto.result).toMatchObject({ address: ADDRESS, allFinal: true });

      const read = await postModern(
        baseUrl,
        4,
        'resources/read',
        { uri: `ccd://account/${ADDRESS}` },
        { mcpName: `ccd://account/${ADDRESS}` },
      );
      expect(read.status).toBe(200);
      const readResult = resultOf((await read.json()) as Record<string, unknown>);
      const resourceText = (readResult.contents as { type: string; text: string }[]).map((b) => b.text).join('\n');
      expect(JSON.parse(resourceText)).toMatchObject({ result: { address: ADDRESS } });
    } finally {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
  });

  it('rejects modern requests that omit the required Mcp-Method header', async () => {
    const client = new FakeConcordiumClient({});
    const { config, clients } = makeContext(client);
    const httpConfig = { ...config, transport: 'http' as const, http: { port: 0, path: '/mcp' } };
    const httpServer = await startHttp(httpConfig, createServerFactory({ config: httpConfig, clients }));

    try {
      const baseUrl = `http://localhost:${await listenPort(httpServer)}/mcp`;
      const response = await postModern(baseUrl, 7, 'tools/list', {}, { mcpMethod: null });
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: { code: number } };
      expect(body.error.code).toBe(-32020);
    } finally {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
  });
});
