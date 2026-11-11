import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, vi } from 'vitest';

import { createMcpInstanceControl, createMcpInstanceId, MCP_INSTANCE_NAMESPACES } from '../src/instanceControl.js';

export interface TestStatus {
  instanceId: string;
  command: string;
  state: 'ready' | 'blocked';
}

const scratchRoots: string[] = [];
let originalRuntimeDir: string | undefined;

export function makeScratch(): string {
  const root = join(resolve(process.cwd(), '../..'), '.test-tmp', `i-${crypto.randomUUID().slice(0, 8)}`);
  mkdirSync(root, { recursive: true });
  scratchRoots.push(root);
  return root;
}

export function makeControl(root = makeScratch()) {
  let status: TestStatus = { instanceId: createMcpInstanceId(), command: 'test command', state: 'blocked' };
  const control = createMcpInstanceControl<TestStatus>({
    namespace: MCP_INSTANCE_NAMESPACES.signer,
    stateDir: () => root,
    getStatus: () => status,
    parseStatus: (raw) => {
      if (typeof raw !== 'object' || raw === null) return undefined;
      const value = raw as Partial<TestStatus>;
      if (typeof value.instanceId !== 'string' || typeof value.command !== 'string') return undefined;
      return { instanceId: value.instanceId, command: value.command, state: value.state === 'ready' ? 'ready' : 'blocked' };
    },
  });
  return { control, root, setStatus: (next: TestStatus) => { status = next; }, status: () => status };
}

beforeEach(() => {
  originalRuntimeDir = process.env.XDG_RUNTIME_DIR;
  delete process.env.XDG_RUNTIME_DIR;
});

afterEach(() => {
  if (originalRuntimeDir === undefined) delete process.env.XDG_RUNTIME_DIR;
  else process.env.XDG_RUNTIME_DIR = originalRuntimeDir;
  vi.restoreAllMocks();
  for (const root of scratchRoots.splice(0)) {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort test cleanup */ }
  }
});
