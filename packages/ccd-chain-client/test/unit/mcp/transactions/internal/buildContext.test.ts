import { describe, expect, it } from 'vitest';
import {
  resolveBuildContext,
  resolveBuildMetadata,
} from '../../../../../src/mcp/transactions/internal/buildContext.js';
import { SENDER, TO, ctx } from '../../../../mcp/transactions/internal/builders.fixtures.js';

describe('buildTransfer', () => {
  it('keeps sponsorship arguments in the build context', () => {
    const args = {
      sender: SENDER,
      sponsor: TO,
      sequenceNumber: '7',
      senderNumSignatures: '2',
      sponsorNumSignatures: '3',
      expiryMs: 60_000,
    };
    const result = resolveBuildContext(ctx, args);

    expect(result).toMatchObject({ sender: SENDER, sponsor: TO, sponsorshipArgs: args });
    expect(result.clientCtx.config).toBe(ctx.config);
  });

  it('rejects sponsor signature counts without querying signer requirements when no sponsor is set', async () => {
    await expect(
      resolveBuildMetadata(ctx, {
        sender: SENDER,
        sponsor: undefined,
        sequenceNumber: '7',
        senderNumSignatures: '1',
        sponsorNumSignatures: '2',
        expiryMs: 60_000,
      }),
    ).rejects.toMatchObject({ kind: 'invalid-argument' });
  });
});
