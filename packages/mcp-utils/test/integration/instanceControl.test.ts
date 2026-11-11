import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { createMcpInstanceClient, createMcpInstanceControl, MCP_INSTANCE_NAMESPACES } from '../../src/instanceControl.js';
import { makeControl, makeScratch, type TestStatus } from '../instanceControlHelpers.js';

vi.mock('node:net', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:net')>();
  return { ...actual, createConnection: vi.fn(actual.createConnection) };
});

async function rawSocketPayload(socketPath: string, payload: string): Promise<Record<string, unknown>> {
  return await new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let response = '';
    socket.setEncoding('utf8');
    socket.once('error', reject);
    socket.on('data', (chunk) => { response += chunk; });
    socket.on('end', () => { resolve(JSON.parse(response) as Record<string, unknown>); });
    socket.on('connect', () => { socket.end(payload); });
  });
}

async function rawSocketRequest(socketPath: string, request: Record<string, unknown>): Promise<Record<string, unknown>> {
  return await rawSocketPayload(socketPath, JSON.stringify(request));
}

describe('generic MCP instance control', () => {
  it('serves authenticated domain requests, updates status, and cleans up', async () => {
    const { control, root, setStatus, status } = makeControl();
    const client = createMcpInstanceClient({
      namespace: MCP_INSTANCE_NAMESPACES.signer,
      stateDir: () => root,
      parseStatus: (raw) => raw as TestStatus,
    });
    const server = await control.start({
      network: 'testnet',
      handleRequest: async (request) => {
        if (request.type !== 'change') return { ok: false, error: 'unsupported-request' };
        setStatus({ ...status(), state: 'ready' });
        control.updateRegistration();
        return { ok: true, state: 'ready' };
      },
    });
    try {
      expect(server.instance).not.toHaveProperty('authToken');
      expect(server.instance).not.toHaveProperty('socketPath');
      expect(await rawSocketRequest(server.socketPath, { authToken: '00', type: 'change' }))
        .toEqual({ ok: false, error: 'unauthorized' });
      expect(await rawSocketPayload(server.socketPath, '{')).toEqual({ ok: false, error: 'invalid-json' });
      expect(await client.request(status().instanceId, { type: 'throw' })).toEqual({ ok: false, error: 'unsupported-request' });
      expect(await client.request(status().instanceId, { type: 'change' })).toEqual({ ok: true, state: 'ready' });
      expect(control.list()[0]).toMatchObject({ state: 'ready', network: 'testnet' });

      const registryFile = join(control.getRegistryDir(), `${status().instanceId}.json`);
      const privateEntry = JSON.parse(readFileSync(registryFile, 'utf8')) as Record<string, unknown>;
      delete privateEntry.startedAt;
      writeFileSync(registryFile, JSON.stringify(privateEntry));
      control.updateRegistration();
      expect(control.list()[0]?.startedAt).toEqual(expect.any(String));
    } finally {
      await server.close();
    }
    await server.close();
    expect(control.list()).toEqual([]);
  });

  it('rejects unavailable targets and removes registrations after connection failure', async () => {
    const { control, status } = makeControl();
    await expect(control.request('missing', { type: 'test' })).rejects.toThrow('MCP instance missing is not running');

    const server = await control.start({ handleRequest: () => ({ ok: true }) });
    await server.close();
    control.register();
    const path = join(control.getRegistryDir(), `${status().instanceId}.json`);
    const entry = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    entry.socketPath = server.socketPath;
    entry.authToken = '00'.repeat(32);
    writeFileSync(path, JSON.stringify(entry));
    await expect(control.request(status().instanceId, { type: 'test' })).rejects.toThrow('Could not connect to MCP instance');
    expect(control.list()).toEqual([]);
  });

  it('notifies instances sequentially and bounds stalled instances without pruning them', async () => {
    const firstSetup = makeControl();
    const { control, root } = firstSetup;
    const order: string[] = [];
    firstSetup.setStatus({ instanceId: 'a-first', command: 'first command', state: 'ready' });
    let releaseFirst!: () => void;
    const firstRelease = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let receiveFirst!: () => void;
    const firstReceived = new Promise<void>((resolve) => { receiveFirst = resolve; });
    const first = await control.start({ handleRequest: async () => {
      order.push('first');
      receiveFirst();
      await firstRelease;
      return { ok: true };
    } });
    const secondSetup = makeControl(root);
    const secondControl = secondSetup.control;
    secondSetup.setStatus({ instanceId: 'b-second', command: 'second command', state: 'ready' });
    const secondHandler = vi.fn(async () => { order.push('second'); return { ok: true }; });
    const second = await secondControl.start({ handleRequest: secondHandler });
    const stalledId = 'z-stalled';
    const stalledSocketPath = join(control.getRegistryDir(), `${stalledId}.sock`);
    const stalledSockets: Array<import('node:net').Socket> = [];
    let received!: () => void;
    const stalledRequest = new Promise<void>((resolveReceived) => { received = resolveReceived; });
    const stalledServer = createServer({ allowHalfOpen: true }, (socket) => {
      stalledSockets.push(socket);
      socket.on('data', received);
    });
    await new Promise<void>((resolveReady) => { stalledServer.listen(stalledSocketPath, resolveReady); });
    const stalledRegistryPath = join(control.getRegistryDir(), `${stalledId}.json`);
    writeFileSync(stalledRegistryPath, JSON.stringify({
      instanceId: stalledId,
      command: 'stalled command',
      state: 'blocked',
      authToken: 'ab'.repeat(32),
      socketPath: stalledSocketPath,
    }));
    vi.useFakeTimers();
    let notification: Promise<void> | undefined;
    try {
      const connectionSpy = vi.mocked(createConnection);
      connectionSpy.mockClear();
      notification = control.notifyAll({ type: 'refresh' });
      await firstReceived;
      expect(connectionSpy).toHaveBeenCalledTimes(1);
      expect(connectionSpy).toHaveBeenCalledWith(first.socketPath);
      expect(secondHandler).not.toHaveBeenCalled();
      releaseFirst();
      await stalledRequest;
      expect(secondHandler).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(5_001);
      await expect(notification).resolves.toBeUndefined();
      expect(order).toEqual(['first', 'second']);
      expect(existsSync(stalledRegistryPath)).toBe(true);
    } finally {
      releaseFirst();
      if (notification !== undefined) {
        await stalledRequest;
        await vi.advanceTimersByTimeAsync(5_001);
        await notification.catch(() => undefined);
      }
      vi.useRealTimers();
      for (const socket of stalledSockets) socket.destroy();
      await new Promise<void>((resolveClosed) => { stalledServer.close(() => resolveClosed()); });
      await first.close();
      await second.close();
    }
  });

  it('replaces stale socket files and refreshes heartbeat registrations', async () => {
    const { control, status } = makeControl();
    mkdirSync(control.getRegistryDir(), { recursive: true });
    writeFileSync(join(control.getRegistryDir(), `${status().instanceId}.sock`), 'stale');
    vi.useFakeTimers();
    const server = await control.start({ handleRequest: () => ({ ok: true }) });
    try {
      const before = control.list()[0]?.lastSeenAt;
      vi.setSystemTime(Date.now() + 61_000);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(control.list()[0]?.lastSeenAt).not.toBe(before);
    } finally {
      vi.useRealTimers();
      await server.close();
    }
  });

  it('sanitizes malformed control responses with a custom instance kind', async () => {
    const root = makeScratch();
    const setup = makeControl(root);
    const control = createMcpInstanceControl<TestStatus>({
      namespace: MCP_INSTANCE_NAMESPACES.signer,
      stateDir: () => root,
      getStatus: setup.status,
      parseStatus: (raw) => {
        if (typeof raw !== 'object' || raw === null) return undefined;
        const value = raw as Partial<TestStatus>;
        return typeof value.instanceId === 'string' && typeof value.command === 'string'
          ? { instanceId: value.instanceId, command: value.command, state: 'blocked' }
          : undefined;
      },
      instanceKind: 'Test instance',
    });
    const socketPath = join(control.getRegistryDir(), `${setup.status().instanceId}.sock`);
    mkdirSync(control.getRegistryDir(), { recursive: true });
    const server = createServer((socket) => { socket.end('not-json'); });
    await new Promise<void>((resolveReady) => { server.listen(socketPath, resolveReady); });
    writeFileSync(join(control.getRegistryDir(), `${setup.status().instanceId}.json`), JSON.stringify({
      ...setup.status(), authToken: '00'.repeat(32), socketPath, pid: process.pid,
    }));
    await expect(control.request(setup.status().instanceId, { type: 'test' }))
      .rejects.toThrow('Could not connect to test instance');
    server.close();
  });
});
