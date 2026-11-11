import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { parseSignerInstanceStatus, type SignerInstanceStatus, type SignerInstanceStatusPayload } from '@ccd-agent-kit/config-utils';
import { createMcpInstanceControl, MCP_INSTANCE_NAMESPACES, type McpInstanceControlServer } from '@ccd-agent-kit/mcp-utils';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { registerSignerInstanceCliCommand } from '../../../src/cli/signerInstanceCliCommand.js';

describe('config-owned signer instance authenticated IPC', () => {
  let runtimeDir: string;
  let server: McpInstanceControlServer<SignerInstanceStatusPayload> | undefined;

  beforeEach(() => {
    runtimeDir = mkdtempSync(join(resolve(process.cwd(), '../..', '.test-tmp'), 'runtime-'));
    process.env.XDG_RUNTIME_DIR = runtimeDir;
  });

  afterEach(async () => {
    await server?.close();
    delete process.env.XDG_RUNTIME_DIR;
    rmSync(runtimeDir, { recursive: true, force: true });
  });

  it('discovers a real registration and sends authenticated unlock and lock requests', async () => {
    const instanceId = 'ipc-test';
    let status: SignerInstanceStatus = 'locked';
    const requests: Array<Record<string, unknown>> = [];
    const control = createMcpInstanceControl<SignerInstanceStatusPayload>({
      namespace: MCP_INSTANCE_NAMESPACES.signer,
      stateDir: () => runtimeDir,
      getStatus: () => ({
        instanceId, status,
        unlockCommand: `ccd-config-manager service signer unlock --instance ${instanceId}`,
      }),
      parseStatus: parseSignerInstanceStatus,
    });
    server = await control.start({
      handleRequest: request => {
        requests.push(request);
        if (request.type === 'unlock' && request.password === 'pw') status = 'unlocked';
        else if (request.type === 'lock') status = 'locked';
        else return { error: 'denied', ok: false };
        control.updateRegistration();
        return { ok: true, status };
      },
    });
    const command = makeCommand(async () => 'pw');

    await command.program.parseAsync(['service', 'signer', 'instances'], { from: 'user' });
    await command.program.parseAsync(['service', 'signer', 'unlock', '--instance', instanceId], { from: 'user' });
    await command.program.parseAsync(['service', 'signer', 'lock', '--instance', instanceId], { from: 'user' });

    expect(JSON.parse(command.stdout[0]!)).toMatchObject({
      instances: [{ instanceId, status: 'locked' }],
    });
    expect(requests).toEqual([
      expect.objectContaining({ authToken: expect.any(String), password: 'pw', type: 'unlock' }),
      expect.objectContaining({ authToken: expect.any(String), type: 'lock' }),
    ]);
    expect(command.exitCodes).toEqual([0, 0]);
    expect(command.stderr).toEqual([]);
  });
});

function makeCommand(promptUnlockPassword: () => Promise<string>) {
  const program = new Command().exitOverride();
  const stderr: string[] = [];
  const stdout: string[] = [];
  const exitCodes: number[] = [];
  registerSignerInstanceCliCommand({
    program, stderr, stdout, promptUnlockPassword,
    runNested: async result => { exitCodes.push(await result); },
  });
  return { exitCodes, program, stderr, stdout };
}
