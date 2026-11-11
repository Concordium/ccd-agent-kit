import { InMemoryTransport, LATEST_PROTOCOL_VERSION, type JSONRPCMessage } from '@modelcontextprotocol/server';
import { vi } from 'vitest';

import type { IdentityWorkflow } from '../src/core/workflowTypes.js';

type TestServer = {
  connect(transport: InMemoryTransport): Promise<void>;
  close(): Promise<void>;
};

/** Creates a complete workflow mock with per-test overrides. */
export function identityWorkflowFixture(overrides: Partial<IdentityWorkflow> = {}): IdentityWorkflow {
  return {
    request: vi.fn(), recover: vi.fn(), status: vi.fn(), list: vi.fn(async () => []),
    prepareAccount: vi.fn(), reconcileAccountOpening: vi.fn(), discoverIdentities: vi.fn(),
    associateIdentitySource: vi.fn(), discoverAccountCredentials: vi.fn(), setOperatorIdentityLabel: vi.fn(),
    setAgentIdentityLabel: vi.fn(), monitorIdentity: vi.fn(), ...overrides,
  } as IdentityWorkflow;
}

/** Sends one JSON-RPC request and resolves with its matching response. */
export function rpc(transport: InMemoryTransport, request: JSONRPCMessage): Promise<JSONRPCMessage> {
  return new Promise((resolve, reject) => {
    transport.onmessage = message => {
      if ('id' in message && message.id === ('id' in request ? request.id : undefined)) resolve(message);
    };
    void transport.send(request).catch(reject);
  });
}

/** Returns the result object from a successful JSON-RPC response. */
export function mcpResult(message: JSONRPCMessage): Record<string, unknown> {
  if (!('result' in message)) throw new Error('Expected JSON-RPC result');
  return message.result as Record<string, unknown>;
}

/** Parses concatenated text content from an MCP tool result. */
export function mcpText(value: Record<string, unknown>): unknown {
  return JSON.parse((value.content as Array<{ text: string }>).map(entry => entry.text).join(''));
}

/** Parses JSON from the first content item in an MCP resource read result. */
export function mcpResourcePayload(value: Record<string, unknown>): unknown {
  const first = (value.contents as Array<{ text?: string }>)[0];
  if (first?.text === undefined) throw new Error('Resource returned no text content');
  return JSON.parse(first.text);
}

/** Runs a callback against an initialized in-memory MCP client and always closes the server. */
export async function withMcpTestClient(server: TestServer, run: (client: InMemoryTransport) => Promise<void>): Promise<void> {
  const client = await connectMcpTestClient(server);
  try {
    await run(client);
  } finally {
    await server.close();
  }
}

/** Connects and initializes an in-memory MCP client for tests that manage server closure themselves. */
export async function connectMcpTestClient(server: TestServer): Promise<InMemoryTransport> {
  const [client, transport] = InMemoryTransport.createLinkedPair();
  await server.connect(transport);
  await rpc(client, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {
    protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'test', version: '0' },
  } });
  await client.send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
  return client;
}
