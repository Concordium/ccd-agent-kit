import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { createConnection, createServer, type Server } from 'node:net';
import { join } from 'node:path';
import { serializeJsonFile } from './json.js';

const INSTANCE_HEARTBEAT_MS = 60_000;
const INSTANCE_STALE_MS = 60 * 60_000;

/** Supported isolated runtime namespaces for local MCP instance control. */
export const MCP_INSTANCE_NAMESPACES = {
  signer: 'signer',
  idManager: 'id-manager',
} as const;

/** An isolated runtime namespace for local MCP instance control. */
export type McpInstanceNamespace = (typeof MCP_INSTANCE_NAMESPACES)[keyof typeof MCP_INSTANCE_NAMESPACES];

/** Public process metadata attached to a caller-owned MCP instance status. */
export interface McpInstanceMetadata {
  /** Owning process identifier. */
  pid?: number;
  /** Parent process identifier. */
  parentPid?: number;
  /** ISO timestamp when the process registered itself. */
  startedAt?: string;
  /** ISO timestamp when the process last refreshed its registry entry. */
  lastSeenAt?: string;
  /** Network selected by the process when known. */
  network?: string;
}

/** A caller-owned public status combined with safe process metadata. */
export type McpInstanceRegistryEntry<TStatus extends { instanceId: string }> = TStatus & McpInstanceMetadata;

/** Options for writing a public MCP instance registry entry. */
export interface RegisterMcpInstanceOptions {
  /** Network selected by the process when known. */
  network?: string;
}

/** Options for starting an authenticated local MCP instance control server. */
export interface StartMcpInstanceControlOptions extends RegisterMcpInstanceOptions {
  /** Handles an authenticated domain request without owning transport or authentication. */
  handleRequest: (request: Record<string, unknown>) => Promise<Record<string, unknown>> | Record<string, unknown>;
}

/** A running local instance control server. Its socket path is protected operational data and must not be publicly projected. */
export interface McpInstanceControlServer<TStatus extends { instanceId: string }> {
  /** Safe public registration for the running process. */
  instance: McpInstanceRegistryEntry<TStatus>;
  /** Protected local socket path used by package adapters. */
  socketPath: string;
  /** Stops the server and best-effort removes its registry and socket files. */
  close: () => Promise<void>;
}

/** Configuration for one namespace-isolated MCP instance controller. */
export interface CreateMcpInstanceControlOptions<TStatus extends { instanceId: string }> {
  /** Constant namespace owned by the consuming package. */
  namespace: McpInstanceNamespace;
  /** Returns the package's state directory, which already includes `ccd-agent-kit`. */
  stateDir: () => string;
  /** Returns the current caller-owned safe public status. */
  getStatus: () => TStatus;
  /** Strictly parses and projects caller-owned public status from an unknown sidecar object. */
  parseStatus: (raw: unknown) => TStatus | undefined;
  /** Human-readable instance kind used only in local connection errors. */
  instanceKind?: string;
}

/** Configuration for read/write client access to one namespace-isolated MCP instance registry. */
export type CreateMcpInstanceClientOptions<TStatus extends { instanceId: string }> = Omit<
  CreateMcpInstanceControlOptions<TStatus>,
  'getStatus'
>;

/** Authenticated client operations for one namespace-isolated MCP instance registry. */
export interface McpInstanceClient<TStatus extends { instanceId: string }> {
  /** Returns the private runtime registry directory for this namespace. */
  getRegistryDir: () => string;
  /** Lists safe public entries after pruning stale and dead processes. */
  list: () => Array<McpInstanceRegistryEntry<TStatus>>;
  /** Sends one authenticated domain request to a selected running process. */
  request: (instanceId: string, request: Record<string, unknown>, timeoutMs?: number) => Promise<Record<string, unknown>>;
  /** Sends a best-effort bounded request sequentially to every registered process. */
  notifyAll: (request: Record<string, unknown>, timeoutMs?: number) => Promise<void>;
}

/** Namespace-isolated local registry and authenticated control operations. */
export interface McpInstanceControl<TStatus extends { instanceId: string }> extends McpInstanceClient<TStatus> {
  /** Writes a public registration without starting a control socket. */
  register: (options?: RegisterMcpInstanceOptions) => McpInstanceRegistryEntry<TStatus>;
  /** Starts an authenticated local control socket and heartbeat. */
  start: (options: StartMcpInstanceControlOptions) => Promise<McpInstanceControlServer<TStatus>>;
  /** Rewrites the current private registration with the latest caller-owned status. */
  updateRegistration: () => void;
}

interface PrivateRegistryFields {
  authToken?: string;
  socketPath?: string;
}

type PrivateRegistryEntry<TStatus extends { instanceId: string }> = McpInstanceRegistryEntry<TStatus> & PrivateRegistryFields;

/** Creates a random eight-character process-local MCP instance identifier. */
export function createMcpInstanceId(): string {
  return randomUUID().replaceAll('-', '').slice(0, 8);
}

/** Creates generic filesystem, registry, socket, authentication, and lifecycle control for one MCP namespace. */
export function createMcpInstanceControl<TStatus extends { instanceId: string }>(
  options: CreateMcpInstanceControlOptions<TStatus>,
): McpInstanceControl<TStatus> {
  const { getStatus, ...clientOptions } = options;
  const { client, ensureRegistryDir, findPrivateEntry, publicEntry, removeEntry, writeEntry } =
    createMcpInstanceClientOperations(clientOptions);

  function writePrivateEntry(input: PrivateRegistryFields & RegisterMcpInstanceOptions & { startedAt: string }): PrivateRegistryEntry<TStatus> {
    const entry: PrivateRegistryEntry<TStatus> = {
      ...getStatus(),
      authToken: input.authToken,
      socketPath: input.socketPath,
      pid: process.pid,
      parentPid: process.ppid,
      startedAt: input.startedAt,
      lastSeenAt: new Date().toISOString(),
      ...(input.network === undefined ? {} : { network: input.network }),
    };
    writeEntry(entry);
    return entry;
  }

  function register(registerOptions: RegisterMcpInstanceOptions = {}): McpInstanceRegistryEntry<TStatus> {
    return publicEntry(writePrivateEntry({ network: registerOptions.network, startedAt: new Date().toISOString() }));
  }

  function updateRegistration(): void {
    const status = getStatus();
    const existing = findPrivateEntry(status.instanceId);
    if (existing?.authToken === undefined || existing.socketPath === undefined) return;
    writePrivateEntry({
      authToken: existing.authToken,
      network: existing.network,
      socketPath: existing.socketPath,
      startedAt: existing.startedAt ?? new Date().toISOString(),
    });
  }

  async function start(startOptions: StartMcpInstanceControlOptions): Promise<McpInstanceControlServer<TStatus>> {
    const status = getStatus();
    const socketPath = join(client.getRegistryDir(), `${status.instanceId}.sock`);
    const authToken = randomBytes(32).toString('hex');
    const server = createServer({ allowHalfOpen: true }, (socket) => {
      let requestBody = '';
      socket.setEncoding('utf8');
      socket.on('data', (chunk) => { requestBody += chunk; });
      socket.on('end', async () => {
        const response = await handleRequest(requestBody, authToken, startOptions.handleRequest);
        socket.end(`${JSON.stringify(response)}\n`);
      });
    });
    ensureRegistryDir();
    if (existsSync(socketPath)) unlinkSync(socketPath);
    const startedAt = new Date().toISOString();
    const entry = writePrivateEntry({ authToken, network: startOptions.network, socketPath, startedAt });
    try {
      await listen(server, socketPath);
    } catch (error) {
      await closeServer(server).catch(() => undefined);
      removeEntry(status.instanceId, socketPath);
      throw error;
    }
    const heartbeat = setInterval(() => {
      writePrivateEntry({ authToken, network: startOptions.network, socketPath, startedAt });
    }, INSTANCE_HEARTBEAT_MS);
    heartbeat.unref?.();
    return {
      instance: publicEntry(entry),
      socketPath,
      close: async () => {
        clearInterval(heartbeat);
        await closeServer(server).catch(() => undefined);
        removeEntry(status.instanceId, socketPath);
      },
    };
  }

  return { ...client, register, start, updateRegistration };
}

/** Creates generic safe discovery and authenticated request operations for an MCP instance namespace. */
export function createMcpInstanceClient<TStatus extends { instanceId: string }>(
  options: CreateMcpInstanceClientOptions<TStatus>,
): McpInstanceClient<TStatus> {
  return createMcpInstanceClientOperations(options).client;
}

function createMcpInstanceClientOperations<TStatus extends { instanceId: string }>(
  options: CreateMcpInstanceClientOptions<TStatus>,
) {
  const instanceKind = options.instanceKind ?? 'MCP instance';

  function getRegistryDir(): string {
    const runtimeRoot = process.env.XDG_RUNTIME_DIR;
    return runtimeRoot === undefined
      ? join(options.stateDir(), 'runtime', options.namespace, 'instances')
      : join(runtimeRoot, 'ccd-agent-kit', options.namespace, 'instances');
  }

  function ensureRegistryDir(): string {
    const registryDir = getRegistryDir();
    if (!existsSync(registryDir)) mkdirSync(registryDir, { recursive: true, mode: 0o700 });
    return registryDir;
  }

  function parsePrivateEntry(filePath: string): PrivateRegistryEntry<TStatus> | undefined {
    try {
      const raw = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
      const status = options.parseStatus(raw);
      if (status === undefined || typeof raw !== 'object' || raw === null) return undefined;
      const fields = raw as Record<string, unknown>;
      return {
        ...status,
        ...(typeof fields.pid === 'number' ? { pid: fields.pid } : {}),
        ...(typeof fields.parentPid === 'number' ? { parentPid: fields.parentPid } : {}),
        ...(typeof fields.startedAt === 'string' ? { startedAt: fields.startedAt } : {}),
        ...(typeof fields.lastSeenAt === 'string' ? { lastSeenAt: fields.lastSeenAt } : {}),
        ...(typeof fields.network === 'string' ? { network: fields.network } : {}),
        ...(typeof fields.socketPath === 'string' ? { socketPath: fields.socketPath } : {}),
        ...(typeof fields.authToken === 'string' ? { authToken: fields.authToken } : {}),
      };
    } catch {
      return undefined;
    }
  }

  function publicEntry(entry: PrivateRegistryEntry<TStatus>): McpInstanceRegistryEntry<TStatus> {
    const safe = { ...entry } as unknown as Record<string, unknown>;
    delete safe.authToken;
    delete safe.socketPath;
    return safe as McpInstanceRegistryEntry<TStatus>;
  }

  function writeEntry(entry: PrivateRegistryEntry<TStatus>): void {
    writeFileSync(join(ensureRegistryDir(), `${entry.instanceId}.json`), serializeJsonFile(entry), {
      encoding: 'utf8',
      mode: 0o600,
    });
  }

  function removeEntry(instanceId: string, socketPath?: string): void {
    for (const filePath of [join(getRegistryDir(), `${instanceId}.json`), socketPath]) {
      if (filePath === undefined) continue;
      try {
        if (existsSync(filePath)) unlinkSync(filePath);
      } catch {
        // Cleanup must not mask shutdown, failed delivery, or stale-entry pruning.
      }
    }
  }

  function isStale(entry: PrivateRegistryEntry<TStatus>): boolean {
    if (entry.lastSeenAt !== undefined && Date.now() - Date.parse(entry.lastSeenAt) > INSTANCE_STALE_MS) return true;
    if (entry.pid === undefined) return false;
    try {
      process.kill(entry.pid, 0);
      return false;
    } catch {
      return true;
    }
  }

  function findPrivateEntry(instanceId: string): PrivateRegistryEntry<TStatus> | undefined {
    const registryDir = getRegistryDir();
    if (!existsSync(registryDir)) return undefined;
    return parsePrivateEntry(join(registryDir, `${instanceId}.json`));
  }

  function resolveControlEntry(instanceId: string): PrivateRegistryEntry<TStatus> & { authToken: string; socketPath: string } {
    const entry = findPrivateEntry(instanceId);
    if (entry === undefined || entry.authToken === undefined || entry.socketPath === undefined || isStale(entry)) {
      if (entry !== undefined) removeEntry(entry.instanceId, entry.socketPath);
      throw new Error(`${instanceKind} ${instanceId} is not running.`);
    }
    return { ...entry, authToken: entry.authToken, socketPath: entry.socketPath };
  }

  function list(): Array<McpInstanceRegistryEntry<TStatus>> {
    const registryDir = getRegistryDir();
    if (!existsSync(registryDir)) return [];
    const entries: Array<McpInstanceRegistryEntry<TStatus>> = [];
    for (const fileName of readdirSync(registryDir).filter((name) => name.endsWith('.json'))) {
      const entry = parsePrivateEntry(join(registryDir, fileName));
      if (entry === undefined) continue;
      if (isStale(entry)) removeEntry(entry.instanceId, entry.socketPath);
      else entries.push(publicEntry(entry));
    }
    return entries;
  }

  async function request(instanceId: string, body: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>> {
    const entry = resolveControlEntry(instanceId);
    try {
      return await sendControlRequest(entry.socketPath, { ...body, authToken: entry.authToken }, timeoutMs);
    } catch (error) {
      removeEntry(entry.instanceId, entry.socketPath);
      const connectionKind = instanceKind === 'MCP instance'
        ? instanceKind
        : `${instanceKind.charAt(0).toLowerCase()}${instanceKind.slice(1)}`;
      throw new Error(`Could not connect to ${connectionKind} ${entry.instanceId}.`, { cause: error });
    }
  }

  async function notifyAll(body: Record<string, unknown>, timeoutMs = 5_000): Promise<void> {
    try {
      for (const entry of list()) {
        try {
          const target = resolveControlEntry(entry.instanceId);
          await sendControlRequest(target.socketPath, { ...body, authToken: target.authToken }, timeoutMs);
        } catch {
          // One unavailable process must not prevent notifications to the others.
        }
      }
    } catch {
      // Registry access must not fail a completed domain operation.
    }
  }

  return { client: { getRegistryDir, list, notifyAll, request }, ensureRegistryDir, findPrivateEntry, publicEntry, removeEntry, writeEntry };
}

async function handleRequest(
  body: string,
  authToken: string,
  handler: StartMcpInstanceControlOptions['handleRequest'],
): Promise<Record<string, unknown>> {
  try {
    const request = JSON.parse(body) as Record<string, unknown>;
    if (typeof request.authToken !== 'string' || !sameToken(request.authToken, authToken)) {
      return { ok: false, error: 'unauthorized' };
    }
    return await handler(request);
  } catch {
    return { ok: false, error: 'invalid-json' };
  }
}

function sameToken(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'hex');
  const rightBytes = Buffer.from(right, 'hex');
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function listen(server: Server, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

function sendControlRequest(
  socketPath: string,
  request: Record<string, unknown>,
  timeoutMs?: number,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    const timer = timeoutMs === undefined ? undefined : setTimeout(() => socket.destroy(new Error('Instance request timed out.')), timeoutMs);
    socket.once('close', () => clearTimeout(timer));
    let response = '';
    socket.setEncoding('utf8');
    socket.once('error', reject);
    socket.on('data', (chunk) => { response += chunk; });
    socket.on('end', () => {
      try {
        resolve(JSON.parse(response) as Record<string, unknown>);
      } catch (error) {
        reject(error);
      }
    });
    socket.on('connect', () => { socket.end(JSON.stringify(request)); });
  });
}
