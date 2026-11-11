import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ed25519PublicKey } from '@ccd-agent-kit/sdk-utils';
import {
  createManagedCredentialDeploymentSigningBackend,
  CredentialDeploymentSigningError,
  signCredentialDeployment,
} from '../../../../src/core/sign/signCredentialDeployment.js';
import { executeSignCredentialDeploymentTool } from '../../../../src/mcp/tools/signCredentialDeploymentTool.js';

vi.mock('../../../../src/core/sign/signCredentialDeployment.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../src/core/sign/signCredentialDeployment.js')>()),
  createManagedCredentialDeploymentSigningBackend: vi.fn(),
  signCredentialDeployment: vi.fn(),
}));

const backend = { signDigest: vi.fn(async () => '11'.repeat(64)) };
const signed = {
  kind: 'credentialDeploymentSigning' as const,
  target: { type: 'new_account' as const, messageExpiry: '42' },
  digestHex: 'aa'.repeat(32),
  newSignatures: { 0: '11'.repeat(64) },
  signatures: { 0: '11'.repeat(64) },
  isFullySigned: true,
  signatureThreshold: 1,
  missingSignatures: 0,
  credentialPublicKeys: { threshold: 1, keys: { 0: ed25519PublicKey.require('22'.repeat(32)) } },
};

describe('executeSignCredentialDeploymentTool', () => {
  beforeEach(() => {
    vi.mocked(createManagedCredentialDeploymentSigningBackend).mockReset().mockReturnValue(backend);
    vi.mocked(signCredentialDeployment).mockReset().mockResolvedValue(signed);
  });

  it('forwards all signing controls and returns structured JSON', async () => {
    const signatures = { 1: '33'.repeat(64) };
    const result = await executeSignCredentialDeploymentTool({
      credDeploymentHex: 'aabb', signatures, keys: ['0'], maxSignatures: 2, network: 'testnet',
    });

    expect(createManagedCredentialDeploymentSigningBackend).toHaveBeenCalledWith('testnet', undefined);
    expect(signCredentialDeployment).toHaveBeenCalledWith({
      backend, keys: ['0'], maxSignatures: 2, signatures, credDeploymentHex: 'aabb',
    });
    expect(result.structuredContent).toEqual(signed);
    expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(signed, null, 2) }]);
  });

  it('preserves structured core errors without adding a generic prefix', async () => {
    vi.mocked(signCredentialDeployment).mockRejectedValue(
      new CredentialDeploymentSigningError('key_not_available', 'Selected key is unavailable.'),
    );

    const result = await executeSignCredentialDeploymentTool({ credDeploymentHex: 'aabb' });

    expect(result).toEqual({ content: [{ type: 'text', text: 'Selected key is unavailable.' }], isError: true });
  });

  it('translates and sanitizes unexpected failures', async () => {
    vi.mocked(signCredentialDeployment).mockRejectedValue(new Error("read '/Users/alice/key.json'"));

    const result = await executeSignCredentialDeploymentTool({ credDeploymentHex: 'aabb' });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe("Credential deployment signing failed: read '[redacted local path]'");
  });

  it('translates non-Error core failures into safe MCP errors', async () => {
    vi.mocked(signCredentialDeployment).mockRejectedValue('signer unavailable');

    const result = await executeSignCredentialDeploymentTool({ credDeploymentHex: 'aabb' });

    expect(result).toEqual({
      content: [{ type: 'text', text: 'Credential deployment signing failed: signer unavailable' }],
      isError: true,
    });
  });
});
