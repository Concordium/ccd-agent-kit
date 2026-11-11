import { rmSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ed25519SignerKeyRef, saveSignerInventory, upsertSignerInventoryKey } from '@ccd-agent-kit/config-utils';
import {
  createManagedCredentialDeploymentSigningBackend,
  signCredentialDeployment,
} from '../../../../src/core/sign/signCredentialDeployment.js';
import type {
  GenerateYubiKeyInput,
  GenerateYubiKeyResult,
  ImportYubiKeyInput,
  ImportYubiKeyResult,
  SignYubiKeyDigestInput,
  SignYubiKeyDigestResult,
  UnlockYubiKeyInput,
  UnlockYubiKeyResult,
  YubiKeyDeviceSummary,
  YubiKeyInspection,
  YubiKeyService,
} from '@ccd-agent-kit/piv-utils';
import { transactionFixtures } from '../../../helpers/transactionFixtures.js';
import { makeTestTempDir } from '../../../helpers/tempDir.js';

class FakePivSigningService implements YubiKeyService {
  public inputs: SignYubiKeyDigestInput[] = [];
  public error: Error | undefined;

  async listDevices(): Promise<YubiKeyDeviceSummary[]> {
    return [];
  }

  async inspectDevice(): Promise<YubiKeyInspection> {
    throw new Error('not used');
  }

  async listAndInspectDeviceKeys(): Promise<{ devices: YubiKeyDeviceSummary[]; inspections: YubiKeyInspection[] }> {
    return { devices: [], inspections: [] };
  }

  async generateEd25519Key(_input: GenerateYubiKeyInput): Promise<GenerateYubiKeyResult> {
    throw new Error('not used');
  }

  async importEd25519Key(_input: ImportYubiKeyInput): Promise<ImportYubiKeyResult> {
    throw new Error('not used');
  }

  async unlockDevice(_input: UnlockYubiKeyInput): Promise<UnlockYubiKeyResult> {
    throw new Error('not used');
  }

  async signEd25519Digest(input: SignYubiKeyDigestInput): Promise<SignYubiKeyDigestResult> {
    this.inputs.push(input);
    if (this.error) throw this.error;
    return { signatureHex: '11'.repeat(64) };
  }
}

describe('signCredentialDeployment', () => {
  let tempDir: string;
  let originalData: string | undefined;
  let originalState: string | undefined;
  let originalConfig: string | undefined;

  beforeEach(() => {
    originalData = process.env.XDG_DATA_HOME;
    originalState = process.env.XDG_STATE_HOME;
    originalConfig = process.env.XDG_CONFIG_HOME;
    tempDir = makeTestTempDir('credential-piv-signing-test-');
    process.env.XDG_DATA_HOME = join(tempDir, 'data');
    process.env.XDG_STATE_HOME = join(tempDir, 'state');
    process.env.XDG_CONFIG_HOME = join(tempDir, 'config');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    if (originalData !== undefined) process.env.XDG_DATA_HOME = originalData;
    else delete process.env.XDG_DATA_HOME;
    if (originalState !== undefined) process.env.XDG_STATE_HOME = originalState;
    else delete process.env.XDG_STATE_HOME;
    if (originalConfig !== undefined) process.env.XDG_CONFIG_HOME = originalConfig;
    else delete process.env.XDG_CONFIG_HOME;
  });

  it('rejects missing managed keys', async () => {
    await expect(
      signCredentialDeployment({
        backend: createManagedCredentialDeploymentSigningBackend(),
        keys: ['0'],
        credDeploymentHex: transactionFixtures.credentialDeploymentSigningNewAccountHex,
      }),
    ).rejects.toMatchObject({ code: 'key_not_available' });
  });

  it('rejects unsupported managed credential signing backends', async () => {
    saveSignerInventory({
      keys: {
        [ed25519SignerKeyRef(transactionFixtures.credentialDeploymentSigningPublicKey)]: {
          backends: [
            {
              backend: { type: 'future_backend' } as never,
              createdAt: '2026-09-25T00:00:00.000Z',
              signingModule: 'future-module' as never,
              updatedAt: '2026-09-25T00:00:00.000Z',
            },
          ],
          createdAt: '2026-09-25T00:00:00.000Z',
          scheme: 'Ed25519',
          updatedAt: '2026-09-25T00:00:00.000Z',
        },
      },
      updatedAt: '2026-09-25T00:00:00.000Z',
      version: 1,
    });

    await expect(
      signCredentialDeployment({
        backend: createManagedCredentialDeploymentSigningBackend(),
        keys: ['0'],
        credDeploymentHex: transactionFixtures.credentialDeploymentSigningNewAccountHex,
      }),
    ).rejects.toMatchObject({ code: 'key_not_available' });
  });

  it('uses PIV Ed25519 inventory entries for credential deployment signing', async () => {
    const service = new FakePivSigningService();
    upsertSignerInventoryKey({
      backend: {
        devices: [{ kind: 'yubikey', serial: '12345678', slot: '82' }],
      },
      publicKey: transactionFixtures.credentialDeploymentSigningPublicKey,
      scheme: 'Ed25519',
      signingModule: 'yubikey-piv',
    });

    const result = await signCredentialDeployment({
      backend: createManagedCredentialDeploymentSigningBackend(undefined, service),
      keys: ['0'],
      credDeploymentHex: transactionFixtures.credentialDeploymentSigningNewAccountHex,
    });

    expect(result.newSignatures).toEqual({ '0': '11'.repeat(64) });
    expect(service.inputs).toHaveLength(1);
    expect(service.inputs[0]).toMatchObject({
      devices: [{ kind: 'yubikey', serial: '12345678', slot: '82' }],
      publicKey: transactionFixtures.credentialDeploymentSigningPublicKey,
    });
  });

  it('surfaces PIN-required PIV errors without prompting through MCP backends', async () => {
    const service = new FakePivSigningService();
    service.error = new Error('PIN verification required for the selected PIV signing key.');
    upsertSignerInventoryKey({
      backend: { devices: [{ kind: 'yubikey', serial: '12345678', slot: '82' }] },
      publicKey: transactionFixtures.credentialDeploymentSigningPublicKey,
      scheme: 'Ed25519',
      signingModule: 'yubikey-piv',
    });

    await expect(
      signCredentialDeployment({
        backend: createManagedCredentialDeploymentSigningBackend(undefined, service),
        keys: ['0'],
        credDeploymentHex: transactionFixtures.credentialDeploymentSigningNewAccountHex,
      }),
    ).rejects.toMatchObject({
      code: 'key_not_available',
    });
  });
});
