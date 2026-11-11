import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InMemoryTransport, LATEST_PROTOCOL_VERSION, type JSONRPCMessage } from '@modelcontextprotocol/server';
import { TransactionKindString } from '@concordium/web-sdk';
import { buildServer } from '../../../src/mcp/server.js';
import { TOOL_CATALOG } from '../../../src/mcp/toolPlumbing/registerTools.js';
import {
  BUILD_ANNOTATIONS,
  CACHE_REFRESH_ANNOTATIONS,
  READ_ANNOTATIONS,
} from '../../../src/mcp/toolPlumbing/toolAnnotations.js';
import { installAccountLabelsFixture } from '../../helpers/accountLabels.js';
import { FakeConcordiumClient, makeContext } from '../../helpers/fakes.js';

const ADDRESS = '32dZpZpu929J81XPFPbBxhwdig3v18U8KnBTXK3vrwdhUAk1Bp';

function jsonRpcResponse(message: JSONRPCMessage): message is JSONRPCMessage & { id: number } {
  return 'id' in message && typeof message.id === 'number';
}

/** Returns the `result` payload of a successful response, failing on errors. */
function rpcResult(message: JSONRPCMessage): Record<string, unknown> {
  if ('error' in message && message.error !== undefined) {
    throw new Error(`Unexpected RPC error: ${(message as { error: { message: string } }).error.message}`);
  }
  if (!('result' in message)) {
    throw new Error('Expected an RPC result response');
  }
  return (message as { result: Record<string, unknown> }).result;
}

/** Returns the error message of an RPC error response. */
function rpcError(message: JSONRPCMessage): string {
  const err = (message as { error?: { message: string } }).error;
  if (!err) throw new Error('Expected an RPC error response');
  return err.message;
}

function rpcErrorObject(message: JSONRPCMessage): {
  code: number;
  message: string;
  data?: unknown;
} {
  const err = (message as { error?: { code: number; message: string; data?: unknown } }).error;
  if (!err) throw new Error('Expected an RPC error response');
  return err;
}

/** Joins text content blocks to avoid fragile index access. */
function textOf(content: unknown): string {
  const blocks = content as { type: string; text: string }[];
  return blocks.map((block) => block.text).join('\n');
}

/**
 * Sends a JSON-RPC request over the client transport and resolves with the
 * matching response message.
 */
function rpc(transport: InMemoryTransport, request: JSONRPCMessage): Promise<JSONRPCMessage> {
  return new Promise((resolve, reject) => {
    transport.onmessage = (message) => {
      if (jsonRpcResponse(message) && message.id === (request as { id: number }).id) {
        transport.onmessage = () => {};
        resolve(message);
      }
    };
    void transport.send(request).catch(reject);
  });
}

async function withConnectedServer(
  ctx: ReturnType<typeof makeContext>,
  run: (transport: InMemoryTransport) => Promise<void>,
): Promise<void> {
  const { config, clients } = ctx;
  const server = await buildServer({ config, clients });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    const initialized = await rpc(clientTransport, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'test', version: '0.0.0' },
      },
    });
    expect(rpcResult(initialized).serverInfo).toMatchObject({ name: 'ccd-chain-client' });
    await clientTransport.send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
    await run(clientTransport);
  } finally {
    await server.close();
  }
}

describe('server protocol', () => {
  let restoreAccountLabels = () => {};

  beforeEach(() => {
    restoreAccountLabels = installAccountLabelsFixture(
      '9dd9ca4d19e9393877d2c44b70f89acb',
      { listed: ADDRESS },
      'ccd-server-test',
    );
  });

  afterEach(() => {
    restoreAccountLabels();
  });

  it('keeps tool annotations stable by tool family', () => {
    const annotationsByName = Object.fromEntries(TOOL_CATALOG.map((tool) => [tool.name, tool.annotations]));
    const readToolNames = [
      'simulate_contract',
      'get_cis2_token_balance',
      'verify_transaction_signature',
      'verify_message_signature',
    ];
    const buildToolNames = [
      'build_transfer',
      'build_register_data',
      'build_configure_delegation',
      'build_configure_baker',
      'build_init_contract',
      'build_update_contract',
      'build_plt',
    ];
    const submissionToolNames = ['complete_transaction', 'complete_account_opening'];

    for (const name of readToolNames) expect(annotationsByName[name]).toEqual(READ_ANNOTATIONS);
    for (const name of buildToolNames) expect(annotationsByName[name]).toEqual(BUILD_ANNOTATIONS);
    for (const name of submissionToolNames) {
      expect(annotationsByName[name]).toEqual({ destructiveHint: true, idempotentHint: false, openWorldHint: true });
    }
    expect(annotationsByName.sync_account_credentials).toEqual(CACHE_REFRESH_ANNOTATIONS);
    expect(annotationsByName.build_update_credential_keys).toEqual(CACHE_REFRESH_ANNOTATIONS);
    expect(annotationsByName.label_account).toEqual({ openWorldHint: false, idempotentHint: true });
    expect(annotationsByName.label_contract_instance).toEqual({ openWorldHint: false, idempotentHint: true });
    expect(Object.keys(annotationsByName).sort()).toEqual(
      [
        ...readToolNames,
        ...buildToolNames,
        ...submissionToolNames,
        'sync_account_credentials',
        'build_update_credential_keys',
        'label_account',
        'label_contract_instance',
      ].sort(),
    );
  });

  it('serves tools and resources over the protocol', async () => {
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
      consensus: {
        bestBlockHash: 'best-hash',
        lastFinalizedBlockHash: 'final-hash',
        lastFinalizedBlockHeight: '1000',
        genesisTime: '2020-01-01T00:00:00.000Z',
        currentEraGenesisTime: '2024-01-01T00:00:00.000Z',
        epoch: '3',
        currentEra: 4,
      },
      tokenList: {
        PLTs: [
          {
            tokenId: 'IMT',
            decimals: 6,
            'total supply': { value: '1234567890', decimals: 6, display: '1234.567890' },
          },
        ],
      },
      tokenInfos: {
        IMT: {
          tokenId: 'IMT',
          moduleRef: 'module-ref',
          decimals: 6,
          'total supply': { value: '1234567890', decimals: 6, display: '1234.567890' },
          name: 'I am Token',
          metadataUrl: undefined,
          governanceAccount: 'gov-addr',
          allowList: true,
          denyList: false,
          mintable: true,
          burnable: true,
          paused: false,
        },
      },
      lockInfos: {
        YGLvYhNvZ9: {
          lockId: 'YGLvYhNvZ9',
          creatorAccountIndex: '57',
          creatorSequenceNumber: '5',
          creationOrder: '0',
          recipients: 'any',
          expiryUnixSeconds: '1787076000',
          expiryTime: '2026-08-18T18:00:00.000Z',
          grants: [{ account: ADDRESS, capabilities: ['fund', 'send', 'cancel'] }],
          tokenIds: ['IMT'],
          funds: [],
        },
      },
      lockList: ['YGLvYhNvZ9'],
      invokes: [{ tag: 'success', usedEnergy: '123', eventCount: 0 }],
      blocks: {
        'block-hash': {
          hash: 'block-hash',
          height: '123',
          slotTime: '2024-01-01T00:00:00.000Z',
          era: 1,
          transactionsCount: '1',
          finalized: true,
        },
      },
      blockItems: {
        deadbeef: {
          transactionHash: 'deadbeef',
          status: 'finalized',
          blockHash: 'block-hash',
          blockItemKind: 'accountTransactionV1',
          blockItemHex: '00ff',
        },
      },
      transactionEffects: {
        deadbeef: {
          transactionHash: 'deadbeef',
          status: 'finalized',
          blockHash: 'block-hash',
          effects: [
            {
              type: 'accountTransaction',
              summary: {
                transactionType: TransactionKindString.Failed,
                sender: 'sender',
                cost: '1',
                energyCost: '2',
                hash: 'deadbeef',
                index: '3',
                rejectReason: null,
              },
            },
          ],
        },
      },
    });
    const { config, clients } = makeContext(client);
    const server = await buildServer({ config, clients });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);

    try {
      const init = await rpc(clientTransport, {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: LATEST_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'test', version: '0.0.0' },
        },
      });
      expect(init).toMatchObject({ jsonrpc: '2.0', id: 1 });
      expect(rpcResult(init).serverInfo).toMatchObject({ name: 'ccd-chain-client' });
      const capabilities = rpcResult(init).capabilities as {
        tools?: unknown;
        resources?: { subscribe?: boolean };
        extensions?: Record<string, unknown>;
      };
      expect(capabilities.tools).toBeDefined();
      expect(capabilities.resources?.subscribe).not.toBe(true);
      expect(capabilities.extensions?.['io.modelcontextprotocol/skills']).toEqual({});

      await clientTransport.send({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
        params: {},
      });

      const list = await rpc(clientTransport, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
        params: {},
      });
      const tools = rpcResult(list).tools as { name: string }[];
      expect(tools.map((tool) => tool.name)).toEqual(TOOL_CATALOG.map((tool) => tool.name));
      expect(tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining([
          'verify_transaction_signature',
          'verify_message_signature',
          'complete_account_opening',
          'label_contract_instance',
        ]),
      );
      for (const removedToolName of ['start_id_app_pairing', 'disconnect_id_app_pairing', 'request_account_opening']) {
        expect(tools.map((tool) => tool.name)).not.toContain(removedToolName);
      }

      const call = await rpc(clientTransport, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'simulate_contract', arguments: { contract: '1,0', method: 'counter.get' } },
      });
      const callResult = rpcResult(call);
      expect(textOf(callResult.content)).toContain('success');
      expect(callResult.structuredContent).toMatchObject({ tag: 'success' });

      const missing = await rpc(clientTransport, {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'does_not_exist', arguments: {} },
      });
      expect(rpcError(missing)).toContain('does_not_exist');

      const resources = await rpc(clientTransport, {
        jsonrpc: '2.0',
        id: 5,
        method: 'resources/list',
        params: {},
      });
      const resourceUris = (rpcResult(resources).resources as { uri: string }[]).map((resource) => resource.uri);
      expect(resourceUris).toContain(`ccd://account/${ADDRESS}`);
      expect(resourceUris).toContain('ccd://networks');
      expect(resourceUris).not.toContain('ccd://networks/management-guidance');
      expect(resourceUris).toContain('ccd://account-labels');
      expect(resourceUris).not.toContain('ccd://account-labels/management-guidance');
      expect(resourceUris).toContain('ccd://contract-instance-labels');
      expect(resourceUris).not.toContain('ccd://contract-instance-labels/management-guidance');
      expect(resourceUris).toContain('ccd://consensus/status');
      expect(resourceUris).toContain('ccd://chain/capabilities');
      for (const removedResourceUri of [
        'ccd://walletconnect/connections',
        'ccd://walletconnect/connection/{connectionId}',
      ]) {
        expect(resourceUris).not.toContain(removedResourceUri);
      }
      expect(resourceUris).toContain('ccd://lock/YGLvYhNvZ9');
      expect(resourceUris).toContain('ccd://plts');
      expect(resourceUris).toContain('ccd://plt/IMT');
      expect(resourceUris).not.toContain('skill://concordium-account-opening/SKILL.md');

      const skillsList = await rpc(clientTransport, {
        jsonrpc: '2.0',
        id: 19,
        method: 'skills/list',
        params: {},
      });
      const skillsResult = rpcResult(skillsList) as {
        skills: Array<{
          uri: string;
          frontmatter: { name: string };
          resources: Array<{ digest: string; size: number }>;
        }>;
      };
      expect(skillsResult.skills.map((skill) => skill.frontmatter.name)).toEqual([
        'ccd-network-discovery',
        'ccd-account-label-discovery',
        'ccd-transfer',
        'ccd-plt-transfer',
        'ccd-sponsored-multisig-transaction',
      ]);
      expect(skillsResult.skills[2]?.resources[0]?.digest).toMatch(/^sha256:[0-9a-f]{64}$/);

      const skillGet = await rpc(clientTransport, {
        jsonrpc: '2.0',
        id: 21,
        method: 'skills/get',
        params: { uri: 'skill://ccd-transfer/SKILL.md' },
      });
      expect((rpcResult(skillGet).skill as { frontmatter: { name: string } }).frontmatter.name).toBe(
        'ccd-transfer',
      );

      const missingSkill = await rpc(clientTransport, {
        jsonrpc: '2.0',
        id: 22,
        method: 'skills/get',
        params: { uri: 'skill://missing/SKILL.md' },
      });
      expect(rpcErrorObject(missingSkill).code).toBe(-32602);

      const networksRead = await rpc(clientTransport, {
        jsonrpc: '2.0',
        id: 12,
        method: 'resources/read',
        params: { uri: 'ccd://networks' },
      });
      expect(textOf(rpcResult(networksRead).contents)).toContain('"defaultNetwork"');

      const capabilitiesRead = await rpc(clientTransport, {
        jsonrpc: '2.0',
        id: 18,
        method: 'resources/read',
        params: { uri: 'ccd://chain/capabilities' },
      });
      expect(textOf(rpcResult(capabilitiesRead).contents)).toContain('"capabilities"');

      const read = await rpc(clientTransport, {
        jsonrpc: '2.0',
        id: 6,
        method: 'resources/read',
        params: { uri: `ccd://account/${ADDRESS}` },
      });
      expect(textOf(rpcResult(read).contents)).toContain(`"address":"${ADDRESS}"`);

      const blockItemRead = await rpc(clientTransport, {
        jsonrpc: '2.0',
        id: 15,
        method: 'resources/read',
        params: { uri: 'ccd://block-item/deadbeef' },
      });
      expect(JSON.parse(textOf(rpcResult(blockItemRead).contents))).toMatchObject({
        result: { blockHash: 'block-hash' },
      });

      const blockItemEffectsRead = await rpc(clientTransport, {
        jsonrpc: '2.0',
        id: 16,
        method: 'resources/read',
        params: { uri: 'ccd://block-item/deadbeef/effects' },
      });
      expect(textOf(rpcResult(blockItemEffectsRead).contents)).toContain('"effects"');

      const blockEventsRead = await rpc(clientTransport, {
        jsonrpc: '2.0',
        id: 17,
        method: 'resources/read',
        params: { uri: 'ccd://block/block-hash/events' },
      });
      expect(JSON.parse(textOf(rpcResult(blockEventsRead).contents))).toMatchObject({
        result: { hash: 'block-hash' },
      });

      const accountLabelsRead = await rpc(clientTransport, {
        jsonrpc: '2.0',
        id: 14,
        method: 'resources/read',
        params: { uri: 'ccd://account-labels' },
      });
      expect(JSON.parse(textOf(rpcResult(accountLabelsRead).contents))).toMatchObject({
        network: 'mainnet',
        result: { labels: expect.arrayContaining([{ label: 'listed', address: ADDRESS }]) },
      });

      for (const uri of [
        'ccd://account-labels/management-guidance',
        'ccd://contract-instance-labels/management-guidance',
      ]) {
        const removedManagementRead = await rpc(clientTransport, {
          jsonrpc: '2.0',
          id: 21,
          method: 'resources/read',
          params: { uri },
        });
        expect(rpcError(removedManagementRead)).toContain(uri);
      }

      const statusRead = await rpc(clientTransport, {
        jsonrpc: '2.0',
        id: 13,
        method: 'resources/read',
        params: { uri: 'ccd://consensus/status' },
      });
      expect(JSON.parse(textOf(rpcResult(statusRead).contents))).toMatchObject({
        result: { bestBlockHash: 'best-hash' },
      });

      const tokenRead = await rpc(clientTransport, {
        jsonrpc: '2.0',
        id: 9,
        method: 'resources/read',
        params: { uri: 'ccd://plt/IMT' },
      });
      expect(JSON.parse(textOf(rpcResult(tokenRead).contents))).toMatchObject({ result: { tokenId: 'IMT' } });
      expect(textOf(rpcResult(tokenRead).contents)).toContain('"totalSupply"');
      expect(textOf(rpcResult(tokenRead).contents)).not.toContain('"total supply"');

      const pltCatalogueRead = await rpc(clientTransport, {
        jsonrpc: '2.0',
        id: 19,
        method: 'resources/read',
        params: { uri: 'ccd://plts' },
      });
      expect(textOf(rpcResult(pltCatalogueRead).contents)).toContain('"PLTs"');
      expect(textOf(rpcResult(pltCatalogueRead).contents)).toContain('"totalSupply"');
      expect(textOf(rpcResult(pltCatalogueRead).contents)).not.toContain('"total supply"');

      const lockRead = await rpc(clientTransport, {
        jsonrpc: '2.0',
        id: 10,
        method: 'resources/read',
        params: { uri: 'ccd://lock/YGLvYhNvZ9' },
      });
      expect(JSON.parse(textOf(rpcResult(lockRead).contents))).toMatchObject({ result: { lockId: 'YGLvYhNvZ9' } });
    } finally {
      await server.close();
    }
  });

  it('rejects invalid label actions at the MCP protocol boundary', async () => {
    await withConnectedServer(makeContext(new FakeConcordiumClient()), async (clientTransport) => {
      const accountResponse = await rpc(clientTransport, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'label_account', arguments: { address: ADDRESS } },
      });
      expect(rpcResult(accountResponse)).toMatchObject({ isError: true });

      const contractResponse = await rpc(clientTransport, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'label_contract_instance',
          arguments: { address: '7,1', label: 'Counter', remove: true },
        },
      });
      expect(rpcResult(contractResponse)).toMatchObject({ isError: true });
    });
  });
});
