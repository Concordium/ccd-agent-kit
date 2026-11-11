import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  findAccountLabelForAddress,
  getAccountCredentialObservation,
  resolveAccountLabel,
  resolveNetwork,
  type AccountCredentialObservation,
} from '@ccd-agent-kit/config-utils';
import { ed25519PublicKey } from '@ccd-agent-kit/sdk-utils';
import {
  AccountCredentialsSigningBackend,
  hasAvailableObservedCredentialKey,
} from '../../../../src/core/sign/backends/accountCredentials.js';
import { signMessage } from '../../../../src/core/sign/signMessage.js';
import { executeSignMessageTool } from '../../../../src/mcp/tools/signMessageTool.js';

vi.mock('@ccd-agent-kit/config-utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ccd-agent-kit/config-utils')>()),
  findAccountLabelForAddress: vi.fn(),
  getAccountCredentialObservation: vi.fn(),
  resolveAccountLabel: vi.fn(),
  resolveNetwork: vi.fn(),
}));
vi.mock('../../../../src/core/sign/backends/accountCredentials.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../src/core/sign/backends/accountCredentials.js')>()),
  hasAvailableObservedCredentialKey: vi.fn(),
}));
vi.mock('../../../../src/core/sign/signMessage.js', () => ({ signMessage: vi.fn() }));

const observation: AccountCredentialObservation = {
  accountThreshold: '1',
  credentials: { 0: { keys: { 0: { publicKey: ed25519PublicKey.require('11'.repeat(32)), scheme: 'Ed25519' } }, threshold: '1' } },
  sourceBlock: { hash: '22'.repeat(32), height: '1', time: '2026-01-01T00:00:00.000Z' },
};
const signature = { 0: { 0: '33'.repeat(64) } };

describe('executeSignMessageTool', () => {
  beforeEach(() => {
    vi.mocked(resolveNetwork).mockReset().mockReturnValue({
      config: { caip2: `ccd:${'11'.repeat(16)}`, genesisHash: '00'.repeat(32), grpc: { host: 'node', port: 20000, ssl: true } },
      name: 'testnet',
    });
    vi.mocked(resolveAccountLabel).mockReset().mockReturnValue({ address: 'resolved-address', label: 'Selected' });
    vi.mocked(getAccountCredentialObservation).mockReset().mockReturnValue(observation);
    vi.mocked(hasAvailableObservedCredentialKey).mockReset().mockReturnValue(true);
    vi.mocked(findAccountLabelForAddress).mockReset().mockReturnValue('First');
    vi.mocked(signMessage).mockReset().mockResolvedValue({
      account: 'resolved-address', inputFormat: 'text', messageHex: '6869', messageText: 'hi', signature,
    });
  });

  it('preserves the canonical selected label while signing with its address', async () => {
    const result = await executeSignMessageTool({ account: 'SELECTED', messageText: 'hi', network: 'testnet' });

    expect(resolveNetwork).toHaveBeenCalledWith('testnet');
    expect(resolveAccountLabel).toHaveBeenCalledWith('SELECTED', '11'.repeat(16));
    expect(getAccountCredentialObservation).toHaveBeenCalledWith('resolved-address', '11'.repeat(16));
    expect(signMessage).toHaveBeenCalledWith({
      account: 'resolved-address',
      backend: expect.any(AccountCredentialsSigningBackend),
      messageHex: undefined,
      messageText: 'hi',
    });
    expect(result.structuredContent).toEqual({
      account: 'resolved-address', inputFormat: 'text', label: 'Selected', network: 'testnet', signature,
    });
  });

  it('uses the preferred reverse label for a native address selector', async () => {
    vi.mocked(resolveAccountLabel).mockReturnValue(undefined);

    const result = await executeSignMessageTool({ account: 'resolved-address', messageText: 'hi' });

    expect(signMessage).toHaveBeenCalledWith(expect.objectContaining({ account: 'resolved-address' }));
    expect(findAccountLabelForAddress).toHaveBeenCalledWith('resolved-address', '11'.repeat(16));
    expect(result.structuredContent).toMatchObject({ account: 'resolved-address', label: 'First' });
  });

  it('returns exact signed input fields when requested for debugging', async () => {
    const result = await executeSignMessageTool({ account: 'alice', messageText: 'hi', returnInput: true });

    expect(result.structuredContent).toMatchObject({ messageHex: '6869', messageText: 'hi' });
  });

  it('returns adapter-owned errors before invoking signing when credentials are missing', async () => {
    vi.mocked(getAccountCredentialObservation).mockReturnValue(undefined);

    const result = await executeSignMessageTool({ account: 'alice', messageText: 'hi' });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("No finalized account credentials cached for 'alice' on network 'testnet'");
    expect(signMessage).not.toHaveBeenCalled();
  });

  it('returns adapter-owned errors before invoking signing when no observed key is available', async () => {
    vi.mocked(hasAvailableObservedCredentialKey).mockReturnValue(false);

    const result = await executeSignMessageTool({ account: 'alice', messageHex: 'aa' });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("No local signer key matches finalized account credentials for 'alice'");
    expect(signMessage).not.toHaveBeenCalled();
  });

  it('translates and sanitizes unexpected core or config failures', async () => {
    vi.mocked(signMessage).mockRejectedValue(new Error("read '/Users/alice/key.json'"));

    const result = await executeSignMessageTool({ account: 'alice', messageHex: 'aa' });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe("Signing failed: read '[redacted local path]'");
  });
});
