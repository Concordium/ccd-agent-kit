import { createHash } from 'node:crypto';

import { InMemoryTransport, LATEST_PROTOCOL_VERSION, type JSONRPCMessage } from '@modelcontextprotocol/server';
import { describe, expect, it, vi } from 'vitest';

import type { IdentitySourceService } from '../../src/core/sources/types.js';
import { buildIdentityMcpServer } from '../../src/mcp/server.js';
import { identityProviderServiceFixture } from '../helpers.js';
import { identityWorkflowFixture, mcpResult, rpc } from '../mcpTestHelpers.js';

const SKILL_NAME = 'ccd-identity-management';
const SKILL_URI = `skill://${SKILL_NAME}/SKILL.md`;
const DESCRIPTION = 'Use when checking Concordium identity readiness or managing issuance, recovery, discovery, account opening, or identity proofs.';

function sourceFixture(): IdentitySourceService {
  return {
    resolve: vi.fn(),
    list: vi.fn(async () => []),
    records: vi.fn(async () => []),
  } as unknown as IdentitySourceService;
}

function errorCode(message: JSONRPCMessage): number {
  if (!('error' in message)) throw new Error('Expected JSON-RPC error');
  return message.error.code;
}

async function withInitializedServer(
  run: (client: InMemoryTransport, initializeResult: Record<string, unknown>) => Promise<void>,
): Promise<void> {
  const server = buildIdentityMcpServer(
    identityWorkflowFixture(),
    sourceFixture(),
    identityProviderServiceFixture(),
  );
  const [client, transport] = InMemoryTransport.createLinkedPair();
  await server.connect(transport);
  const initialized = mcpResult(await rpc(client, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'test', version: '0' },
    },
  }));
  await client.send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
  try {
    await run(client, initialized);
  } finally {
    await server.close();
  }
}

describe('identity manager MCP skill surface', () => {
  it('advertises the extension and preserves tools while serving the Markdown resource', async () => {
    await withInitializedServer(async (client, initialized) => {
      expect(initialized.capabilities).toMatchObject({
        extensions: { 'io.modelcontextprotocol/skills': {} },
      });

      const tools = mcpResult(await rpc(client, {
        jsonrpc: '2.0', id: 2, method: 'tools/list', params: {},
      })).tools as Array<{ name: string }>;
      expect(tools).toHaveLength(11);
      expect(tools.map(tool => tool.name)).toEqual([
        'request_identity', 'recover_identity',
        'prepare_account_opening', 'reconcile_account_opening',
        'discover_identities', 'discover_account_credentials', 'label_identity', 'label_identity_source',
        'validate_proof_request', 'find_proof_candidates', 'create_identity_proof',
      ]);

      const resources = mcpResult(await rpc(client, {
        jsonrpc: '2.0', id: 3, method: 'resources/list', params: {},
      })).resources as Array<{ uri: string; mimeType?: string }>;
      expect(resources).toContainEqual(expect.objectContaining({ uri: SKILL_URI, mimeType: 'text/markdown' }));

      const read = mcpResult(await rpc(client, {
        jsonrpc: '2.0', id: 4, method: 'resources/read', params: { uri: SKILL_URI },
      }));
      expect(read.contents).toEqual([expect.objectContaining({
        uri: SKILL_URI,
        mimeType: 'text/markdown',
        text: expect.stringMatching(/^---\nname: ccd-identity-management\ndescription:/),
      })]);
    });
  });

  it('returns the complete shared-helper shape from skills/list and skills/get', async () => {
    await withInitializedServer(async client => {
      const read = mcpResult(await rpc(client, {
        jsonrpc: '2.0', id: 2, method: 'resources/read', params: { uri: SKILL_URI },
      }));
      const text = (read.contents as Array<{ text: string }>)[0]!.text;
      const entry = {
        uri: SKILL_URI,
        frontmatter: { name: SKILL_NAME, description: DESCRIPTION },
        resources: [{
          uri: SKILL_URI,
          digest: `sha256:${createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex')}`,
          size: Buffer.byteLength(text, 'utf8'),
        }],
      };

      const listed = mcpResult(await rpc(client, {
        jsonrpc: '2.0', id: 3, method: 'skills/list', params: {},
      }));
      expect(listed).toEqual({
        resultType: 'complete',
        skills: [entry],
        ttlMs: 300_000,
        cacheScope: 'public',
      });

      const fetched = mcpResult(await rpc(client, {
        jsonrpc: '2.0', id: 4, method: 'skills/get', params: { uri: SKILL_URI },
      }));
      expect(fetched).toEqual({
        resultType: 'complete',
        skill: entry,
        ttlMs: 300_000,
        cacheScope: 'public',
      });

      const missing = await rpc(client, {
        jsonrpc: '2.0', id: 5, method: 'skills/get', params: { uri: 'skill://missing/SKILL.md' },
      });
      expect(errorCode(missing)).toBe(-32602);
    });
  });
});
