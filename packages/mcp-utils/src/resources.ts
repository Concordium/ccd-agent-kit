import { ProtocolError, ProtocolErrorCode, ResourceTemplate, type McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import type { McpJsonValue } from './types.js';

/** Generic text resource content used by shared MCP resource adapters. */
export interface TextResourceContent {
  uri: string;
  mimeType: string;
  text: string;
}

/** SDK-independent MCP invalid-argument error shape used by resource readers. */
export interface McpInvalidArgumentError {
  kind: 'invalid-argument';
  message: string;
}

/** Builds a shared invalid-argument error for MCP adapters. */
export function mcpInvalidArgument(message: string): McpInvalidArgumentError {
  return { kind: 'invalid-argument', message };
}

/** Builds a shared invalid-argument error for unknown or mismatched resource URIs. */
export function invalidMcpResourceUri(_uri: string): McpInvalidArgumentError {
  return mcpInvalidArgument('The resource URI is invalid.');
}

/** Returns true when a thrown value is a shared MCP invalid-argument error. */
export function isMcpInvalidArgumentError(error: unknown): error is McpInvalidArgumentError {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { kind?: unknown }).kind === 'invalid-argument' &&
    typeof (error as { message?: unknown }).message === 'string'
  );
}

/** Stable public failure codes for network-scoped resource reads. */
export type NetworkResourceErrorCode =
  | 'NETWORK_NOT_FOUND'
  | 'RESOURCE_NOT_FOUND'
  | 'NODE_REQUEST_FAILED'
  | 'RESOURCE_READ_FAILED';

/** A resource failure whose message has been approved for public MCP output. */
export class NetworkResourceError extends Error {
  readonly code: NetworkResourceErrorCode;

  constructor(code: NetworkResourceErrorCode, message: string) {
    super(message);
    this.name = 'NetworkResourceError';
    this.code = code;
  }
}

/** Canonical configured network supplied to a resource family. */
export interface NetworkResourceNetwork<TNetwork> {
  name: string;
  caip2: `ccd:${string}`;
  value: TNetwork;
}

/** Injected network catalog boundary used by network resource families. */
export interface NetworkResourceAdapter<TNetwork> {
  list(): readonly NetworkResourceNetwork<TNetwork>[];
  resolveDefault(): NetworkResourceNetwork<TNetwork>;
  resolve(selector: string): NetworkResourceNetwork<TNetwork>;
}

/** One network-scoped resource family definition. */
export interface NetworkResourceFamily<TNetwork, TResult extends McpJsonValue> {
  name: string;
  title: string;
  description: string;
  path: string;
  read(input: {
    network: NetworkResourceNetwork<TNetwork>;
    parameters: Readonly<Record<string, string>>;
  }): Promise<TResult>;
  subscribable?: boolean;
}

/** MCP resource definition bound to its domain reader and optional discovery callbacks. */
export interface BoundMcpResourceDefinition {
  name: string;
  uri: string;
  title: string;
  description: string;
  mimeType?: string;
  subscribable?: boolean;
  read(uri: string): Promise<TextResourceContent> | TextResourceContent;
  list?(): Promise<Array<{ uri: string; name: string }>> | Array<{ uri: string; name: string }>;
  complete?(variable: string, value?: string): Promise<string[]> | string[];
}

/** Bound registration derived for one network resource family route. */
export interface NetworkResourceDefinition extends BoundMcpResourceDefinition {
  mimeType: 'application/json';
}

type ResourceRoute = {
  scope: 'default' | 'explicit' | 'wildcard';
  selector?: string;
  parameters: Readonly<Record<string, string>>;
};

const GENERIC_READ_FAILURE = 'The resource could not be read.';
const INVALID_RESOURCE_URI = 'The resource URI is invalid.';

function invalidResourceUri(): McpInvalidArgumentError {
  return mcpInvalidArgument(INVALID_RESOURCE_URI);
}

function publicResourceError(error: unknown): NetworkResourceError {
  return error instanceof NetworkResourceError
    ? error
    : new NetworkResourceError('RESOURCE_READ_FAILED', GENERIC_READ_FAILURE);
}

async function sdkResourceCall<TResult>(callback: () => TResult | Promise<TResult>): Promise<TResult> {
  try {
    return await callback();
  } catch (error) {
    if (isMcpInvalidArgumentError(error)) {
      throw new ProtocolError(ProtocolErrorCode.InvalidParams, error.message, { kind: error.kind });
    }
    const mapped = publicResourceError(error);
    const protocolCode = mapped.code === 'RESOURCE_READ_FAILED'
      ? ProtocolErrorCode.InternalError
      : ProtocolErrorCode.InvalidParams;
    throw new ProtocolError(protocolCode, mapped.message, { error: { code: mapped.code } });
  }
}

function parseFamilyPath(path: string): string[] {
  if (path.startsWith('/') || path.endsWith('/') || path.length === 0 || path.includes('%')) {
    throw new Error('Network resource family path must be a non-empty relative path.');
  }
  const segments = path.split('/');
  const names = segments.flatMap((segment) => /^\{([A-Za-z][A-Za-z0-9_]*)\}$/.exec(segment)?.slice(1) ?? []);
  if (segments.some((segment) => !/^[A-Za-z0-9._~-]+$/.test(segment) && !/^\{[A-Za-z][A-Za-z0-9_]*\}$/.test(segment))) {
    throw new Error('Invalid network resource family path segment.');
  }
  if (new Set(names).size !== names.length) throw new Error('Duplicate network resource path parameter.');
  return segments;
}

function matchSegments(
  pattern: readonly string[],
  segments: readonly string[],
): Readonly<Record<string, string>> | undefined {
  if (pattern.length !== segments.length) return undefined;
  const parameters: Record<string, string> = {};
  for (let index = 0; index < pattern.length; index += 1) {
    const expected = pattern[index]!;
    const actual = segments[index]!;
    if (actual.length === 0 || actual === '.' || actual === '..') return undefined;
    const parameter = /^\{(.+)\}$/.exec(expected)?.[1];
    if (parameter === undefined && expected !== actual) return undefined;
    if (parameter !== undefined) parameters[parameter] = actual;
  }
  return Object.freeze(parameters);
}

function parseResourceUri(uri: string): { authority: string; path: string[] } {
  const unsafe = [...uri].some((character) => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127);
  if (!uri.startsWith('ccd://') || /[%?#]/.test(uri) || unsafe) throw invalidResourceUri();
  const match = /^ccd:\/\/([^/]+)(?:\/(.*))?$/.exec(uri);
  if (match === null || match[1]!.includes('@') || match[1]!.includes(':')) throw invalidResourceUri();
  const tail = match[2];
  if (tail?.endsWith('/') === true || tail?.includes('//') === true) throw invalidResourceUri();
  return { authority: match[1]!, path: tail === undefined ? [] : tail.split('/') };
}

interface ResolvedResourceRoute<TNetwork> {
  route: ResourceRoute;
  networks: readonly NetworkResourceNetwork<TNetwork>[];
}

/** Registered routes and SDK-independent reader for one network resource family. */
export interface NetworkResourceRegistration<TNetwork = unknown> {
  definitions: readonly NetworkResourceDefinition[];
  read(uri: string): Promise<TextResourceContent>;
  complete(variable: string): Promise<string[]>;
  /** @internal Shared matcher used by the subscription manager. */
  readonly _resource: {
    name: string;
    subscribable: boolean;
    match(uri: string): ResourceRoute | undefined;
    resolve(route: ResourceRoute): ResolvedResourceRoute<TNetwork>;
    read(uri: string, pinned?: readonly NetworkResourceNetwork<TNetwork>[]): Promise<TextResourceContent>;
  };
}

/** Derives all routes, completion, reading, and observation metadata for one family. */
export function registerNetworkResourceFamily<TNetwork, TResult extends McpJsonValue>(
  adapter: NetworkResourceAdapter<TNetwork>,
  family: NetworkResourceFamily<TNetwork, TResult>,
): NetworkResourceRegistration<TNetwork> {
  const pattern = parseFamilyPath(family.path);
  const match = (uri: string): ResourceRoute | undefined => {
    const parsed = parseResourceUri(uri);
    const defaultParameters = matchSegments(pattern, [parsed.authority, ...parsed.path]);
    if (defaultParameters !== undefined) return { scope: 'default', parameters: defaultParameters };
    const explicitParameters = matchSegments(pattern, parsed.path);
    if (explicitParameters === undefined) return undefined;
    return parsed.authority === '*'
      ? { scope: 'wildcard', parameters: explicitParameters }
      : { scope: 'explicit', selector: parsed.authority, parameters: explicitParameters };
  };

  const resolve = (route: ResourceRoute): ResolvedResourceRoute<TNetwork> => {
    if (route.scope === 'wildcard') return { route, networks: adapter.list() };
    const selected = route.scope === 'default' ? adapter.resolveDefault() : adapter.resolve(route.selector!);
    return { route, networks: [selected] };
  };

  const readResolved = async (
    uri: string,
    resolved: ResolvedResourceRoute<TNetwork>,
  ): Promise<TextResourceContent> => {
    if (resolved.route.scope !== 'wildcard') {
      const network = resolved.networks[0]!;
      try {
        const result = await family.read({ network, parameters: resolved.route.parameters });
        return { uri, mimeType: 'application/json', text: JSON.stringify({ network: network.name, caip2: network.caip2, result }) };
      } catch (error) {
        throw publicResourceError(error);
      }
    }
    const networks: Record<string, unknown> = {};
    for (const network of resolved.networks) {
      try {
        const result = await family.read({ network, parameters: resolved.route.parameters });
        networks[network.name] = { network: network.name, caip2: network.caip2, result };
      } catch (error) {
        const mapped = publicResourceError(error);
        networks[network.name] = {
          network: network.name,
          caip2: network.caip2,
          error: { code: mapped.code, message: mapped.message },
        };
      }
    }
    return { uri, mimeType: 'application/json', text: JSON.stringify({ networks }) };
  };

  const internalRead = async (
    uri: string,
    pinned?: readonly NetworkResourceNetwork<TNetwork>[],
  ): Promise<TextResourceContent> => {
    const route = match(uri);
    if (route === undefined) throw invalidResourceUri();
    let resolved: ResolvedResourceRoute<TNetwork>;
    if (pinned === undefined) {
      resolved = resolve(route);
    } else {
      const networks = pinned.map((network) => {
        const current = adapter.resolve(network.caip2.slice('ccd:'.length));
        if (current.name !== network.name || current.caip2 !== network.caip2) {
          throw new NetworkResourceError('NETWORK_NOT_FOUND', 'The subscribed network is no longer configured.');
        }
        return current;
      });
      resolved = { route, networks };
    }
    return readResolved(uri, resolved);
  };

  const complete = async (variable: string): Promise<string[]> => {
    if (variable !== 'network') return [];
    const values = new Set(adapter.list().flatMap(({ name, caip2 }) => [name, caip2.slice('ccd:'.length)]));
    return [...values].sort();
  };

  return {
    definitions: (['default', 'explicit', 'wildcard'] as const).map((scope) => ({
      name: `${family.name}-${scope}`,
      uri: scope === 'default' ? `ccd://${family.path}` : `ccd://${scope === 'explicit' ? '{network}' : '*'}/${family.path}`,
      title: family.title,
      description: family.description,
      mimeType: 'application/json',
      subscribable: family.subscribable,
      read: internalRead,
      complete,
    })),
    read: internalRead,
    complete,
    _resource: {
      name: family.name,
      subscribable: family.subscribable === true,
      match,
      resolve,
      read: internalRead,
    },
  };
}

/** Registers bound resource definitions directly with the MCP SDK. */
export function registerMcpResources(server: McpServer, definitions: readonly BoundMcpResourceDefinition[]): void {
  for (const definition of definitions) {
    const metadata = {
      title: definition.title,
      description: definition.description,
      mimeType: definition.mimeType,
    };
    const read = (uri: URL) => sdkResourceCall(async () => ({ contents: [await definition.read(uri.href)] }));
    const variables = [...definition.uri.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)].map((match) => match[1]!);
    if (variables.length === 0) {
      server.registerResource(definition.name, definition.uri, metadata, read);
      continue;
    }
    const complete = definition.complete === undefined
      ? undefined
      : Object.fromEntries(variables.map((variable) => [
        variable,
        (value: string) => sdkResourceCall(() => definition.complete!(variable, value)),
      ]));
    const template = new ResourceTemplate(definition.uri, {
      list: definition.list === undefined
        ? undefined
        : () => sdkResourceCall(async () => ({ resources: await definition.list!() })),
      complete,
    });
    server.registerResource(definition.name, template, metadata, read);
  }
}

/** One semantic resource invalidation published by a domain runtime. */
export interface ResourceInvalidation {
  resourceName: string;
  network?: string;
}

/** Minimal invalidation publisher exposed to domain runtimes. */
export interface ResourceSubscriptionPublisher {
  invalidate(invalidation: ResourceInvalidation): void;
}

type Subscription<TNetwork> = {
  resourceName: string;
  registration?: NetworkResourceRegistration<TNetwork>;
  networks?: readonly NetworkResourceNetwork<TNetwork>[];
};

/** Tracks exact subscribed URIs and publishes matching semantic invalidations. */
export class ResourceSubscriptionManager<TNetwork = unknown> implements ResourceSubscriptionPublisher {
  readonly #subscriptions = new Map<string, Subscription<TNetwork>>();
  #closed = false;

  constructor(readonly input: {
    registrations: readonly NetworkResourceRegistration<TNetwork>[];
    globals: readonly { name: string; uri: string }[];
    notify(uri: string): Promise<void> | void;
  }) {}

  /** Pins one exact eligible URI to its current network scope. */
  async subscribe(uri: string): Promise<void> {
    if (this.#closed || this.#subscriptions.has(uri)) return;
    const global = this.input.globals.find((candidate) => candidate.uri === uri);
    if (global !== undefined) {
      this.#subscriptions.set(uri, { resourceName: global.name });
      return;
    }
    for (const registration of this.input.registrations) {
      let route: ResourceRoute | undefined;
      try {
        route = registration._resource.match(uri);
      } catch {
        throw invalidResourceUri();
      }
      if (route === undefined) continue;
      if (!registration._resource.subscribable) throw invalidResourceUri();
      const resolved = registration._resource.resolve(route);
      this.#subscriptions.set(uri, {
        resourceName: registration._resource.name,
        registration,
        networks: resolved.networks,
      });
      return;
    }
    throw invalidResourceUri();
  }

  /** Removes one exact subscribed URI. */
  async unsubscribe(uri: string): Promise<void> {
    this.#subscriptions.delete(uri);
  }

  /** Reads a URI using its pinned network identities when subscribed. */
  async read(uri: string): Promise<TextResourceContent> {
    const subscription = this.#subscriptions.get(uri);
    if (subscription?.registration !== undefined) {
      return subscription.registration._resource.read(uri, subscription.networks);
    }
    const registration = this.input.registrations.find((candidate) => candidate._resource.match(uri) !== undefined);
    if (registration === undefined) throw invalidResourceUri();
    return registration.read(uri);
  }

  /** Publishes one best-effort update to every matching exact URI. */
  invalidate({ resourceName, network }: ResourceInvalidation): void {
    if (this.#closed) return;
    for (const [uri, subscription] of this.#subscriptions) {
      if (subscription.resourceName !== resourceName) continue;
      if (subscription.networks !== undefined && network === undefined) continue;
      if (network !== undefined && !subscription.networks?.some((candidate) => candidate.name === network)) continue;
      void Promise.resolve().then(() => this.input.notify(uri)).catch(() => undefined);
    }
  }

  /** Clears all subscriptions idempotently. */
  async close(): Promise<void> {
    this.#closed = true;
    this.#subscriptions.clear();
  }
}

/** Installs stdio-only MCP subscription handlers and clears subscriptions when the server closes. */
export function bindResourceSubscriptions(
  server: McpServer,
  manager: ResourceSubscriptionManager,
  options: { transport: 'stdio' | 'http' },
): void {
  if (options.transport !== 'stdio') return;
  server.server.registerCapabilities({ resources: { subscribe: true } });
  const uriRequest = { params: z.object({ uri: z.string() }) };
  server.server.setRequestHandler('resources/subscribe', uriRequest, async ({ uri }) => {
    await sdkResourceCall(() => manager.subscribe(uri));
    return {};
  });
  server.server.setRequestHandler('resources/unsubscribe', uriRequest, async ({ uri }) => {
    await sdkResourceCall(() => manager.unsubscribe(uri));
    return {};
  });
  const priorClose = server.server.onclose;
  server.server.onclose = () => {
    try {
      priorClose?.();
    } finally {
      void manager.close();
    }
  };
}
