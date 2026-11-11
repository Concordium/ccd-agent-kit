import { describe, expect, it, vi } from 'vitest';
import type { AccountTransactionSignature } from '@concordium/web-sdk';

import { SigningError, signMessage } from '../../../../src/core/sign/signMessage.js';
import { transactionFixtures } from '../../../helpers/transactionFixtures.js';

describe('signMessage', () => {
  it('signs text input and returns the exact signed bytes as hex', async () => {
    const createSignature = vi.fn(async () => ({
      0: {
        0: '22'.repeat(64),
      },
    }));

    const result = await signMessage({
      account: transactionFixtures.sender,
      backend: {
        createSignature,
      },
      messageText: 'hello',
    });

    expect(createSignature).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      account: transactionFixtures.sender,
      inputFormat: 'text',
      messageHex: '68656c6c6f',
      messageText: 'hello',
      signature: {
        0: {
          0: '22'.repeat(64),
        },
      },
    });
  });

  it('signs exact bytes from hex input', async () => {
    const createSignature = vi.fn(async () => ({
      0: {
        0: '33'.repeat(64),
      },
    }));

    const result = await signMessage({
      account: transactionFixtures.sender,
      backend: {
        createSignature,
      },
      messageHex: '68656c6c6f',
    });

    expect(createSignature).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      account: transactionFixtures.sender,
      inputFormat: 'hex',
      messageHex: '68656c6c6f',
      signature: {
        0: {
          0: '33'.repeat(64),
        },
      },
    });
  });

  it('rejects when both text and hex inputs are provided', async () => {
    await expect(
      signMessage({
        account: transactionFixtures.sender,
        backend: {
          createSignature: async () => ({}),
        },
        messageHex: '00',
        messageText: 'hello',
      }),
    ).rejects.toEqual(new SigningError('invalid_input', 'Provide exactly one of messageText or messageHex.'));
  });

  it('rejects when no message input is provided', async () => {
    await expect(
      signMessage({
        account: transactionFixtures.sender,
        backend: {
          createSignature: async () => ({}),
        },
      }),
    ).rejects.toEqual(new SigningError('invalid_input', 'Provide exactly one of messageText or messageHex.'));
  });

  it('rejects invalid hex input', async () => {
    await expect(
      signMessage({
        account: transactionFixtures.sender,
        backend: {
          createSignature: async () => ({}),
        },
        messageHex: 'xyz',
      }),
    ).rejects.toEqual(new SigningError('invalid_input', 'Message hex must be a valid even-length hex string.'));
  });

  it('rejects invalid account addresses', async () => {
    await expect(
      signMessage({
        account: 'not-an-account',
        backend: {
          createSignature: async () => ({}),
        },
        messageText: 'hello',
      }),
    ).rejects.toEqual(new SigningError('invalid_input', 'Invalid account address: not-an-account'));
  });

  it('propagates backend signing failures', async () => {
    await expect(
      signMessage({
        account: transactionFixtures.sender,
        backend: {
          createSignature: async () => {
            throw new Error('backend unavailable');
          },
        },
        messageText: 'hello',
      }),
    ).rejects.toThrow('backend unavailable');
  });

  it('returns an owned signature map independent from the backend-owned map', async () => {
    const backendSignature: AccountTransactionSignature = { 0: { 0: '44'.repeat(64) } };

    const result = await signMessage({
      account: transactionFixtures.sender,
      backend: { createSignature: async () => backendSignature },
      messageText: 'hello',
    });

    backendSignature[0]![0] = 'ff'.repeat(64);
    backendSignature[9] = { 0: '99'.repeat(64) };

    expect(result.signature).toEqual({ 0: { 0: '44'.repeat(64) } });
  });
});
