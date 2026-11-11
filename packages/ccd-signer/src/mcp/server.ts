import { McpServer, ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { getActiveNetwork } from '@ccd-agent-kit/config-utils';
import {
  ResourceSubscriptionManager,
  bindResourceSubscriptions,
  getStaticSkill,
  listStaticSkills,
  MCP_SKILLS_CAPABILITIES,
  MCP_SKILLS_GET_METHOD,
  MCP_SKILLS_LIST_METHOD,
  registerMcpResources,
} from '@ccd-agent-kit/mcp-utils';
import { z } from 'zod';

import { formatSignerInstanceStartupHint, startSignerInstanceControlServer } from '../core/instance/signerInstance.js';
import { activateSignerModules } from '../core/modules/activation.js';
import { signerResourceDefinitions } from './resources/resourceDefinitions.js';
import { CONCORDIUM_SIGNER_MCP_SKILLS } from './skills/catalog.js';
import { registerAllSignerTools } from './tools/registerTools.js';
import { createSignerToolRegistry } from './tools/toolRegistry.js';
import { createNativePivYubiKeyService, type YubiKeyService } from '@ccd-agent-kit/piv-utils';

/** Runtime services used by one signer MCP server instance. */
export interface SignerMcpServerOptions {
  /** YubiKey service shared with this process's local controls and module runtime. */
  yubiKeyService?: YubiKeyService;
  /** Subscription manager shared with signer runtime status events. */
  subscriptions?: ResourceSubscriptionManager;
}

/**
 * Creates the Concordium signer MCP server.
 *
 * @param options - Process-shared runtime services.
 * @returns The configured MCP server.
 */
export function createMcpServer(options: SignerMcpServerOptions = {}): McpServer {
  const server = new McpServer(
    {
      name: 'ccd-signer',
      version: '0.0.0-development',
    },
    { capabilities: MCP_SKILLS_CAPABILITIES },
  );

  registerSkillHandlers(server);

  for (const tool of registerAllSignerTools(createSignerToolRegistry(), options.yubiKeyService).list()) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.inputSchema,
        ...(tool.outputSchema === undefined ? {} : { outputSchema: tool.outputSchema }),
      },
      async (arguments_) => tool.handler(arguments_),
    );
  }

  const subscriptions = options.subscriptions ?? new ResourceSubscriptionManager({
    registrations: [],
    globals: [{ name: 'keys', uri: 'ccd://keys' }],
    notify: async (uri) => server.server.sendResourceUpdated({ uri }),
  });

  registerMcpResources(server, signerResourceDefinitions());
  bindResourceSubscriptions(server, subscriptions, { transport: 'stdio' });

  return server;
}

function registerSkillHandlers(server: McpServer): void {
  server.server.setRequestHandler(
    MCP_SKILLS_LIST_METHOD,
    { params: z.object({ cursor: z.string().optional() }) },
    async () => listStaticSkills(CONCORDIUM_SIGNER_MCP_SKILLS),
  );
  server.server.setRequestHandler(MCP_SKILLS_GET_METHOD, { params: z.object({ uri: z.string() }) }, async ({ uri }) => {
    const result = getStaticSkill(uri, CONCORDIUM_SIGNER_MCP_SKILLS);
    if (result === undefined) {
      throw new ProtocolError(ProtocolErrorCode.InvalidParams, `No skill is served at ${uri}`);
    }
    return result;
  });
}

/**
 * Runs the Concordium signer MCP server over stdio.
 */
export async function runMcpServer(): Promise<void> {
  serveStdio(async () => {
    const yubiKeyService = createNativePivYubiKeyService({ persistent: true });
    let server: McpServer | undefined;
    const subscriptions = new ResourceSubscriptionManager({
      registrations: [],
      globals: [{ name: 'keys', uri: 'ccd://keys' }],
      notify: async (uri) => server?.server.sendResourceUpdated({ uri }),
    });
    const keysChanged = () => subscriptions.invalidate({ resourceName: 'keys' });
    let modules: Awaited<ReturnType<typeof activateSignerModules>> | undefined;
    let control: Awaited<ReturnType<typeof startSignerInstanceControlServer>> | undefined;
    try {
      modules = await activateSignerModules({
        services: { yubiKeyService },
        notifyChanged: keysChanged,
      });
      control = await startSignerInstanceControlServer({
        network: getActiveNetwork().name,
        refreshInventory: () => modules!.refresh(),
        notifyChanged: keysChanged,
      });
      server = createMcpServer({ yubiKeyService, subscriptions });
      let closePromise: Promise<void> | undefined;
      const closeResources = server.server.onclose;
      server.server.onclose = () => {
        closeResources?.();
        closePromise ??= closeSignerRuntime(control!, modules!, yubiKeyService);
        void closePromise;
      };
      for (const line of formatSignerInstanceStartupHint(control.instance)) {
        process.stderr.write(`${line}\n`);
      }
      return server;
    } catch (error) {
      await closeSignerRuntime(control, modules, yubiKeyService);
      throw error;
    }
  }, {
    onerror: (err) => console.error('ccd-signer-mcp: stdio error', err),
  });
}

async function closeSignerRuntime(
  control: Awaited<ReturnType<typeof startSignerInstanceControlServer>> | undefined,
  modules: Awaited<ReturnType<typeof activateSignerModules>> | undefined,
  yubiKeyService: YubiKeyService,
): Promise<void> {
  await Promise.allSettled([control?.close(), modules?.close()]);
  await Promise.allSettled([yubiKeyService.close?.()]);
}
