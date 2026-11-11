import { describe, expect, it } from 'vitest';

import {
  CliUsageError,
  createSignCommandRequest,
  renderSignCommandError,
  signCommandMessages,
} from '../../../src/cli/signCommand.js';
import { transactionFixtures } from '../../helpers/transactionFixtures.js';

describe('createSignCommandRequest', () => {
  it('parses direct input with required role', () => {
    const result = createSignCommandRequest({ input: transactionFixtures.unsignedTransferWithMemoHex, role: 'sender' });
    expect(result.role).toBe('sender');
    expect(result.source).toEqual({ kind: 'input', value: transactionFixtures.unsignedTransferWithMemoHex });
    expect(result.network).toBeUndefined();
  });

  it('parses network option', () => {
    const result = createSignCommandRequest({ input: transactionFixtures.unsignedTransferWithMemoHex, role: 'sender', network: 'testnet' });
    expect(result.network).toBe('testnet');
  });

  it('parses repeated key options and max signatures', () => {
    const withKeys = createSignCommandRequest({ input: transactionFixtures.unsignedTransferWithMemoHex, role: 'sender', key: ['0:0', '0:1'] });
    const withMax = createSignCommandRequest({ input: transactionFixtures.unsignedTransferWithMemoHex, role: 'sender', maxSignatures: '2', key: [] });

    expect(withKeys.keys).toEqual(['0:0', '0:1']);
    expect(withMax.maxSignatures).toBe(2);
  });

  it('parses signature requirements JSON', () => {
    const result = createSignCommandRequest({ input: transactionFixtures.unsignedConfigureDelegationPoolHex, role: 'sender', signatureRequirements: '{"senderNumSignatures":"2","totalSignatureCount":"2"}' });

    expect(result.signatureRequirements).toEqual({
      senderNumSignatures: '2',
      totalSignatureCount: '2',
    });
  });

  it('rejects malformed signature requirements JSON', () => {
    expect(() => {
      createSignCommandRequest({ input: transactionFixtures.unsignedConfigureDelegationPoolHex, role: 'sender', signatureRequirements: '{bad' });
    }).toThrowError(new CliUsageError('Signature requirements must be valid JSON.'));
  });

  it('rejects invalid signature requirement metadata as usage errors', () => {
    for (const signatureRequirements of [
      'null',
      '[]',
      '42',
      '{"senderNumSignatures":1}',
      '{"senderNumSignatures":"1.0"}',
      '{"senderNumSignatures":"9007199254740992"}',
      '{"senderNumSignatures":"1","unknown":"1"}',
    ]) {
      expect(() => {
        createSignCommandRequest({ input: transactionFixtures.unsignedConfigureDelegationPoolHex, role: 'sender', signatureRequirements });
      }).toThrowError(CliUsageError);
    }
  });

  it('rejects key options combined with max signatures', () => {
    expect(() => {
      createSignCommandRequest({ input: transactionFixtures.unsignedTransferWithMemoHex, role: 'sender', key: ['0:0'], maxSignatures: '2' });
    }).toThrowError(new CliUsageError('Provide either --key or --max-signatures, not both.'));
  });

  it('normalizes inline detached signatures with omitted sender', () => {
    const result = createSignCommandRequest({
      input: transactionFixtures.unsignedTransferWithMemoHex,
      role: 'sender',
      signatures: '{"sponsor":{"1":{"0":"22"}}}',
    });

    expect(result.signatures).toEqual({ sender: {}, sponsor: { 1: { 0: '22' } } });
  });

  it('rejects malformed detached signatures JSON', () => {
    expect(() => {
      createSignCommandRequest({ input: transactionFixtures.unsignedTransferWithMemoHex, role: 'sender', signatures: '{bad json' });
    }).toThrowError(new CliUsageError('Detached signatures must be valid JSON.'));
  });

  it('rejects invalid inline detached signatures as usage errors', () => {
    expect(() => {
      createSignCommandRequest({
        input: transactionFixtures.unsignedTransferWithMemoHex,
        role: 'sender',
        signatures: '{"sender":{"01":{"0":"aa"}},"sponsor":{}}',
      });
    }).toThrowError(CliUsageError);
  });

  it('rejects invalid role', () => {
    expect(() => {
      createSignCommandRequest({ input: 'abc', role: 'baker' });
    }).toThrowError(CliUsageError);
  });

  it('rejects conflicting input sources', () => {
    expect(() => {
      createSignCommandRequest({ input: 'abc', stdin: true, role: 'sender' });
    }).toThrowError(CliUsageError);
  });

  it('rejects conflicting detached signature sources', () => {
    expect(() => {
      createSignCommandRequest({ input: transactionFixtures.unsignedTransferWithMemoHex, role: 'sender', signatures: '{"sender":{},"sponsor":{}}', signaturesFile: 'signatures.json' });
    }).toThrowError(new CliUsageError('Provide detached signatures via --signatures or --signatures-file, not both.'));
  });

  it('rejects missing input source', () => {
    expect(() => {
      createSignCommandRequest({ role: 'sender' });
    }).toThrowError(CliUsageError);
  });
});

describe('renderSignCommandError', () => {
  it('renders stable messages for local usage and signing errors', () => {
    expect(renderSignCommandError({ kind: 'invalid-signature-requirements-json' })).toBe(
      signCommandMessages.invalidSignatureRequirementsJson,
    );
    expect(renderSignCommandError({ kind: 'invalid-signatures-json' })).toBe(signCommandMessages.invalidSignaturesJson);
    expect(renderSignCommandError({ kind: 'key-selection-conflict' })).toBe(signCommandMessages.keySelectionConflict);
    expect(renderSignCommandError({ kind: 'signatures-source-conflict' })).toBe(signCommandMessages.signaturesSourceConflict);
    expect(renderSignCommandError({ kind: 'single-input-source-required' })).toBe(signCommandMessages.singleInputSourceRequired);
    expect(renderSignCommandError({ kind: 'signing-failed', message: 'boom' })).toBe('Signing failed: boom');
  });
});
