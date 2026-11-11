import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { createMcpInstanceControl, MCP_INSTANCE_NAMESPACES } from '@ccd-agent-kit/mcp-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runCli } from '../../../src/bin/ccd-config-manager.js';

describe('identity-manager instance discovery', () => {
  let runtimeDir: string;
  let previousRuntimeDir: string | undefined;
  let close: (() => Promise<void>) | undefined;

  beforeEach(() => {
    const scratchRoot = resolve(process.cwd(), '../..', '.test-tmp');
    mkdirSync(scratchRoot, { recursive: true });
    runtimeDir = mkdtempSync(join(scratchRoot, 'runtime-'));
    previousRuntimeDir = process.env.XDG_RUNTIME_DIR;
    process.env.XDG_RUNTIME_DIR = runtimeDir;
  });

  afterEach(async () => {
    await close?.();
    if (previousRuntimeDir === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = previousRuntimeDir;
    rmSync(runtimeDir, { recursive: true, force: true });
  });

  it('lists a real registration from the identity-manager namespace', async () => {
    const control = createMcpInstanceControl({
      namespace: MCP_INSTANCE_NAMESPACES.idManager,
      stateDir: () => runtimeDir,
      getStatus: () => ({ instanceId: 'id-manager-test' }),
      parseStatus: raw => {
        if (typeof raw !== 'object' || raw === null) return undefined;
        const { instanceId } = raw as { instanceId?: unknown };
        return typeof instanceId === 'string' ? { instanceId } : undefined;
      },
    });
    const server = await control.start({ network: 'testnet', handleRequest: () => ({ ok: false }) });
    close = server.close;
    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    let output: string;

    try {
      await expect(runCli(['service', 'id-manager', 'instances'])).resolves.toBe(0);
      output = String(stdoutWrite.mock.calls[0]?.[0]);
    } finally {
      stdoutWrite.mockRestore();
    }

    expect(JSON.parse(output)).toMatchObject({
      instances: [{ instanceId: 'id-manager-test', network: 'testnet' }],
    });
  });
});
