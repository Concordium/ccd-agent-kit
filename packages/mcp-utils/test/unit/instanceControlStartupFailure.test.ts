import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { afterEach, expect, it, vi } from 'vitest';

const fakeServers = vi.hoisted(() => [] as Array<{ closed: boolean }>);

vi.mock('node:net', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:net')>();
  return {
    ...actual,
    createServer: vi.fn(() => {
      const server = new EventEmitter() as EventEmitter & {
        closed: boolean;
        listen: (path: string, callback: () => void) => void;
        close: (callback: (error?: Error) => void) => void;
      };
      const shouldFail = fakeServers.length === 0;
      server.closed = false;
      server.listen = (_path, callback) => {
        if (shouldFail) server.emit('error', new Error('bind failed'));
        else callback();
      };
      server.close = (callback) => {
        server.closed = true;
        callback(shouldFail ? new Error('close failed') : undefined);
      };
      fakeServers.push(server);
      return server;
    }),
  };
});

import { createMcpInstanceControl, MCP_INSTANCE_NAMESPACES } from '../../src/instanceControl.js';

const scratchRoots: string[] = [];
const originalRuntimeDir = process.env.XDG_RUNTIME_DIR;

afterEach(() => {
  if (originalRuntimeDir === undefined) delete process.env.XDG_RUNTIME_DIR;
  else process.env.XDG_RUNTIME_DIR = originalRuntimeDir;
  for (const root of scratchRoots.splice(0)) rmSync(root, { recursive: true, force: true });
  fakeServers.splice(0);
});

it('cleans failed socket startup before rethrowing and permits retry', async () => {
  const root = join(resolve(process.cwd(), '../..'), '.test-tmp', `if-${crypto.randomUUID().slice(0, 8)}`);
  mkdirSync(root, { recursive: true });
  scratchRoots.push(root);
  process.env.XDG_RUNTIME_DIR = root;
  const status = { instanceId: 'startup1', command: 'test command' };
  const control = createMcpInstanceControl({
    namespace: MCP_INSTANCE_NAMESPACES.signer,
    stateDir: () => root,
    getStatus: () => status,
    parseStatus: (raw) => raw as typeof status,
  });
  const sidecarPath = join(control.getRegistryDir(), `${status.instanceId}.json`);
  const socketPath = join(control.getRegistryDir(), `${status.instanceId}.sock`);

  await expect(control.start({ handleRequest: () => ({ ok: true }) })).rejects.toThrow('bind failed');
  expect(fakeServers[0]?.closed).toBe(true);
  expect(existsSync(sidecarPath)).toBe(false);
  expect(existsSync(socketPath)).toBe(false);

  const retry = await control.start({ handleRequest: () => ({ ok: true }) });
  await retry.close();
  expect(fakeServers[1]?.closed).toBe(true);
  expect(existsSync(sidecarPath)).toBe(false);
  expect(existsSync(socketPath)).toBe(false);
});
