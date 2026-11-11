import { McpServer, ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import {
  getStaticSkill,
  jsonResourceContent,
  jsonTextToolResult,
  listStaticSkills,
  MCP_SKILLS_CAPABILITIES,
  MCP_SKILLS_GET_METHOD,
  MCP_SKILLS_LIST_METHOD,
  NetworkResourceError,
  ResourceSubscriptionManager,
  type ResourceSubscriptionPublisher,
  bindResourceSubscriptions,
  mcpInvalidArgument,
  registerMcpResources,
  registerNetworkResourceFamily,
  type BoundMcpResourceDefinition,
  type McpJsonValue,
  mcpTextToolErrorResult,
} from '@ccd-agent-kit/mcp-utils';
import {
  catalogLabelSchema,
  catalogLabelActionSchema,
  createNetworkResourceAdapter,
  createIdentitySourceRegistry,
  IDENTITY_SOURCE_ID_PATTERN,
  IdentitySourceError,
  findCatalogLabel,
  parseCatalogLabel,
  type IdentitySourceRegistry,
  type NetworkConfig,
} from '@ccd-agent-kit/config-utils';
import { caip2Reference } from '@ccd-agent-kit/sdk-utils';
import { identityLabelValue } from '../core/identityLabels.js';
import { createIdentityMonitor, type IdentityMonitor } from '../core/identityMonitor.js';
import { IdentityProofError, type IdentityProofService } from '../core/identityProofs.js';
import { createDefaultIdentitySourceService } from '../core/sources/runtime.js';
import type { IdentitySourceService } from '../core/sources/types.js';
import { startIdentityManagerInstanceControlServer } from '../core/instance/identityManagerInstance.js';
import { IdentityWorkflowError } from '../core/workflowErrors.js';
import { createDefaultIdentityProofService, createDefaultIdentityWorkflow, createEncryptedIdentityStore } from '../core/workflowInfrastructure.js';
import { IdentityProviderError } from '../core/providers/error.js';
import { createDefaultIdentityProviderService, resolveProviderNetwork } from '../core/providers/serviceFactory.js';
import type { IdentityProviderService } from '../core/providers/types.js';
import type { IdentityWorkflow } from '../core/workflowTypes.js';
import {
  accountOpeningInputSchema, credentialDiscoveryInputSchema, identityDiscoveryInputSchema,
  identityIdSchema, identityRecoveryInputSchema, identityRequestInputSchema,
} from '../core/workflowValidation.js';
import { CONCORDIUM_IDENTITY_MCP_SKILLS } from './skills/catalog.js';

const networkSchema = z.string().min(1).max(128).optional();
const providerSelectorSchema = z.union([
  z.number().int().min(0).max(0x7fffffff),
  z.string().regex(/^\d+$/),
  catalogLabelSchema,
]);
const mcpIdentitySelectorSchema = z.union([identityIdSchema, catalogLabelSchema]);
const requestSchema = identityRequestInputSchema.omit({ identityProviderIndex: true, mode: true }).safeExtend({
  identityProvider: providerSelectorSchema, label: catalogLabelSchema.optional(),
}).strict();
const recoverySchema = identityRecoveryInputSchema.omit({ identityProviderIndex: true }).extend({
  identityProvider: providerSelectorSchema,
}).strict();
const discoverySchema = z.object({
  network: identityDiscoveryInputSchema.shape.network,
  source: identityDiscoveryInputSchema.shape.source,
  gapLimit: identityDiscoveryInputSchema.shape.gapLimit,
  startIndex: identityDiscoveryInputSchema.shape.startIndex,
  endIndex: identityDiscoveryInputSchema.shape.endIndex,
  identityProvider: providerSelectorSchema.optional(),
}).strict().refine(input => input.startIndex === undefined || input.endIndex === undefined
  || input.startIndex <= input.endIndex);
const reconcileSchema = z.object({ network: networkSchema, identityId: mcpIdentitySelectorSchema }).strict();
const accountSchema = accountOpeningInputSchema.safeExtend({ identityId: mcpIdentitySelectorSchema });
const credentialSchema = credentialDiscoveryInputSchema.safeExtend({ identityId: mcpIdentitySelectorSchema });
const labelSchema = catalogLabelActionSchema.safeExtend({
  network: networkSchema, identityId: mcpIdentitySelectorSchema,
});
const sourceSelectorSchema = z.union([z.string().regex(IDENTITY_SOURCE_ID_PATTERN), catalogLabelSchema]);
const sourceLabelSchema = catalogLabelActionSchema.safeExtend({ source: sourceSelectorSchema });
const proofRequestSchema = z.object({
  network: networkSchema,
  request: z.record(z.string(), z.unknown()),
}).strict();
const proofValidationSchema = proofRequestSchema.extend({ describe: z.boolean().default(false) });
const proofCreationSchema = proofRequestSchema.extend({
  subject: z.discriminatedUnion('type', [
    z.object({ type: z.literal('identity'), identityId: mcpIdentitySelectorSchema }).strict(),
    z.object({
      type: z.literal('account'), account: z.string().min(1).max(128),
      credentialIndex: z.number().int().min(0).max(255).optional(),
    }).strict(),
  ]),
});
const NETWORK_SCOPE_DESCRIPTION = ' Uses the selected network; omitted network uses CCD_NETWORK or the configured default.';

/** Optional runtime binding for identity subscription invalidation. */
export interface IdentityMcpServerOptions {
  /** Receives the shared subscription publisher owned by this server. */
  onSubscriptionsReady?(publisher: ResourceSubscriptionPublisher): void;
}

async function result(operation: () => Promise<unknown>) {
  try { return jsonTextToolResult(await operation()); }
  catch (error) {
    const message = error instanceof IdentityWorkflowError
      || error instanceof IdentitySourceError
      || error instanceof IdentityProviderError
      || error instanceof IdentityProofError
      ? error.message
      : 'Identity workflow operation failed.';
    return mcpTextToolErrorResult({ message });
  }
}

/**
 * Build the agent-safe identity tools and resources without a PIN surface.
 * Workflow tools use the selected network; omitted network selectors honor CCD_NETWORK then its default.
 * Source discovery is the global `ccd://identity-sources` resource; request/recovery resolve an exact source ID/label or its configured default.
 * Source-label mutation writes only a soft shared-catalog label and returns no hardware locator.
 * Proof tools separate request validation, local eligibility, and presentation creation; none submits proofs.
 * Only terminal background-monitor changes invalidate identity subscriptions.
 * Network resources use the shared `{ network, caip2, result }` envelope.
 */
export function buildIdentityMcpServer(
  workflow: IdentityWorkflow,
  sources: IdentitySourceService,
  providers: IdentityProviderService,
  monitor?: IdentityMonitor,
  proofs?: IdentityProofService,
  sourceRegistry: IdentitySourceRegistry = createIdentitySourceRegistry(),
  options: IdentityMcpServerOptions = {},
): McpServer {
  const server = new McpServer(
    { name: 'ccd-id-manager', version: '0.0.0-development' },
    { capabilities: MCP_SKILLS_CAPABILITIES },
  );
  server.server.setRequestHandler(
    MCP_SKILLS_LIST_METHOD,
    { params: z.object({ cursor: z.string().optional() }) },
    async () => listStaticSkills(CONCORDIUM_IDENTITY_MCP_SKILLS),
  );
  server.server.setRequestHandler(
    MCP_SKILLS_GET_METHOD,
    { params: z.object({ uri: z.string() }) },
    async ({ uri }) => {
      const result = getStaticSkill(uri, CONCORDIUM_IDENTITY_MCP_SKILLS);
      if (result === undefined) {
        throw new ProtocolError(ProtocolErrorCode.InvalidParams, `No skill is served at ${uri}`);
      }
      return result;
    },
  );
  const providerSelection = async (input: {
    network?: string | undefined; identityProvider: number | string;
  }) => {
    const network = resolveProviderNetwork(input.network);
    const provider = await providers.resolve({
      network, selector: input.identityProvider, requireEnabled: true,
    });
    return { network, provider };
  };
  const projectSummary = <T extends { label?: string }>(summary: T): T => summary.label === undefined
    ? summary
    : { ...summary, label: identityLabelValue(summary.label) };
  const resolveIdentity = async (input: { network?: string | undefined; identityId: string }) => {
    if (identityIdSchema.safeParse(input.identityId).success) return input;
    const network = resolveProviderNetwork(input.network);
    const identities = await workflow.list({ network: network.caip2 });
    const identity = findCatalogLabel(identities, input.identityId, summary => summary.label);
    if (identity === undefined) throw new IdentityWorkflowError('IDENTITY_NOT_FOUND');
    return { network: network.caip2, identityId: identity.identityId };
  };
  server.registerTool('request_identity', {
    description: 'Request an identity; returns requested or identity_already_exists.'
      + NETWORK_SCOPE_DESCRIPTION, inputSchema: requestSchema,
  }, input => result(async () => {
    try {
      const { network, provider } = await providerSelection(input);
      const summary = projectSummary(await workflow.request({
        network: network.caip2, identityProviderIndex: provider.index,
        ...(input.source === undefined ? {} : { source: input.source }),
        ...(input.label === undefined ? {} : { label: input.label, mode: 'soft' }),
        ...(input.identityIndex === undefined ? {} : { identityIndex: input.identityIndex }),
      }));
      return summary;
    } finally { monitor?.wake(); }
  }));
  server.registerTool('recover_identity', {
    description: 'Recover an identity.' + NETWORK_SCOPE_DESCRIPTION, inputSchema: recoverySchema,
  }, input => result(async () => {
    const { network, provider } = await providerSelection(input);
    const summary = projectSummary(await workflow.recover({
      network: network.caip2, identityProviderIndex: provider.index, identityIndex: input.identityIndex,
      ...(input.source === undefined ? {} : { source: input.source }),
    }));
    return summary;
  }));
  server.registerTool('prepare_account_opening', {
    description: 'Prepare an unsigned account-opening handoff for the separate signer; selected identity attributes become public on-chain.'
      + NETWORK_SCOPE_DESCRIPTION, inputSchema: accountSchema,
  }, input => result(async () => {
    const selected = await resolveIdentity(input);
    return workflow.prepareAccount({
      ...(selected.network === undefined ? {} : { network: selected.network }),
      identityId: selected.identityId, publicKeys: input.publicKeys,
      credentialThreshold: input.credentialThreshold, expirySeconds: input.expirySeconds,
      ...(input.credentialNumber === undefined ? {} : { credentialNumber: input.credentialNumber }),
      ...(input.revealAttributes === undefined ? {} : { revealAttributes: input.revealAttributes }),
    });
  }));
  server.registerTool('reconcile_account_opening', {
    description: 'Reconcile a pending account opening against one finalized block.' + NETWORK_SCOPE_DESCRIPTION, inputSchema: reconcileSchema,
  }, input => result(async () => {
    const selected = await resolveIdentity(input);
    return workflow.reconcileAccountOpening({
      ...(selected.network === undefined ? {} : { network: selected.network }), identityId: selected.identityId,
    });
  }));
  server.registerTool('discover_identities', {
    description: 'Discover, recover, and save identities without exposing identity contents.'
      + NETWORK_SCOPE_DESCRIPTION,
    inputSchema: discoverySchema,
  }, input => result(async () => {
    const network = resolveProviderNetwork(input.network);
    const provider = input.identityProvider === undefined ? undefined : await providers.resolve({
      network, selector: input.identityProvider, requireEnabled: true,
    });
    const discovery = await workflow.discoverIdentities({
      network: network.caip2,
      ...(input.source === undefined ? {} : { source: input.source }),
      ...(provider === undefined ? {} : { identityProviderIndex: provider.index }),
      ...(input.gapLimit === undefined ? {} : { gapLimit: input.gapLimit }),
      ...(input.startIndex === undefined ? {} : { startIndex: input.startIndex }),
      ...(input.endIndex === undefined ? {} : { endIndex: input.endIndex }),
    });
    return discovery;
  }));
  server.registerTool('discover_account_credentials', {
    description: 'Discover account credential indexes without signing.' + NETWORK_SCOPE_DESCRIPTION,
    inputSchema: credentialSchema,
  }, input => result(async () => {
    const selected = await resolveIdentity(input);
    return workflow.discoverAccountCredentials({
      ...(selected.network === undefined ? {} : { network: selected.network }), identityId: selected.identityId,
      ...(input.gapLimit === undefined ? {} : { gapLimit: input.gapLimit }),
      ...(input.startCredentialNumber === undefined ? {} : { startCredentialNumber: input.startCredentialNumber }),
      ...(input.endCredentialNumber === undefined ? {} : { endCredentialNumber: input.endCredentialNumber }),
      ...(input.full === true ? { full: true } : {}),
    });
  }));
  server.registerTool('label_identity', {
    description: 'Set or explicitly remove an agent-modifiable identity label.' + NETWORK_SCOPE_DESCRIPTION,
    inputSchema: labelSchema,
  }, input => result(async () => {
    const selected = await resolveIdentity(input);
    const network = selected.network ?? resolveProviderNetwork(input.network).caip2;
    const summary = projectSummary(await workflow.setAgentIdentityLabel({
      network,
      identityId: selected.identityId,
      ...(input.label === undefined
        ? { operation: 'remove' as const }
        : { operation: 'set' as const, label: input.label }),
    }));
    return summary;
  }));
  server.registerTool('label_identity_source', {
    description: 'Create, replace, or remove a soft identity-source label without changing hard labels or exposing hardware locations.',
    inputSchema: sourceLabelSchema,
  }, input => result(async () => {
    const updated = await sourceRegistry.setSoftLabel(input.source, input.label);
    return {
      id: updated.id,
      ...(updated.label === undefined ? {} : { label: parseCatalogLabel(updated.label).label }),
    };
  }));
  server.registerTool('validate_proof_request', {
    description: 'Validate a finalized Verify & Access request anchor. Set describe to review the exact requester-supplied context and claims; domain binding is not checked.'
      + NETWORK_SCOPE_DESCRIPTION,
    inputSchema: proofValidationSchema,
  }, input => result(async () => {
    if (proofs === undefined) throw new Error('Proof service unavailable.');
    return proofs.validateRequest({
      request: input.request, describe: input.describe,
      ...(input.network === undefined ? {} : { network: input.network }),
    });
  }));
  server.registerTool('find_proof_candidates', {
    description: 'Check local identity attributes and cached account associations for whole-request matches without chain reads. Unavailable identities are omitted; no attribute values are returned.'
      + NETWORK_SCOPE_DESCRIPTION,
    inputSchema: proofRequestSchema,
  }, input => result(async () => {
    if (proofs === undefined) throw new Error('Proof service unavailable.');
    return proofs.findCandidates({
      request: input.request,
      ...(input.network === undefined ? {} : { network: input.network }),
    });
  }));
  server.registerTool('create_identity_proof', {
    description: 'Create a Verify & Access presentation after review and approval of the exact request context and disclosures. Revalidates the finalized anchor; never submits. Omitted credentialIndex chooses the lowest eligible account credential index.'
      + NETWORK_SCOPE_DESCRIPTION,
    inputSchema: proofCreationSchema,
  }, input => result(async () => {
    if (proofs === undefined) throw new Error('Proof service unavailable.');
    const subject = input.subject;
    return proofs.createProof({
      request: input.request,
      ...(input.network === undefined ? {} : { network: input.network }),
      subject: subject.type === 'identity'
        ? subject
        : {
          type: 'account', account: subject.account,
          ...(subject.credentialIndex === undefined ? {} : { credentialIndex: subject.credentialIndex }),
        },
    });
  }));
  const networkAdapter = createNetworkResourceAdapter();
  const identities = registerNetworkResourceFamily(networkAdapter, {
    name: 'identities', title: 'Concordium Identities',
    description: 'Safe stored identity summaries.', path: 'identities',
    async read({ network }) {
      try {
        return { identities: (await workflow.list({ network: network.caip2 })).map(projectSummary) } as unknown as McpJsonValue;
      } catch { throw new NetworkResourceError('RESOURCE_READ_FAILED', 'Identity inventory is unavailable.'); }
    },
    subscribable: true,
  });
  const identityProviders = registerNetworkResourceFamily(networkAdapter, {
    name: 'identity-providers', title: 'Concordium Identity Providers',
    description: 'Safe local identity-provider inventory.', path: 'identity-providers',
    async read({ network }) {
      try {
        const inventory = await providers.inventory({
          network: { caip2: network.caip2, genesisHash: network.value.genesisHash },
        });
        return {
          ...(inventory.refreshedAt === undefined ? {} : { refreshedAt: inventory.refreshedAt }),
          providers: inventory.providers,
        } as unknown as McpJsonValue;
      } catch { throw new NetworkResourceError('RESOURCE_READ_FAILED', 'Identity-provider inventory is unavailable.'); }
    },
  });
  const subscriptions = new ResourceSubscriptionManager<NetworkConfig>({
    registrations: [identities],
    globals: [],
    notify: uri => server.server.sendResourceUpdated({ uri }),
  });
  options.onSubscriptionsReady?.(subscriptions);
  const sourceDefinition: BoundMcpResourceDefinition = {
    name: 'identity-sources',
    uri: 'ccd://identity-sources',
    title: 'Concordium Identity Sources',
    description: 'Safe enrolled identity-source summaries.',
    mimeType: 'application/json',
    async read(uri) {
      if (uri !== 'ccd://identity-sources') throw mcpInvalidArgument('The resource URI is invalid.');
      try {
        const listed = await sources.list();
        const defaultSource = listed.find(source => source.isDefault);
        return jsonResourceContent(uri, {
          sources: listed.map(({ id, label, availability }) => ({
            id, ...(label === undefined ? {} : { label }), availability,
          })),
          ...(defaultSource === undefined ? {} : { default: defaultSource.id }),
        });
      } catch {
        throw new NetworkResourceError('RESOURCE_READ_FAILED', 'Identity-source inventory is unavailable.');
      }
    },
  };
  const skillDefinitions: BoundMcpResourceDefinition[] = CONCORDIUM_IDENTITY_MCP_SKILLS.map(skill => ({
    name: skill.entry.frontmatter.name,
    uri: skill.entry.uri,
    title: skill.entry.frontmatter.name,
    description: skill.entry.frontmatter.description,
    mimeType: 'text/markdown',
    read(uri) {
      const file = skill.files[uri];
      if (file === undefined) throw mcpInvalidArgument('The resource URI is invalid.');
      return { uri: file.uri, mimeType: file.mimeType, text: file.text };
    },
  }));
  const identityDefinitions = identities.definitions.map(definition => ({
      ...definition,
      read: (uri: string) => subscriptions.read(uri),
    }));
  registerMcpResources(server, [
    ...identityDefinitions,
    ...identityProviders.definitions,
    sourceDefinition,
    ...skillDefinitions,
  ]);
  bindResourceSubscriptions(server, subscriptions, { transport: 'stdio' });
  return server;
}

/** Run the PIN-free identity MCP server over stdio. */
export async function runIdentityMcpServer(): Promise<void> {
  await serveStdio(async () => {
    const providers = createDefaultIdentityProviderService();
    const sources = createDefaultIdentitySourceService({ persistent: true });
    const store = createEncryptedIdentityStore();
    const workflow = createDefaultIdentityWorkflow({ providerPolicy: 'mcp', providers, sources, store });
    const networks = createNetworkResourceAdapter();
    let subscriptionPublisher: ResourceSubscriptionPublisher | undefined;
    const monitor = createIdentityMonitor({
      workflow, store,
      getIdentityRequestTimeoutMs: network => providers.getIdentityRequestTimeoutMs({
        network: resolveProviderNetwork(network),
      }),
      onChange: summary => {
        if (summary.status !== 'issued' && summary.status !== 'failed') return;
        try {
          const network = networks.resolve(caip2Reference(summary.network));
          subscriptionPublisher?.invalidate({ resourceName: 'identities', network: network.name });
        } catch {
          // A monitor result for a removed or renamed network has no current subscription scope.
        }
      },
    });
    const proofs = createDefaultIdentityProofService({ sources, store });
    let control: Awaited<ReturnType<typeof startIdentityManagerInstanceControlServer>> | undefined;
    try {
      const server = buildIdentityMcpServer(
        workflow, sources, providers, monitor, proofs, createIdentitySourceRegistry(), {
          onSubscriptionsReady: publisher => { subscriptionPublisher = publisher; },
        },
      );
      control = await startIdentityManagerInstanceControlServer({ refreshSources: () => sources.refresh() });
      let closePromise: Promise<void> | undefined;
      const closeRuntime = () => closePromise ??= closeIdentityManagerRuntime(control, monitor, sources);
      const closeResources = server.server.onclose;
      server.server.onclose = () => {
        closeResources?.();
        void closeRuntime();
      };
      const closeServer = server.close.bind(server);
      server.close = async () => {
        await closeServer();
        await closeRuntime();
      };
      monitor.start();
      return server;
    } catch (error) {
      await closeIdentityManagerRuntime(control, monitor, sources);
      throw error;
    }
  }, {
    onerror: () => console.error('ccd-id-manager-mcp: stdio transport failed.'),
  });
}

async function closeIdentityManagerRuntime(
  control: Awaited<ReturnType<typeof startIdentityManagerInstanceControlServer>> | undefined,
  monitor: IdentityMonitor,
  sources: IdentitySourceService,
): Promise<void> {
  await Promise.allSettled([control?.close(), monitor.stop()]);
  await Promise.allSettled([sources.close?.()]);
}
