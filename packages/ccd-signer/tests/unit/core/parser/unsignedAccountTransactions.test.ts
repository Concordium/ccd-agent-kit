import {
  AccountAddress,
  BlockItemKind,
  Cbor,
  CborAccountAddress,
  CborEpoch,
  CborMemo,
  CcdAmount,
  ContractAddress,
  ContractName,
  CredentialRegistrationId,
  DataBlob,
  DelegationTargetType,
  LockConfig,
  LockId,
  OperationType,
  ModuleReference,
  Parameter,
  Payload,
  ReceiveName,
  TokenAdminRole,
  TokenAmount,
  TokenId,
  TokenOperationType,
  createTokenOperationWithId,
  createTokenUpdatePayload,
} from '@concordium/web-sdk';
import { describe, expect, it } from 'vitest';

import {
  ParseTransactionError,
  parseTransaction,
  parseUnsignedHexAccountTransaction,
} from '../../../../src/core/parser/parseTransaction.js';
import { projectParsedTransaction } from '../../../../src/core/model/projectParsedTransaction.js';
import { projectParsedOperation } from '../../../../src/core/parser/parsedOperations.js';
import { transactionFixtures } from '../../../helpers/transactionFixtures.js';
import { unsignedHexForPayload } from '../../../helpers/unsignedAccountTransaction.js';

const v0 = transactionFixtures.unsignedTransferWithMemoHex;
const v1 = `0300000000${v0.slice(4)}`;
const sponsored = transactionFixtures.sponsoredPltTransferTransactionHex;
const receiver = AccountAddress.fromBase58(transactionFixtures.receiver);
const amount = CcdAmount.fromMicroCcd(123n);
const credentialId = '97f1d3a73197d7942695638c4fa9ac0fc3688c4f9774b905a14e3a3f171bac586c55e83ff97a1aeffb3af00adb22c6bb';

function parsePayload(payload: Payload.Type) {
  const parsed = parseTransaction(unsignedHexForPayload(payload, 0));
  expect(parsed.kind).toBe('accountTransaction');
  if (parsed.kind !== 'accountTransaction') throw new Error('Expected an account transaction.');
  return parsed;
}

function projectPayloadSummary(payload: Payload.Type): unknown {
  return projectParsedTransaction(parsePayload(payload)).payloadSummary;
}

describe('canonical unsigned account transaction boundary', () => {
  it.each([
    [v0, 0],
    [v1, 1],
    [sponsored, 1],
  ] as const)('preserves canonical unsigned bytes: case %#', (hex, version) => {
    const parsed = parseUnsignedHexAccountTransaction(hex);
    expect(parsed.transaction.version).toBe(version);
    expect(Buffer.from(parsed.unsignedBytes).toString('hex')).toBe(hex);
    const description = parseTransaction(hex);
    expect(description).toMatchObject({
      kind: 'accountTransaction',
      version,
      signatureState: { senderSignatureCount: 0, sponsorSignatureCount: 0 },
    });
  });

  it('accepts signer CLI whitespace and 0X decoration without altering canonical bytes', () => {
    const parsed = parseUnsignedHexAccountTransaction(`  0X${v1.toUpperCase()}  `);
    expect(parsed.kind).toBe(BlockItemKind.AccountTransactionV1Kind);
    expect(Buffer.from(parsed.unsignedBytes).toString('hex')).toBe(v1);
  });

  it.each([{}, { bakingRewardCommission: 100000, transactionFeeCommission: 250000 }])(
    'preserves optional validator settings when inspecting canonical V1: case %#',
    (settings) => {
      const hex = unsignedHexForPayload(
        Payload.configureValidator({
          ...settings,
          stake: CcdAmount.fromMicroCcd(0n),
          restakeEarnings: false,
        }),
        1,
      );
      expect(parseTransaction(hex)).toMatchObject({
        kind: 'accountTransaction',
        version: 1,
        payloadSummary: {
          kind: 'configureValidator',
          bakingRewardCommission: settings.bakingRewardCommission,
          transactionFeeCommission: settings.transactionFeeCommission,
          finalizationRewardCommission: undefined,
          metadataUrl: undefined,
          openForDelegation: undefined,
          restakeEarnings: false,
          stake: '0',
        },
      });
    },
  );

  it.each([
    {
      type: 'transfer',
      payload: Payload.transfer({ amount, toAddress: receiver }),
      summary: { kind: 'transfer', amount: '123', toAddress: transactionFixtures.receiver },
    },
    {
      type: 'transferWithMemo',
      payload: Payload.transfer(
        { amount, toAddress: receiver },
        new DataBlob(Uint8Array.from(Buffer.from('hello')).buffer),
      ),
      summary: {
        kind: 'transferWithMemo',
        amount: '123',
        memo: { hex: '000568656c6c6f', text: 'hello' },
        toAddress: transactionFixtures.receiver,
      },
    },
    {
      type: 'registerData',
      payload: Payload.registerData({ data: new DataBlob(Uint8Array.from([0xff, 0x00]).buffer) }),
      summary: { kind: 'registerData', data: { hex: '0002ff00' } },
    },
    {
      type: 'deployModule',
      payload: Payload.deployModule({ source: Uint8Array.from([1, 2]), version: 1 }),
      summary: { kind: 'deployModule', source: '0102' },
    },
    {
      type: 'initContract',
      payload: Payload.initContract({
        amount,
        initName: ContractName.fromString('counter'),
        moduleRef: ModuleReference.fromHexString('11'.repeat(32)),
        param: Parameter.fromHexString('aabb'),
      }),
      summary: {
        kind: 'initContract',
        amount: '123',
        initName: 'counter',
        moduleRef: `00000020${'11'.repeat(32)}`,
        param: 'aabb',
      },
    },
    {
      type: 'update',
      payload: Payload.updateContract({
        address: ContractAddress.create(42n, 7n),
        amount,
        message: Parameter.fromHexString('aabb'),
        receiveName: ReceiveName.fromString('counter.increment'),
      }),
      summary: {
        kind: 'updateContract',
        address: { index: 42, subindex: 7 },
        amount: '123',
        message: 'aabb',
        receiveName: 'counter.increment',
      },
    },
    {
      type: 'configureDelegation',
      payload: Payload.configureDelegation({
        delegationTarget: { delegateType: DelegationTargetType.Baker, bakerId: 42n },
        restakeEarnings: true,
        stake: amount,
      }),
      summary: {
        kind: 'configureDelegation',
        delegationTarget: { bakerId: 42, delegateType: 'Baker' },
        restakeEarnings: true,
        stake: '123',
      },
    },
    {
      type: 'configureBaker',
      payload: Payload.configureValidator({ restakeEarnings: false, stake: amount }),
      summary: {
        kind: 'configureValidator',
        bakingRewardCommission: undefined,
        finalizationRewardCommission: undefined,
        metadataUrl: undefined,
        openForDelegation: undefined,
        restakeEarnings: false,
        stake: '123',
        transactionFeeCommission: undefined,
      },
    },
    {
      type: 'updateCredentials',
      payload: Payload.updateCredentials({ newCredentials: [], removeCredentialIds: ['22'.repeat(48)], threshold: 1 }),
      summary: {
        kind: 'updateCredentials',
        newCredentialCount: 0,
        removeCredentialIds: ['22'.repeat(48)],
        threshold: 1,
      },
    },
    {
      type: 'tokenUpdate',
      payload: Payload.tokenUpdate(
        createTokenUpdatePayload({ tokenId: TokenId.fromString('TOK'), operations: { pause: {} } }),
      ),
      summary: { kind: 'tokenUpdate', variant: 'scoped', operations: [{ pause: {} }], tokenId: 'TOK' },
    },
    {
      type: 'tokenUpdate',
      payload: Payload.tokenUpdate(
        createTokenUpdatePayload({
          operations: createTokenOperationWithId(TokenId.fromString('TOK'), { pause: {} }),
        }),
      ),
      summary: { kind: 'tokenUpdate', variant: 'unscoped', operations: [{ tokenPause: { token: 'TOK' } }] },
    },
    {
      type: 'updateCredentialKeys',
      payload: Payload.updateCredentialKeys({
        credId: CredentialRegistrationId.fromHexString(credentialId),
        keys: { keys: { 0: { schemeId: 'Ed25519', verifyKey: '44'.repeat(32) } }, threshold: 1 },
      }),
      summary: { kind: 'generic', type: 'updateCredentialKeys' },
    },
  ])('summarizes the valid SDK $type payload', ({ payload, summary, type }) => {
    const parsed = parsePayload(payload);
    expect(parsed.payloadType).toBe(type);
    expect(projectParsedTransaction(parsed).payloadSummary).toEqual(summary);
  });

  it('uses decoded CBOR string text for a non-ASCII transfer memo', () => {
    const memo = new DataBlob(Uint8Array.from(Cbor.encode('é').bytes).buffer);

    expect(projectPayloadSummary(Payload.transfer({ amount, toAddress: receiver }, memo))).toMatchObject({
      kind: 'transferWithMemo',
      memo: { cbor: 'é', hex: '000362c3a9', text: 'é' },
    });
  });

  it.each([
    ['mint', { mint: { amount: TokenAmount.create(123n, 2) } }, { mint: { amount: { value: '123', decimals: 2 } } }],
    ['burn', { burn: { amount: TokenAmount.create(123n, 2) } }, { burn: { amount: { value: '123', decimals: 2 } } }],
    [
      'addAllowList',
      { addAllowList: { target: CborAccountAddress.fromBase58(transactionFixtures.receiver) } },
      { addAllowList: { target: { address: transactionFixtures.receiver, coinInfo: 919 } } },
    ],
    [
      'removeAllowList',
      { removeAllowList: { target: CborAccountAddress.fromBase58(transactionFixtures.receiver) } },
      { removeAllowList: { target: { address: transactionFixtures.receiver, coinInfo: 919 } } },
    ],
    [
      'addDenyList',
      { addDenyList: { target: CborAccountAddress.fromBase58(transactionFixtures.receiver) } },
      { addDenyList: { target: { address: transactionFixtures.receiver, coinInfo: 919 } } },
    ],
    [
      'removeDenyList',
      { removeDenyList: { target: CborAccountAddress.fromBase58(transactionFixtures.receiver) } },
      { removeDenyList: { target: { address: transactionFixtures.receiver, coinInfo: 919 } } },
    ],
    ['unpause', { unpause: {} }, { unpause: {} }],
  ] as const)('projects SDK-validated token %s details', (_name, operation, expected) => {
    const payload = Payload.tokenUpdate(
      createTokenUpdatePayload({ tokenId: TokenId.fromString('TOK'), operations: operation }),
    );
    expect(projectPayloadSummary(payload)).toMatchObject({
      kind: 'tokenUpdate',
      variant: 'scoped',
      operations: [expected],
    });
  });

  it('retains native participant and amount values until terminal operation projection', () => {
    const payload = Payload.tokenUpdate(
      createTokenUpdatePayload({
        tokenId: TokenId.fromString('TOK'),
        operations: {
          transfer: {
            amount: TokenAmount.create(123n, 2),
            recipient: CborAccountAddress.fromBase58(transactionFixtures.receiver),
          },
        },
      }),
    );
    const summary = parsePayload(payload).payloadSummary;
    if (summary.kind !== 'tokenUpdate') throw new Error('Expected a token update.');
    const operation = summary.operations[0]!;

    expect(operation.kind).toBe('knownOperation');
    if (operation.kind !== 'knownOperation' || !('transfer' in operation.operation)) {
      throw new Error('Expected a known transfer operation.');
    }
    expect(operation.participantLabels).toEqual(new Map());
    expect(CborAccountAddress.instanceOf(operation.operation.transfer.recipient)).toBe(true);
    expect(TokenAmount.instanceOf(operation.operation.transfer.amount)).toBe(true);
    expect(projectParsedOperation(operation)).toEqual({
      transfer: {
        amount: { value: '123', decimals: 2 },
        recipient: { address: transactionFixtures.receiver, coinInfo: 919 },
      },
    });
  });

  it('projects SDK-validated lock funding details', () => {
    const lock = LockId.create(1n, 2n, 3n);
    const payload = Payload.tokenUpdate(
      createTokenUpdatePayload({
        operations: {
          lockFund: {
            token: TokenId.fromString('TOK'),
            lock,
            amount: TokenAmount.create(123n, 2),
            memo: CborMemo.fromAny('funding'),
          },
        },
      }),
    );

    expect(projectPayloadSummary(payload)).toMatchObject({
      kind: 'tokenUpdate',
      variant: 'unscoped',
      operations: [
        {
          lockFund: {
            token: 'TOK',
            lockId: lock.toString(),
            amount: { value: '123', decimals: 2 },
            memo: { cbor: 'funding', text: 'gfunding' },
          },
        },
      ],
    });
  });

  it.each([
    { label: 'invalid UTF-8', bytes: [0xff] },
    { label: 'non-printable UTF-8', bytes: [0x00] },
  ])('keeps an opaque raw operation memo for $label bytes', ({ bytes }) => {
    const payload = Payload.tokenUpdate(
      createTokenUpdatePayload({
        operations: {
          lockCancel: { lock: LockId.create(1n, 2n, 3n), memo: Uint8Array.from(bytes) },
        },
      }),
    );
    expect(projectPayloadSummary(payload)).toMatchObject({
      kind: 'tokenUpdate',
      variant: 'unscoped',
      operations: [{ lockCancel: { memo: { hex: Buffer.from(bytes).toString('hex') } } }],
    });
  });

  it('normalizes nested CBOR memo byte strings and arrays without losing their shape', () => {
    const memo = CborMemo.fromAny({ nested: [Uint8Array.from([0xaa]), [Uint8Array.from([0xbb, 0xcc])]] });
    const payload = Payload.tokenUpdate(
      createTokenUpdatePayload({
        operations: {
          lockCancel: { lock: LockId.create(1n, 2n, 3n), memo },
        },
      }),
    );
    expect(projectPayloadSummary(payload)).toMatchObject({
      kind: 'tokenUpdate',
      variant: 'unscoped',
      operations: [{ lockCancel: { memo: { cbor: { nested: ['aa', ['bbcc']] } } } }],
    });
  });

  it('classifies a lock operation by update scope while preserving its decoded wire shape', () => {
    const operation = {
      [OperationType.LockCreate]: LockConfig.simpleV0(
        [CborAccountAddress.fromBase58(transactionFixtures.receiver)],
        CborEpoch.fromEpochSeconds(1_800_000_000),
        [
          {
            account: CborAccountAddress.fromBase58(transactionFixtures.sponsor),
            roles: [LockConfig.SimpleV0Capability.Send],
          },
        ],
        [TokenId.fromString('TOK')],
        true,
        CborMemo.fromAny({ purpose: 'escrow' }),
      ),
    };
    const operations = Cbor.encode([operation]);
    const expectedWireOperation = {
      lockCreate: {
        simpleV0: {
          expiry: 1_800_000_000,
          recipients: [{ address: transactionFixtures.receiver, coinInfo: 919 }],
          grants: [
            {
              account: { address: transactionFixtures.sponsor, coinInfo: 919 },
              roles: ['send'],
            },
          ],
          keepAlive: true,
          memo: 'a167707572706f736566657363726f77',
          tokens: ['TOK'],
        },
      },
    };

    expect(
      parsePayload(Payload.tokenUpdate({ variant: 'scoped', tokenId: TokenId.fromString('TOK'), operations }))
        .payloadSummary,
    ).toEqual({
      kind: 'tokenUpdate',
      variant: 'scoped',
      tokenId: 'TOK',
      operations: [{ kind: 'opaqueOperation', operation: expectedWireOperation }],
    });
    expect(projectPayloadSummary(Payload.tokenUpdate({ variant: 'unscoped', operations }))).toEqual({
      kind: 'tokenUpdate',
      variant: 'unscoped',
      operations: [
        {
          lockCreate: {
            ...expectedWireOperation.lockCreate,
            simpleV0: {
              ...expectedWireOperation.lockCreate.simpleV0,
              memo: {
                hex: 'a167707572706f736566657363726f77',
                cbor: { purpose: 'escrow' },
              },
            },
          },
        },
      ],
    });
  });

  it.each(['scoped', 'unscoped'] as const)(
    'preserves the SDK metadata URL JSON shape for a %s update operation',
    (scope) => {
      const metadata = {
        url: 'https://example.com/token.json',
        checksumSha256: Uint8Array.from({ length: 32 }, () => 0xaa),
      };
      const operation = { [TokenOperationType.UpdateMetadata]: metadata };
      const payload =
        scope === 'scoped'
          ? Payload.tokenUpdate(createTokenUpdatePayload({ tokenId: TokenId.fromString('TOK'), operations: operation }))
          : Payload.tokenUpdate(
              createTokenUpdatePayload({
                operations: createTokenOperationWithId(TokenId.fromString('TOK'), operation),
              }),
            );

      expect(projectPayloadSummary(payload)).toMatchObject({
        kind: 'tokenUpdate',
        variant: scope,
        operations: [
          {
            [scope === 'unscoped' ? 'tokenUpdateMetadata' : 'updateMetadata']: {
              ...(scope === 'unscoped' ? { token: 'TOK' } : {}),
              url: 'https://example.com/token.json',
              checksumSha256: 'aa'.repeat(32),
            },
          },
        ],
      });
    },
  );

  it('ignores direct metadata extension fields from a raw unscoped token-update operation', () => {
    const payload = Payload.tokenUpdate({
      variant: 'unscoped',
      operations: Cbor.encode([
        {
          tokenUpdateMetadata: {
            token: 'TOK',
            url: 'https://example.com/token.json',
            additional: { icon: 'https://nested.example/icon' },
            icon: 'ipfs://icon',
          },
        },
      ]),
    });

    expect(projectPayloadSummary(payload)).toEqual({
      kind: 'tokenUpdate',
      variant: 'unscoped',
      operations: [
        {
          tokenUpdateMetadata: {
            token: 'TOK',
            url: 'https://example.com/token.json',
          },
        },
      ],
    });
  });

  it('preserves token and roles for known unscoped admin operations', () => {
    const account = CborAccountAddress.fromBase58(transactionFixtures.receiver);
    const payload = Payload.tokenUpdate({
      variant: 'unscoped',
      operations: Cbor.encode([
        {
          tokenAssignAdminRoles: {
            token: 'TOK',
            account,
            roles: [TokenAdminRole.Mint, TokenAdminRole.UpdateMetadata],
          },
        },
        {
          tokenRevokeAdminRoles: {
            token: 'TOK',
            account,
            roles: [TokenAdminRole.Burn],
          },
        },
      ]),
    });

    expect(projectPayloadSummary(payload)).toEqual({
      kind: 'tokenUpdate',
      variant: 'unscoped',
      operations: [
        {
          tokenAssignAdminRoles: {
            token: 'TOK',
            account: { address: transactionFixtures.receiver, coinInfo: 919 },
            roles: ['mint', 'updateMetadata'],
          },
        },
        {
          tokenRevokeAdminRoles: {
            token: 'TOK',
            account: { address: transactionFixtures.receiver, coinInfo: 919 },
            roles: ['burn'],
          },
        },
      ],
    });
  });

  it('rejects an empty token id in raw unscoped metadata CBOR', () => {
    const payload = Payload.tokenUpdate({
      variant: 'unscoped',
      operations: Cbor.encode([{ tokenUpdateMetadata: { token: '', url: 'https://example.com/token.json' } }]),
    });

    expect(() => parsePayload(payload)).toThrow(ParseTransactionError);
  });

  it.each(['tokenAssignAdminRoles', 'tokenRevokeAdminRoles'] as const)(
    'rejects an invalid-character token id in raw unscoped %s CBOR',
    (operation) => {
      const payload = Payload.tokenUpdate({
        variant: 'unscoped',
        operations: Cbor.encode([
          {
            [operation]: {
              token: 'NOT_VALID',
              account: CborAccountAddress.fromBase58(transactionFixtures.receiver),
              roles: [TokenAdminRole.Mint],
            },
          },
        ]),
      });

      expect(() => parsePayload(payload)).toThrow(ParseTransactionError);
    },
  );

  it('rejects an overlong token id in a raw lock-create controller', () => {
    const payload = Payload.tokenUpdate({
      variant: 'unscoped',
      operations: Cbor.encode([
        {
          lockCreate: {
            simpleV0: {
              recipients: 'any',
              expiry: CborEpoch.fromEpochSeconds(1_800_000_000),
              grants: [],
              tokens: ['A'.repeat(129)],
            },
          },
        },
      ]),
    });

    expect(() => parsePayload(payload)).toThrow(ParseTransactionError);
  });

  it('rejects malformed operation CBOR instead of presenting an empty operation list', () => {
    const payload = Payload.tokenUpdate({
      variant: 'scoped',
      tokenId: TokenId.fromString('TOK'),
      operations: Cbor.fromHexString('ff'),
    });
    expect(() => parsePayload(payload)).toThrow(ParseTransactionError);
  });

  it('rejects a malformed metadata operation from an SDK decoder gap', () => {
    const payload = Payload.tokenUpdate({
      variant: 'scoped',
      tokenId: TokenId.fromString('TOK'),
      operations: Cbor.encode([{ updateMetadata: {} }]),
    });
    expect(() => parsePayload(payload)).toThrow(ParseTransactionError);
  });

  it('rejects a metadata checksum that is not 32 bytes', () => {
    const payload = Payload.tokenUpdate({
      variant: 'scoped',
      tokenId: TokenId.fromString('TOK'),
      operations: Cbor.encode([{ updateMetadata: { url: 'https://example.com', checksumSha256: Uint8Array.of(1) } }]),
    });
    expect(() => parsePayload(payload)).toThrow(ParseTransactionError);
  });

  it.each(['f', 'zz'])('rejects a malformed suffix even with explicit hex inspection: %s', (suffix) => {
    expect(() => parseTransaction(v1 + suffix, { format: 'hex' })).toThrow(ParseTransactionError);
  });

  it.each([v0.slice(4), sponsored.slice(6), '0002' + v0.slice(4), v0.slice(0, -2), v0 + '00', 'zz'])(
    'rejects malformed or noncanonical unsigned bytes: case %#',
    (hex) => {
      expect(() => parseUnsignedHexAccountTransaction(hex)).toThrow(ParseTransactionError);
    },
  );
});
