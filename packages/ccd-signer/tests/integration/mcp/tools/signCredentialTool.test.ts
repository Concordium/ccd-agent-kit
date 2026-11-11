import { rmSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@noble/ed25519', () => ({
  signAsync: vi.fn(async () => new Uint8Array(64).fill(0x33)),
}));

import { executeSignCredentialDeploymentTool } from '../../../../src/mcp/tools/signCredentialDeploymentTool.js';
import { makeTestTempDir } from '../../../helpers/tempDir.js';
import { transactionFixtures } from '../../../helpers/transactionFixtures.js';
import { writeEncryptedKey } from '../../../helpers/inventory.js';
import { useSignerSandbox } from '../../../helpers/sandbox.js';

useSignerSandbox();

describe('executeSignCredentialDeploymentTool', () => {
  let tempDir: string;
  let originalData: string | undefined;
  let originalState: string | undefined;

  beforeEach(() => {
    originalData = process.env.XDG_DATA_HOME;
    originalState = process.env.XDG_STATE_HOME;
    tempDir = makeTestTempDir('sign-credential-deployment-tool-');
    process.env.XDG_DATA_HOME = join(tempDir, 'data');
    process.env.XDG_STATE_HOME = join(tempDir, 'state');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    if (originalData !== undefined) process.env.XDG_DATA_HOME = originalData;
    else delete process.env.XDG_DATA_HOME;
    if (originalState !== undefined) process.env.XDG_STATE_HOME = originalState;
    else delete process.env.XDG_STATE_HOME;
  });

  it('signs with a managed local key and returns structured content', async () => {
    writeEncryptedKey(transactionFixtures.credentialDeploymentSigningPublicKey, 'aa'.repeat(32));

    const result = await executeSignCredentialDeploymentTool({
      keys: ['0'],
      credDeploymentHex: transactionFixtures.credentialDeploymentSigningNewAccountHex,
    });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      isFullySigned: true,
      missingSignatures: 0,
      newSignatures: { '0': '33'.repeat(64) },
      signatureThreshold: 1,
    });
    expect(JSON.parse(result.content[0]!.text)).toMatchObject(result.structuredContent!);
  });

  it('maps a real managed-backend key miss to an MCP error', async () => {
    const missing = await executeSignCredentialDeploymentTool({
      keys: ['0'],
      credDeploymentHex: transactionFixtures.credentialDeploymentSigningNewAccountHex,
    });
    expect(missing).toEqual({
      content: [
        {
          type: 'text',
          text: `Signer key ${transactionFixtures.credentialDeploymentSigningPublicKey} is not in the inventory.`,
        },
      ],
      isError: true,
    });
  });

});
