import { describe, expect, it } from 'vitest';
import {
  buildConfigureBakerArgsSchema,
  buildConfigureDelegationArgsSchema,
  buildInitContractArgsSchema,
  buildPltArgsSchema,
  buildRegisterDataArgsSchema,
  buildTransferArgsSchema,
  buildUpdateContractArgsSchema,
  buildUpdateCredentialKeysArgsSchema,
} from '../../../../../src/mcp/transactions/internal/schemas.js';
import { MODULE_REF, SENDER, TO, schemaMessages } from '../../../../mcp/transactions/internal/builders.fixtures.js';

describe('builder schema validation', () => {
  it('rejects plain CCD transfers with both memo fields', () => {
    const result = buildTransferArgsSchema.safeParse({
      sender: SENDER,
      toAddress: TO,
      amountMicroCcd: '1',
      memoText: 'text',
      memoJson: { json: true },
    });

    expect(schemaMessages(result)).toContain('Provide at most one of memoText or memoJson.');
  });

  const replacementKey = { scheme: 'Ed25519', publicKey: 'cd'.repeat(32) };
  it.each([
    [
      'ambiguous selector',
      { credentialId: 'ab'.repeat(48) },
      'Provide exactly one of credentialIndex or credentialId.',
    ],
    ['excessive threshold', { threshold: 2 }, 'threshold must be at most the number of replacement keys.'],
    ['empty keys', { keys: {} }, 'At least one replacement key is required.'],
    ['out-of-range index', { keys: { '256': replacementKey } }, undefined],
    ['padded index', { keys: { '00': replacementKey } }, undefined],
    ['colliding indexes', { keys: { '0': replacementKey, '00': replacementKey }, threshold: 2 }, undefined],
    [
      'short public key',
      { keys: { '0': { ...replacementKey, publicKey: 'cd'.repeat(31) } } },
      'Invalid Ed25519 public key hex.',
    ],
    [
      'unsupported scheme',
      { keys: { '0': { ...replacementKey, scheme: 'P256' } } },
      'Unsupported public key scheme: P256',
    ],
  ] as const)('rejects credential key replacement with %s', (_name, changes, message) => {
    const result = buildUpdateCredentialKeysArgsSchema.safeParse({
      sender: SENDER,
      credentialIndex: '0',
      keys: { '0': replacementKey },
      threshold: 1,
      ...changes,
    });
    expect(result.success).toBe(false);
    if (message !== undefined) expect(schemaMessages(result)).toContain(message);
  });

  it.each(['0', '255'])('normalizes key casing and accepts boundary index %s', (keyIndex) => {
    const result = buildUpdateCredentialKeysArgsSchema.parse({
      sender: SENDER,
      credentialIndex: '0',
      keys: { [keyIndex]: { scheme: 'ed25519', publicKey: 'CD'.repeat(32) } },
      threshold: 1,
    });
    expect(result.keys[keyIndex]).toEqual(replacementKey);
  });

  it.each([
    ['non-hex', 'zz'],
    ['whitespace', 'aa zz'],
    ['odd-length', 'a'],
    ['oversized', 'aa'.repeat(257)],
  ])('rejects %s register data at the schema boundary', (_name, dataHex) => {
    expect(buildRegisterDataArgsSchema.safeParse({ sender: SENDER, dataHex }).success).toBe(false);
  });

  it.each([
    ['empty', ''],
    ['uppercase', 'ABCD'],
    ['maximum-sized', 'aa'.repeat(256)],
  ])('accepts %s register data', (_name, dataHex) => {
    expect(buildRegisterDataArgsSchema.safeParse({ sender: SENDER, dataHex }).success).toBe(true);
  });

  it.each([
    [
      'init contract',
      buildInitContractArgsSchema,
      { sender: SENDER, moduleRef: MODULE_REF, initName: 'init_demo', parameterHex: '00', parameterJson: false },
    ],
    [
      'update contract',
      buildUpdateContractArgsSchema,
      { sender: SENDER, contract: '1,0', receiveName: 'demo.receive', parameterHex: '00', parameterJson: false },
    ],
  ])('rejects %s with both parameter encodings', (_name, schema, args) => {
    const result = schema.safeParse(args);

    expect(schemaMessages(result)).toContain('parameterHex and parameterJson are mutually exclusive.');
  });

  it('accepts null JSON values and rejects non-JSON values at builder boundaries', () => {
    expect(
      buildTransferArgsSchema.safeParse({
        sender: SENDER,
        toAddress: TO,
        amountMicroCcd: '1',
        memoJson: null,
      }).success,
    ).toBe(true);

    expect(
      buildInitContractArgsSchema.safeParse({
        sender: SENDER,
        moduleRef: MODULE_REF,
        initName: 'init_demo',
        parameterJson: null,
      }).success,
    ).toBe(true);

    expect(
      buildTransferArgsSchema.safeParse({
        sender: SENDER,
        toAddress: TO,
        amountMicroCcd: '1',
        memoJson: () => true,
      }).success,
    ).toBe(false);

    expect(
      buildUpdateContractArgsSchema.safeParse({
        sender: SENDER,
        contract: '1,0',
        receiveName: 'demo.receive',
        parameterJson: () => true,
      }).success,
    ).toBe(false);
  });

  it.each([
    [
      'transfer',
      {
        type: 'transfer',
        tokenId: 'IMT',
        toAddress: TO,
        amountUnits: '1',
        memoText: 'text',
        memoJson: { json: true },
      },
    ],
    [
      'lock_fund',
      {
        type: 'lock_fund',
        tokenId: 'IMT',
        amountUnits: '1',
        lockId: 'YGLvYhNvZ9',
        memoText: 'text',
        memoJson: { json: true },
      },
    ],
    [
      'lock_send',
      {
        type: 'lock_send',
        tokenId: 'IMT',
        amountUnits: '1',
        sourceAddress: SENDER,
        toAddress: TO,
        lockId: 'YGLvYhNvZ9',
        memoText: 'text',
        memoJson: { json: true },
      },
    ],
    [
      'lock_cancel',
      {
        type: 'lock_cancel',
        lockId: 'YGLvYhNvZ9',
        memoText: 'text',
        memoJson: { json: true },
      },
    ],
    [
      'lock_release',
      {
        type: 'lock_release',
        tokenId: 'IMT',
        amountUnits: '1',
        sourceAddress: SENDER,
        lockId: 'YGLvYhNvZ9',
        memoText: 'text',
        memoJson: { json: true },
      },
    ],
  ])('rejects %s operations with both memo fields', (_name, operation) => {
    const result = buildPltArgsSchema.safeParse({
      sender: SENDER,
      operations: [operation],
    });

    expect(schemaMessages(result)).toContain('Provide at most one of memoText or memoJson.');
  });

  it('rejects lock creation with both controller memo fields', () => {
    const result = buildPltArgsSchema.safeParse({
      sender: SENDER,
      operations: [
        {
          type: 'lock_create',
          recipients: 'any',
          lockExpiryUnixSeconds: '1787076000',
          grants: [{ account: SENDER, capabilities: ['fund'] }],
          tokenIds: ['IMT'],
          controllerMemoText: 'text',
          controllerMemoJson: { json: true },
        },
      ],
    });

    expect(schemaMessages(result)).toContain('Provide at most one of controllerMemoText or controllerMemoJson.');
    const metadataJson = {
      name: 'Escrow',
      description: 'Release after delivery',
      reference: 42,
      custom: { enabled: true },
    };
    const metadataResult = buildPltArgsSchema.safeParse({
      sender: SENDER,
      operations: [
        {
          type: 'lock_create',
          recipients: 'any',
          lockExpiryUnixSeconds: '1787076000',
          grants: [{ account: SENDER, capabilities: ['fund'] }],
          tokenIds: ['IMT'],
          metadataJson,
        },
      ],
    });
    expect(metadataResult.success).toBe(true);
    if (metadataResult.success) {
      expect((metadataResult.data.operations[0] as unknown as { metadataJson?: unknown }).metadataJson).toEqual(
        metadataJson,
      );
    }
    expect(
      buildPltArgsSchema.safeParse({
        sender: SENDER,
        operations: [
          {
            type: 'lock_create',
            recipients: 'any',
            lockExpiryUnixSeconds: '1787076000',
            grants: [{ account: SENDER, capabilities: ['fund'] }],
            tokenIds: ['IMT'],
            metadataJson: {},
          },
        ],
      }).success,
    ).toBe(true);
    for (const metadataJson of [null, [], { name: 42 }, { description: 42 }]) {
      expect(
        buildPltArgsSchema.safeParse({
          sender: SENDER,
          operations: [
            {
              type: 'lock_create',
              recipients: 'any',
              lockExpiryUnixSeconds: '1787076000',
              grants: [{ account: SENDER, capabilities: ['fund'] }],
              tokenIds: ['IMT'],
              metadataJson,
            },
          ],
        }).success,
      ).toBe(false);
    }
    expect(
      buildPltArgsSchema.safeParse({
        sender: SENDER,
        operations: [
          { type: 'lock_return', lockId: 'YGLvYhNvZ9', tokenId: 'IMT', amountUnits: '1', sourceAddress: SENDER },
        ],
      }).success,
    ).toBe(false);
    expect(
      buildPltArgsSchema.safeParse({
        sender: SENDER,
        operations: [
          {
            type: 'lock_create',
            recipients: 'any',
            lockExpiryUnixSeconds: '1787076000',
            grants: [{ account: SENDER, capabilities: ['return'] }],
            tokenIds: ['IMT'],
          },
        ],
      }).success,
    ).toBe(false);
  });

  it('rejects duplicate lock creation refs', () => {
    const result = buildPltArgsSchema.safeParse({
      sender: SENDER,
      operations: [
        {
          type: 'lock_create',
          ref: 'main-lock',
          recipients: 'any',
          lockExpiryUnixSeconds: '1787076000',
          grants: [{ account: SENDER, capabilities: ['fund'] }],
          tokenIds: ['IMT'],
        },
        {
          type: 'lock_create',
          ref: 'main-lock',
          recipients: 'any',
          lockExpiryUnixSeconds: '1787077000',
          grants: [{ account: SENDER, capabilities: ['cancel'] }],
          tokenIds: ['IMT'],
        },
      ],
    });

    expect(schemaMessages(result)).toContain("Duplicate lock ref 'main-lock'.");
  });

  it.each([
    [
      'lock_fund',
      { type: 'lock_fund', tokenId: 'IMT', amountUnits: '1' },
      {
        type: 'lock_fund',
        tokenId: 'IMT',
        amountUnits: '1',
        lockId: 'YGLvYhNvZ9',
        lockRef: 'main-lock',
      },
    ],
    [
      'lock_send',
      { type: 'lock_send', tokenId: 'IMT', amountUnits: '1', sourceAddress: SENDER, toAddress: TO },
      {
        type: 'lock_send',
        tokenId: 'IMT',
        amountUnits: '1',
        sourceAddress: SENDER,
        toAddress: TO,
        lockId: 'YGLvYhNvZ9',
        lockRef: 'main-lock',
      },
    ],
    ['lock_cancel', { type: 'lock_cancel' }, { type: 'lock_cancel', lockId: 'YGLvYhNvZ9', lockRef: 'main-lock' }],
    [
      'lock_release',
      { type: 'lock_release', tokenId: 'IMT', amountUnits: '1', sourceAddress: SENDER },
      {
        type: 'lock_release',
        tokenId: 'IMT',
        amountUnits: '1',
        sourceAddress: SENDER,
        lockId: 'YGLvYhNvZ9',
        lockRef: 'main-lock',
      },
    ],
  ])('requires exactly one lock reference field for %s', (_name, noReferenceOperation, bothReferenceOperation) => {
    const withoutReference = buildPltArgsSchema.safeParse({
      sender: SENDER,
      operations: [noReferenceOperation],
    });
    const withBothReferences = buildPltArgsSchema.safeParse({
      sender: SENDER,
      operations: [bothReferenceOperation],
    });

    expect(schemaMessages(withoutReference)).toContain('Provide exactly one of lockId or lockRef.');
    expect(schemaMessages(withBothReferences)).toContain('Provide exactly one of lockId or lockRef.');
  });

  it.each([
    ['transfer', buildTransferArgsSchema, { sender: SENDER, toAddress: TO, amountMicroCcd: '1' }],
    ['register data', buildRegisterDataArgsSchema, { sender: SENDER, dataHex: 'abcd' }],
    ['configure delegation', buildConfigureDelegationArgsSchema, { sender: SENDER, delegationTarget: 'passive' }],
    ['configure baker', buildConfigureBakerArgsSchema, { sender: SENDER }],
    [
      'init contract',
      buildInitContractArgsSchema,
      { sender: SENDER, moduleRef: MODULE_REF, initName: 'init_contract' },
    ],
    [
      'update contract',
      buildUpdateContractArgsSchema,
      { sender: SENDER, contract: '1,0', receiveName: 'demo.receive' },
    ],
    ['PLT', buildPltArgsSchema, { sender: SENDER, operations: [{ type: 'pause', tokenId: 'IMT' }] }],
  ])('rejects %s args with sponsorNumSignatures but no sponsor', (_name, schema, args) => {
    const result = schema.safeParse({ ...args, sponsorNumSignatures: '1' });

    expect(schemaMessages(result)).toContain('sponsorNumSignatures requires sponsor to be provided.');
  });
});
