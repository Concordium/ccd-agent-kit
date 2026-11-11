import { describe, expect, it, vi } from 'vitest';
import type { AccountTransactionSignature } from '@concordium/web-sdk';

import { transactionFixtures } from '../../../helpers/transactionFixtures.js';
import { parseUnsignedHexAccountTransaction } from '../../../../src/core/parser/parseTransaction.js';
import { SigningError, signParsedTransaction, signTransaction } from '../../../../src/core/sign/signTransaction.js';
import type { TransactionSigningBackend } from '../../../../src/core/sign/transactionSigningBackend.js';

describe('signTransaction', () => {
  it('signs unsigned hex input and returns detached signatures without changing the representation', async () => {
    const { backend, createSignature } = signingBackend('22');

    const result = await signTransaction(transactionFixtures.unsignedTransferWithMemoHex, {
      backend,
      role: 'sender',
    });

    expect(createSignature).toHaveBeenCalledTimes(1);
    expect(createSignature).toHaveBeenCalledWith(
      expect.objectContaining({
        existingSignatures: {},
        keys: undefined,
        maxSignatures: 1,
        missingSignatures: 1,
        role: 'sender',
      }),
    );
    expect(result).toEqual({
      isFullySigned: false,
      signatureRequirementsKnown: false,
      missingSignatures: {
        sender: 0,
        sponsor: 0,
      },
      newSignature: signature('22'),
      roleSigned: 'sender',
      signatures: { sender: signature('22'), sponsor: {} },
      transaction: transactionFixtures.unsignedTransferWithMemoHex,
    });
  });

  it('signs sponsored unsigned hex and reports missing sender signatures', async () => {
    const { backend, createSignature } = signingBackend('44');

    const result = await signTransaction(transactionFixtures.sponsoredPltTransferTransactionHex, {
      backend,
      role: 'sponsor',
      signatureRequirements: {
        senderNumSignatures: '1',
        sponsorNumSignatures: '1',
        totalSignatureCount: '2',
      },
    });

    expect(createSignature).toHaveBeenCalledWith(
      expect.objectContaining({
        existingSignatures: {},
        maxSignatures: 1,
        missingSignatures: 1,
        role: 'sponsor',
      }),
    );
    expect(result).toEqual({
      isFullySigned: false,
      signatureRequirementsKnown: true,
      missingSignatures: {
        sender: 1,
        sponsor: 0,
      },
      newSignature: signature('44'),
      roleSigned: 'sponsor',
      signatures: { sender: {}, sponsor: signature('44') },
      transaction: transactionFixtures.sponsoredPltTransferTransactionHex,
    });
  });

  it('merges existing signatures and marks the transaction fully signed', async () => {
    const { backend, createSignature } = signingBackend('33');

    const result = await signTransaction(transactionFixtures.sponsoredPltTransferTransactionHex, {
      backend,
      role: 'sponsor',
      signatureRequirements: {
        senderNumSignatures: '1',
        sponsorNumSignatures: '1',
        totalSignatureCount: '2',
      },
      signatures: { sender: signature('00'), sponsor: {} },
    });

    expect(createSignature).toHaveBeenCalledWith(
      expect.objectContaining({
        existingSignatures: {},
        maxSignatures: 1,
        missingSignatures: 1,
        role: 'sponsor',
      }),
    );
    expect(result).toEqual({
      isFullySigned: true,
      signatureRequirementsKnown: true,
      missingSignatures: {
        sender: 0,
        sponsor: 0,
      },
      newSignature: signature('33'),
      roleSigned: 'sponsor',
      signatures: { sender: signature('00'), sponsor: signature('33') },
      transaction: transactionFixtures.sponsoredPltTransferTransactionHex,
    });
  });

  it('owns caller, backend, new, and merged signature maps without mutating failed input', async () => {
    const existing = { sender: signature('00'), sponsor: signature('11') };
    const originalExisting = structuredClone(existing);
    const backendSignature = signature('22', '1');
    let retainedExisting: AccountTransactionSignature | undefined;

    const result = await signTransaction(transactionFixtures.sponsoredPltTransferTransactionHex, {
      backend: { createSignature: async (request) => ((retainedExisting = request.existingSignatures), backendSignature) },
      role: 'sender',
      signatures: existing,
    });

    expect(existing).toEqual(originalExisting);
    expect(result.signatures.sender).toEqual({ 0: { 0: '00'.repeat(64), 1: '22'.repeat(64) } });
    expect(result.signatures.sponsor).toEqual(signature('11'));

    retainedExisting![0]![0] = 'ff'.repeat(64);
    backendSignature[0]![1] = 'ff'.repeat(64);
    expect(result.signatures.sender[0]![0]).toBe('00'.repeat(64));
    expect(result.newSignature[0]![1]).toBe('22'.repeat(64));

    result.newSignature[0]![1] = 'aa'.repeat(64);
    result.signatures.sender[0]![1] = 'bb'.repeat(64);
    expect(backendSignature[0]![1]).toBe('ff'.repeat(64));
    expect(result.newSignature[0]![1]).toBe('aa'.repeat(64));

    await expect(
      signTransaction(transactionFixtures.sponsoredPltTransferTransactionHex, {
        backend: { createSignature: async () => signature('33') },
        role: 'sender',
        signatures: existing,
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' } satisfies Partial<SigningError>);
    expect(existing).toEqual(originalExisting);
  });

  it('signs unsigned builder hex and preserves the hex representation', async () => {
    const { backend } = signingBackend('55');

    const result = await signTransaction(transactionFixtures.unsignedConfigureDelegationPoolHex, {
      backend,
      role: 'sender',
      signatureRequirements: {
        senderNumSignatures: '1',
        totalSignatureCount: '1',
      },
    });

    expect(result).toEqual({
      isFullySigned: true,
      signatureRequirementsKnown: true,
      missingSignatures: {
        sender: 0,
        sponsor: 0,
      },
      newSignature: signature('55'),
      roleSigned: 'sender',
      signatures: { sender: signature('55'), sponsor: {} },
      transaction: transactionFixtures.unsignedConfigureDelegationPoolHex,
    });
  });

  it('passes explicit key selection to the backend', async () => {
    const { backend, createSignature } = signingBackend('22', '1');

    await signTransaction(transactionFixtures.unsignedTransferWithMemoHex, {
      backend,
      keys: ['0:1'],
      role: 'sender',
    });

    expect(createSignature).toHaveBeenCalledWith(
      expect.objectContaining({
        keys: ['0:1'],
        maxSignatures: undefined,
        missingSignatures: 1,
      }),
    );
  });

  it('rejects combining explicit keys and maxSignatures before parsing malformed hex', async () => {
    const createSignature = vi.fn(async () => ({}));

    await expect(
      signTransaction('zz', {
        backend: { createSignature },
        keys: ['0:0'],
        maxSignatures: 1,
        role: 'sender',
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' } satisfies Partial<SigningError>);
    expect(createSignature).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'public signTransaction',
      call: (backend: TransactionSigningBackend) => signTransaction(
        transactionFixtures.unsignedTransferWithMemoHex,
        {
          backend,
          keys: ['0:0'],
          maxSignatures: 1,
          role: 'sender',
          signatures: JSON.parse('{"sender":{"0":{"0":"zz"}},"sponsor":{}}'),
        },
      ),
    },
    {
      name: 'parsed helper',
      call: (backend: TransactionSigningBackend) => signParsedTransaction(
        transactionFixtures.unsignedTransferWithMemoHex,
        parseUnsignedHexAccountTransaction(transactionFixtures.unsignedTransferWithMemoHex),
        {
          backend,
          keys: ['0:0'],
          maxSignatures: 1,
          role: 'sender',
          signatures: JSON.parse('{"sender":{"0":{"0":"zz"}},"sponsor":{}}'),
        },
      ),
    },
  ])('$name rejects key-selection conflict before signature-map normalization', async ({ call }) => {
    const createSignature = vi.fn(async () => ({}));

    await expect(call({ createSignature })).rejects.toMatchObject({ code: 'invalid_input' } satisfies Partial<SigningError>);
    expect(createSignature).not.toHaveBeenCalled();
  });

  it('rejects invalid automatic key selection limits', async () => {
    await expect(
      signTransaction(transactionFixtures.unsignedTransferWithMemoHex, {
        backend: {
          createSignature: async () => ({}),
        },
        maxSignatures: 0,
        role: 'sender',
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' } satisfies Partial<SigningError>);
  });

  it('rejects an empty explicit key list', async () => {
    await expect(
      signTransaction(transactionFixtures.unsignedTransferWithMemoHex, {
        backend: {
          createSignature: async () => ({}),
        },
        keys: [],
        role: 'sender',
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' } satisfies Partial<SigningError>);
  });

  it('rejects invalid signature requirements for hex', async () => {
    await expect(
      signTransaction(transactionFixtures.unsignedConfigureDelegationPoolHex, {
        backend: {
          createSignature: async () => ({}),
        },
        role: 'sender',
        signatureRequirements: {
          senderNumSignatures: '2',
          totalSignatureCount: '1',
        },
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' } satisfies Partial<SigningError>);
  });

  it.each([
    ['empty metadata on a sponsored transaction', transactionFixtures.sponsoredPltTransferTransactionHex, 'sender', { sender: signature('00'), sponsor: signature('11') }, signature('22', '1'), {}],
    ['zero sender metadata on an unsponsored transaction', transactionFixtures.unsignedConfigureDelegationPoolHex, 'sender', { sender: {}, sponsor: {} }, {}, { senderNumSignatures: '0', totalSignatureCount: '0' }],
    ['missing sponsor metadata on a sponsored transaction', transactionFixtures.sponsoredPltTransferTransactionHex, 'sponsor', { sender: signature('00'), sponsor: {} }, signature('33'), { senderNumSignatures: '1', totalSignatureCount: '1' }],
  ] as const)('does not report fully signed from incomplete role-count metadata: %s', async (_name, transactionHex, role, existing, produced, signatureRequirements) => {
    const createSignature = vi.fn(async () => produced);

    const result = await signTransaction(transactionHex, {
      backend: { createSignature },
      role,
      signatures: existing,
      signatureRequirements,
    });

    expect(createSignature).toHaveBeenCalledOnce();
    expect(result.signatureRequirementsKnown).toBe(true);
    expect(result.isFullySigned).toBe(false);
    expect(result.signatures[role]).toMatchObject(produced);
  });

  it('uses the requested maxSignatures for automatic key selection', async () => {
    const createSignature = vi.fn(async () => ({
      0: {
        0: '22'.repeat(64),
        1: '33'.repeat(64),
      },
    }));

    const result = await signTransaction(transactionFixtures.unsignedTransferWithMemoHex, {
      backend: {
        createSignature,
      },
      maxSignatures: 2,
      role: 'sender',
      signatureRequirements: {
        senderNumSignatures: '2',
        totalSignatureCount: '2',
      },
    });

    expect(createSignature).toHaveBeenCalledWith(
      expect.objectContaining({
        maxSignatures: 2,
        missingSignatures: 2,
      }),
    );
    expect(result.isFullySigned).toBe(true);
    expect(result.signatureRequirementsKnown).toBe(true);
    expect(result.missingSignatures.sender).toBe(0);
    expect(result.signatures.sender['0']?.['0']).toBe('22'.repeat(64));
    expect(result.signatures.sender['0']?.['1']).toBe('33'.repeat(64));
  });

  it('rejects duplicate signatures provided in existing signatures and the new signature', async () => {
    const { backend } = signingBackend('22');

    await expect(
      signTransaction(transactionFixtures.unsignedTransferWithMemoHex, {
        backend,
        role: 'sender',
        signatures: { sender: signature('11'), sponsor: {} },
      }),
    ).rejects.toMatchObject({
      code: 'invalid_input',
    } satisfies Partial<SigningError>);
  });

  it('reports remaining missing signatures when a hex signing request cannot produce every requested signature', async () => {
    const { backend } = signingBackend('aa');

    const result = await signTransaction(transactionFixtures.unsignedConfigureDelegationPoolHex, {
      backend,
      maxSignatures: 2,
      role: 'sender',
      signatureRequirements: {
        senderNumSignatures: '2',
        totalSignatureCount: '2',
      },
    });

    expect(result.isFullySigned).toBe(false);
    expect(result.signatureRequirementsKnown).toBe(true);
    expect(result.missingSignatures.sender).toBe(1);
  });

  it.each([
    ['malformed hex', '00ff'],
    ['JSON input', '{"version":0,"header":{}}'],
    ['non-account transaction', '02'],
  ])('rejects %s for signing', async (_name, transactionHex) => {
    await expect(
      signTransaction(transactionHex, {
        backend: { createSignature: async () => signature('77') },
        role: 'sender',
      }),
    ).rejects.toMatchObject({
      code: 'sdk_parse_failed',
    });
  });

  it.each([
    ['0', transactionFixtures.v0HexString],
    ['1', transactionFixtures.v1SponsoredHexString],
  ])('rejects a v%s block item with embedded signatures before invoking the backend', async (_version, transactionHex) => {
    const createSignature = vi.fn(async () => signature('77'));
    await expect(signTransaction(transactionHex, { backend: { createSignature }, role: 'sender' }))
      .rejects.toMatchObject({ code: 'sdk_parse_failed' });
    expect(createSignature).not.toHaveBeenCalled();
  });

  it('rejects sponsor signing for v0 transactions', async () => {
    await expect(
      signTransaction(transactionFixtures.unsignedTransferWithMemoHex, {
        backend: {
          createSignature: async () => ({}),
        },
        role: 'sponsor',
      }),
    ).rejects.toMatchObject({
      code: 'unsupported_role',
    } satisfies Partial<SigningError>);
  });

  it('rejects sponsor detached signatures for unsigned v0 hex transactions', async () => {
    await expect(
      signTransaction(transactionFixtures.unsignedTransferWithMemoHex, {
        backend: {
          createSignature: async () => ({
            0: {
              0: '11'.repeat(64),
            },
          }),
        },
        role: 'sender',
        signatures: {
          sender: {},
          sponsor: {
            0: {
              0: '22'.repeat(64),
            },
          },
        },
      }),
    ).rejects.toMatchObject({
      code: 'invalid_input',
    } satisfies Partial<SigningError>);
  });
});

function signature(byte: string, key = '0'): AccountTransactionSignature {
  return { 0: { [key]: byte.repeat(64) } };
}

function signingBackend(byte: string, key = '0') {
  const createSignature = vi.fn(async () => signature(byte, key));
  return { backend: { createSignature }, createSignature };
}
