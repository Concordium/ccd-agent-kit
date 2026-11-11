import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { createMcpInstanceClient, createMcpInstanceId, MCP_INSTANCE_NAMESPACES } from '../../src/instanceControl.js';
import { makeControl, makeScratch } from '../instanceControlHelpers.js';

describe('generic MCP instance control', () => {
  it('uses namespace-isolated runtime and corrected state fallback paths', () => {
    const root = makeScratch();
    const { control } = makeControl(root);
    expect(control.getRegistryDir()).toBe(join(root, 'runtime', 'signer', 'instances'));

    process.env.XDG_RUNTIME_DIR = join(root, 'xdg-runtime');
    expect(control.getRegistryDir()).toBe(join(root, 'xdg-runtime', 'ccd-agent-kit', 'signer', 'instances'));
    expect(createMcpInstanceId()).toMatch(/^[0-9a-f]{8}$/u);
    expect(MCP_INSTANCE_NAMESPACES.idManager).toBe('id-manager');
  });

  it('registers and lists only safe projected fields with private permissions', () => {
    const { control, status } = makeControl();
    const entry = control.register({ network: 'testnet' });
    expect(entry).toMatchObject({ ...status(), network: 'testnet', pid: process.pid, parentPid: process.ppid });

    const registryFile = join(control.getRegistryDir(), `${status().instanceId}.json`);
    expect(readFileSync(registryFile, 'utf8')).not.toContain('authToken');
    expect((statSync(control.getRegistryDir()).mode & 0o777)).toBe(0o700);
    expect((statSync(registryFile).mode & 0o777)).toBe(0o600);
    expect(control.list()).toEqual([entry]);

    writeFileSync(join(control.getRegistryDir(), 'minimal.json'), JSON.stringify({
      instanceId: 'minimal', command: 'minimal command', state: 'ready',
    }));
    expect(control.list()).toContainEqual({ instanceId: 'minimal', command: 'minimal command', state: 'ready' });

    writeFileSync(join(control.getRegistryDir(), 'bad.json'), '{');
    writeFileSync(join(control.getRegistryDir(), 'invalid.json'), JSON.stringify({ instanceId: 1 }));
    expect(control.list()).toEqual(expect.arrayContaining([entry, {
      instanceId: 'minimal', command: 'minimal command', state: 'ready',
    }]));
  });

  it('creates status-independent clients that preserve safe registry projection', () => {
    const root = makeScratch();
    const { control, status } = makeControl(root);
    control.register();
    const registryFile = join(control.getRegistryDir(), `${status().instanceId}.json`);
    const privateEntry = JSON.parse(readFileSync(registryFile, 'utf8')) as Record<string, unknown>;
    writeFileSync(registryFile, JSON.stringify({ ...privateEntry, authToken: 'secret', socketPath: 'private.sock' }));
    const client = createMcpInstanceClient({
      namespace: MCP_INSTANCE_NAMESPACES.signer,
      stateDir: () => root,
      parseStatus: (raw) => {
        if (typeof raw !== 'object' || raw === null) return undefined;
        const value = raw as { instanceId?: unknown; command?: unknown; state?: unknown };
        return typeof value.instanceId === 'string' && typeof value.command === 'string'
          ? { instanceId: value.instanceId, command: value.command, state: value.state === 'ready' ? 'ready' as const : 'blocked' as const }
          : undefined;
      },
    });

    expect(client.list()).toEqual([expect.objectContaining(status())]);
    expect(client.list()[0]).not.toHaveProperty('authToken');
    expect(client.list()[0]).not.toHaveProperty('socketPath');
  });

  it('prunes stale and dead-process registrations', () => {
    const { control, status } = makeControl();
    control.register();
    const file = join(control.getRegistryDir(), `${status().instanceId}.json`);
    const stale = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    stale.lastSeenAt = new Date(Date.now() - 3_700_000).toISOString();
    writeFileSync(file, JSON.stringify(stale));
    expect(control.list()).toEqual([]);

    control.register();
    vi.spyOn(process, 'kill').mockImplementation(() => { throw new Error('dead'); });
    expect(control.list()).toEqual([]);
  });

  it('handles absent registries, incomplete controls, and stale targeted controls', async () => {
    const { control, status } = makeControl();
    expect(control.list()).toEqual([]);
    control.updateRegistration();
    control.register();
    await expect(control.request(status().instanceId, { type: 'test' })).rejects.toThrow('is not running');

    control.register();
    const file = join(control.getRegistryDir(), `${status().instanceId}.json`);
    const stale = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    stale.socketPath = join(control.getRegistryDir(), 'stale.sock');
    stale.authToken = '00'.repeat(32);
    stale.lastSeenAt = new Date(Date.now() - 3_700_000).toISOString();
    writeFileSync(file, JSON.stringify(stale));
    await expect(control.request(status().instanceId, { type: 'test' })).rejects.toThrow('is not running');
    expect(control.list()).toEqual([]);
  });
});
