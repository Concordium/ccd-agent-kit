import { vi } from 'vitest';

import type { IdentityMonitor } from '../../src/core/identityMonitor.js';
import type { IdentityProofService } from '../../src/core/identityProofs.js';
import type { IdentityProviderService } from '../../src/core/providers/types.js';
import type { IdentitySourceService } from '../../src/core/sources/types.js';
import type { IdentityWorkflow } from '../../src/core/workflowTypes.js';
import type { IdentitySourceRegistry } from '@ccd-agent-kit/config-utils';

export interface AdapterToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

export interface AdapterResourceResult {
  contents: Array<{ uri: string; mimeType?: string; text: string }>;
}

type ToolHandler = (input: Record<string, unknown>) => Promise<AdapterToolResult>;
type ToolInputSchema = { parse(input: Record<string, unknown>): Record<string, unknown> };
type ResourceHandler = (uri: URL) => Promise<AdapterResourceResult>;
type RequestHandler = (params: Record<string, unknown>) => Promise<object>;
type ResourceTemplateOptions = {
  complete?: Record<string, () => Promise<string[]>>;
};
type ResourceConfiguration = {
  list?: () => Promise<Array<{ uri: string; name: string }>>;
};

const captured = vi.hoisted(() => ({
  tools: new Map<string, ToolHandler>(),
  toolSchemas: new Map<string, ToolInputSchema>(),
  resources: new Map<string, ResourceHandler>(),
  resourceConfigurations: new Map<string, ResourceConfiguration>(),
  resourceTemplates: new Map<string, ResourceTemplateOptions>(),
  requests: new Map<string, RequestHandler>(),
  notifications: vi.fn(async (_notification: { uri: string }) => undefined),
}));

vi.mock('@modelcontextprotocol/server', () => {
  class MockResourceTemplate {
    public constructor(
      public readonly uriTemplate: string,
      public readonly options: ResourceTemplateOptions = {},
    ) {}
  }

  class MockMcpServer {
    public readonly server = {
      setRequestHandler: (method: string, schemaOrHandler: unknown, handler?: RequestHandler) =>
        captured.requests.set(method, handler ?? schemaOrHandler as RequestHandler),
      registerCapabilities: vi.fn(),
      sendResourceUpdated: captured.notifications,
    };

    public registerTool(name: string, configuration: { inputSchema: ToolInputSchema }, handler: ToolHandler): void {
      captured.tools.set(name, handler);
      captured.toolSchemas.set(name, configuration.inputSchema);
    }

    public registerResource(
      name: string,
      uri: string | MockResourceTemplate,
      configuration: ResourceConfiguration,
      handler: ResourceHandler,
    ): void {
      captured.resources.set(name, handler);
      captured.resourceConfigurations.set(name, configuration);
      if (uri instanceof MockResourceTemplate) captured.resourceTemplates.set(name, uri.options);
    }
  }

  class MockProtocolError extends Error {
    public constructor(public readonly code: number, message: string) {
      super(message);
    }
  }

  return {
    McpServer: MockMcpServer,
    ProtocolError: MockProtocolError,
    ProtocolErrorCode: { InvalidParams: -32602 },
    ResourceTemplate: MockResourceTemplate,
  };
});

export async function captureIdentityMcpAdapter(input: {
  workflow: IdentityWorkflow;
  sources: IdentitySourceService;
  providers: IdentityProviderService;
  monitor?: IdentityMonitor;
  proofs?: IdentityProofService;
  sourceRegistry?: IdentitySourceRegistry;
}): Promise<void> {
  captured.tools.clear();
  captured.toolSchemas.clear();
  captured.resources.clear();
  captured.resourceConfigurations.clear();
  captured.resourceTemplates.clear();
  captured.requests.clear();
  captured.notifications.mockReset();
  captured.notifications.mockResolvedValue(undefined);
  const { buildIdentityMcpServer } = await import('../../src/mcp/server.js');
  buildIdentityMcpServer(
    input.workflow, input.sources, input.providers, input.monitor, input.proofs, input.sourceRegistry,
  );
}

export function tool(name: string): ToolHandler {
  const handler = captured.tools.get(name);
  const schema = captured.toolSchemas.get(name);
  if (handler === undefined) throw new Error(`Tool ${name} was not registered`);
  if (schema === undefined) throw new Error(`Tool ${name} has no input schema`);
  return input => handler(schema.parse(input));
}

export function resource(name: string): ResourceHandler {
  const handler = captured.resources.get(name);
  if (handler === undefined) throw new Error(`Resource ${name} was not registered`);
  return handler;
}

export async function resourceListing(name: string): Promise<Array<{ uri: string; name: string }>> {
  const list = captured.resourceConfigurations.get(name)?.list;
  if (list === undefined) throw new Error(`Resource ${name} has no list handler`);
  return list();
}

export async function resourceTemplateCompletion(name: string, variable: string): Promise<string[]> {
  const complete = captured.resourceTemplates.get(name)?.complete?.[variable];
  if (complete === undefined) throw new Error(`Resource ${name} has no completion for ${variable}`);
  return complete();
}

export function requestHandler(method: string): RequestHandler {
  const handler = captured.requests.get(method);
  if (handler === undefined) throw new Error(`Request handler ${method} was not registered`);
  return handler;
}

export function rejectResourceNotifications(error: Error): void {
  captured.notifications.mockRejectedValue(error);
}

export function resourceNotificationUris(): string[] {
  return captured.notifications.mock.calls.map(([notification]) => notification.uri);
}

export function toolPayload(result: AdapterToolResult): unknown {
  return JSON.parse(result.content.map(entry => entry.text).join(''));
}

export function toolText(result: AdapterToolResult): string {
  return result.content.map(entry => entry.text).join('');
}

export function resourcePayload(result: AdapterResourceResult): unknown {
  const first = result.contents[0];
  if (first === undefined) throw new Error('Resource returned no content');
  return JSON.parse(first.text);
}
