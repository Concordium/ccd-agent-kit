import {
  InMemoryTransport,
  LATEST_PROTOCOL_VERSION,
  type JSONRPCMessage,
} from '@modelcontextprotocol/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { YubiKeyService } from '@ccd-agent-kit/piv-utils';
import { createMcpServer } from '../../../src/mcp/server.js';

const core = vi.hoisted(() => ({
  signCredentialDeployment: vi.fn(),
  signManagedTransaction: vi.fn(),
}));

vi.mock('../../../src/core/sign/managedTransactionSigning.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/core/sign/managedTransactionSigning.js')>()),
  signManagedTransaction: core.signManagedTransaction,
}));
vi.mock('../../../src/core/sign/signCredentialDeployment.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/core/sign/signCredentialDeployment.js')>()),
  signCredentialDeployment: core.signCredentialDeployment,
}));

let client: InMemoryTransport;
let server: ReturnType<typeof createMcpServer>;
let requestId = 1;
const yubiKeyService = {} as YubiKeyService;

function rpc(request: JSONRPCMessage): Promise<JSONRPCMessage> {
  return new Promise((resolve, reject) => {
    client.onmessage = (message) => {
      if ('id' in message && message.id === ('id' in request ? request.id : undefined)) resolve(message);
    };
    void client.send(request).catch(reject);
  });
}

async function callTool(arguments_: Record<string, unknown>): Promise<JSONRPCMessage> {
  return rpc({
    jsonrpc: '2.0',
    id: ++requestId,
    method: 'tools/call',
    params: { name: 'sign_transaction', arguments: arguments_ },
  });
}

async function callCredentialTool(arguments_: Record<string, unknown>): Promise<JSONRPCMessage> {
  return rpc({
    jsonrpc: '2.0',
    id: ++requestId,
    method: 'tools/call',
    params: { name: 'sign_credential', arguments: arguments_ },
  });
}

function result(message: JSONRPCMessage): Record<string, unknown> {
  if (!('result' in message)) throw new Error('Expected a JSON-RPC result');
  return message.result as Record<string, unknown>;
}

describe('signer MCP tool boundary', () => {
  beforeAll(async () => {
    server = createMcpServer({ yubiKeyService });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = clientTransport;
    await server.connect(serverTransport);
    await rpc({
      jsonrpc: '2.0',
      id: requestId,
      method: 'initialize',
      params: {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'signer-boundary-test', version: '0' },
      },
    });
    await client.send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
  });

  beforeEach(() => {
    core.signCredentialDeployment.mockReset();
    core.signManagedTransaction.mockReset();
  });
  afterAll(async () => server.close());

  it.each([
    ['rejects odd-length public hex', { transactionHex: 'abc', role: 'sender' }],
    [
      'rejects mutually exclusive key selection options',
      { transactionHex: 'aabb', role: 'sender', keys: ['0:0'], maxSignatures: 1 },
    ],
  ])('%s before signing', async (_name, arguments_) => {
    const response = await callTool(arguments_);

    expect(result(response)).toMatchObject({ isError: true });
    expect(core.signManagedTransaction).not.toHaveBeenCalled();
  });

  it.each([
    ['rejects odd-length hex', { credDeploymentHex: 'abc' }],
    ['rejects non-hex input', { credDeploymentHex: 'not-hex' }],
    ['rejects mutually exclusive key selection', { credDeploymentHex: 'aabb', keys: ['0'], maxSignatures: 1 }],
  ])('credential deployment %s before signing', async (_name, arguments_) => {
    const response = await callCredentialTool(arguments_);

    expect(result(response)).toMatchObject({ isError: true });
    expect(core.signCredentialDeployment).not.toHaveBeenCalled();
  });

  it('dispatches valid input to the signer core', async () => {
    core.signManagedTransaction.mockResolvedValue({
      address: 'account',
      label: 'alice',
      network: 'mainnet',
      transaction: 'aabb',
      roleSigned: 'sender',
      newSignature: { 0: { 0: '11'.repeat(64) } },
      signatures: { sender: { 0: { 0: '11'.repeat(64) } }, sponsor: {} },
      isFullySigned: false,
      signatureRequirementsKnown: false,
      missingSignatures: { sender: 0, sponsor: 0 },
    });

    const response = await callTool({ transactionHex: 'aabb', role: 'sender', maxSignatures: 1 });

    expect(result(response)).toMatchObject({ structuredContent: { label: 'alice', roleSigned: 'sender' } });
    expect(result(response).isError).toBeUndefined();
    expect(core.signManagedTransaction).toHaveBeenCalledWith(expect.objectContaining({
      transactionHex: 'aabb', role: 'sender', maxSignatures: 1, yubiKeyService,
    }));
  });
});
