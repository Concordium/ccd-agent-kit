import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FakeConcordiumClient, makeContext } from '../../../helpers/fakes.js';
import { accountInfo, SENDER } from '../../../mcp/transactions/internal/helpers.js';

const collaborators = vi.hoisted(() => ({
  verificationInfo: vi.fn(),
  verify: vi.fn<() => Promise<boolean>>(),
}));

vi.mock('../../../../src/mcp/accountCredentialsCache.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../src/mcp/accountCredentialsCache.js')>()),
  getAccountVerificationInfoCacheFirst: collaborators.verificationInfo,
}));

vi.mock('@concordium/web-sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@concordium/web-sdk')>()),
  verifyMessageSignature: collaborators.verify,
}));

import {
  verifyMessage,
  verifyMessageSignatureArgsSchema,
  verifyMessageSignatureHandler,
} from '../../../../src/mcp/messages/handlers.js';

const SIGNATURE = { 0: { 0: 'aa'.repeat(64) } };

describe('verifyMessage adapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    collaborators.verificationInfo.mockResolvedValue({ info: accountInfo(SENDER, '11'.repeat(32)), source: 'chain' });
    collaborators.verify.mockResolvedValue(true);
  });

  it('forwards the resolved block and omits message input from the public result by default', async () => {
    await expect(
      verifyMessage(makeContext(new FakeConcordiumClient()), {
        address: SENDER,
        block: 'best',
        messageText: 'hello',
        signature: SIGNATURE,
      }),
    ).resolves.toEqual({ valid: true, network: 'mainnet', address: SENDER, inputFormat: 'text' });

    expect(collaborators.verificationInfo).toHaveBeenCalledWith(expect.anything(), 'mainnet', SENDER, { type: 'best' });
    expect(collaborators.verify).toHaveBeenCalledOnce();
  });

  it('returns normalized optional input only when requested', async () => {
    await expect(
      verifyMessage(makeContext(new FakeConcordiumClient()), {
        address: SENDER,
        messageHex: '68656c6c6f',
        returnInput: true,
        signature: SIGNATURE,
      }),
    ).resolves.toMatchObject({ inputFormat: 'hex', messageHex: '68656c6c6f' });
  });

  it('refreshes a cached rejection once and projects the refreshed canonical address', async () => {
    const refreshedAddress = '4StnMEQCKtfDRuHJfsY6eZL9KJWqdYoqRVRoDSSAz35LsmHcmg';
    collaborators.verificationInfo
      .mockResolvedValueOnce({ info: accountInfo(SENDER, '11'.repeat(32)), source: 'cache' })
      .mockResolvedValueOnce({ info: accountInfo(refreshedAddress, '22'.repeat(32)), source: 'chain' });
    collaborators.verify.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    await expect(
      verifyMessage(makeContext(new FakeConcordiumClient()), {
        address: SENDER,
        messageText: 'hello',
        signature: SIGNATURE,
      }),
    ).resolves.toMatchObject({ valid: true, address: refreshedAddress });
    expect(collaborators.verificationInfo).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      'mainnet',
      SENDER,
      undefined,
      true,
    );
  });

  it('requires exactly one message input at the public schema boundary', () => {
    expect(verifyMessageSignatureArgsSchema.safeParse({ address: SENDER, signature: SIGNATURE }).success).toBe(false);
    expect(
      verifyMessageSignatureArgsSchema.safeParse({
        address: SENDER,
        messageText: 'hello',
        messageHex: '68656c6c6f',
        signature: SIGNATURE,
      }).success,
    ).toBe(false);
  });

  it('wraps the projected verification result as JSON', async () => {
    const result = await verifyMessageSignatureHandler(makeContext(new FakeConcordiumClient()), {
      address: SENDER,
      messageText: 'hello',
      signature: SIGNATURE,
    });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({ valid: true, network: 'mainnet', address: SENDER, inputFormat: 'text' });
    expect(result.content[0]).toMatchObject({ type: 'text', text: JSON.stringify(result.structuredContent, null, 2) });
  });
});
