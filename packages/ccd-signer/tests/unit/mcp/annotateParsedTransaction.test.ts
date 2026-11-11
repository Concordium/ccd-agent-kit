import {
  AccountAddress,
  Cbor,
  CborAccountAddress,
  CborEpoch,
  CcdAmount,
  LockConfig,
  LockId,
  OperationType,
  Payload,
  TokenAdminRole,
  TokenAmount,
  TokenId,
  TokenOperationType,
  createTokenUpdatePayload,
} from '@concordium/web-sdk';
import { toJsonSafe } from '@ccd-agent-kit/mcp-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { parseTransaction } from '../../../src/core/parser/parseTransaction.js';
import { annotateParsedTransactionAccounts } from '../../../src/mcp/annotateParsedTransaction.js';
import { transactionFixtures } from '../../helpers/transactionFixtures.js';
import { unsignedHexForPayload } from '../../helpers/unsignedAccountTransaction.js';

vi.mock('@ccd-agent-kit/config-utils', () => ({
  findAccountLabelInMap: (address: string, labels: Record<string, string>) =>
    Object.entries(labels).find(([, candidate]) => candidate === address)?.[0],
  loadAccountLabels: vi.fn(),
}));

import { loadAccountLabels } from '@ccd-agent-kit/config-utils';

const sender = transactionFixtures.sender;
const recipient = transactionFixtures.receiver;
const sponsor = transactionFixtures.sponsor;
const sponsoredSender = '3BRQgT1WY48tQUcgRNNqqSifo2VEENkY4gCX3Qx9UQ9S7kYVLP';
const sponsoredSponsor = '3xAJhMaYdBqVb2pyo34nFuNGqsEbtvVaHBELaPoRm9gPvqDqus';
const account = (address: string) => CborAccountAddress.fromBase58(address);
const amount = TokenAmount.create(1n, 6);
const lock = LockId.create(1n, 2n, 3n);

function parsePayload(payload: Payload.Type) {
  return parseTransaction(unsignedHexForPayload(payload, 0));
}

function annotate(payload: Payload.Type) {
  return toJsonSafe(annotateParsedTransactionAccounts(parsePayload(payload), { caip2Ref: 'network-ref' }));
}

describe('typed parsed-transaction account annotation', () => {
  beforeEach(() => {
    vi.mocked(loadAccountLabels).mockReset().mockReturnValue({
      senderLabel: sender,
      recipientLabel: recipient,
      sponsorLabel: sponsor,
      sponsoredSenderLabel: sponsoredSender,
      sponsoredSponsorLabel: sponsoredSponsor,
    });
  });

  it('annotates header participants and the CCD transfer recipient without changing address wire fields', () => {
    const sponsored = parseTransaction(transactionFixtures.sponsoredPltTransferTransactionHex);
    const sponsoredJson = toJsonSafe(annotateParsedTransactionAccounts(sponsored, { caip2Ref: 'network-ref' }));
    expect(sponsoredJson).toMatchObject({
      header: {
        sender: sponsoredSender,
        senderAccountLabel: 'sponsoredSenderLabel',
        sponsor: sponsoredSponsor,
        sponsorAccountLabel: 'sponsoredSponsorLabel',
      },
    });

    expect(
      annotate(
        Payload.transfer({
          amount: CcdAmount.fromMicroCcd(1n),
          toAddress: AccountAddress.fromBase58(recipient),
        }),
      ),
    ).toMatchObject({
      payloadSummary: { toAddress: recipient, toAccountLabel: 'recipientLabel' },
    });
  });

  it('annotates every token-operation participant path and preserves the decoded operation wire shape', () => {
    const payload = Payload.tokenUpdate(
      createTokenUpdatePayload({
        tokenId: TokenId.fromString('TOK'),
        operations: [
          { [TokenOperationType.Transfer]: { amount, recipient: account(recipient) } },
          { [TokenOperationType.AddAllowList]: { target: account(sponsor) } },
          { [TokenOperationType.RemoveAllowList]: { target: account(sponsor) } },
          { [TokenOperationType.AddDenyList]: { target: account(sponsor) } },
          { [TokenOperationType.RemoveDenyList]: { target: account(sponsor) } },
          {
            [TokenOperationType.AssignAdminRoles]: {
              account: account(sender),
              roles: [TokenAdminRole.Mint],
            },
          },
          {
            [TokenOperationType.RevokeAdminRoles]: {
              account: account(sender),
              roles: [TokenAdminRole.Burn],
            },
          },
        ],
      }),
    );

    const parsed = parsePayload(payload);
    if (parsed.kind !== 'accountTransaction' || parsed.payloadSummary.kind !== 'tokenUpdate') {
      throw new Error('Expected a token-update account transaction.');
    }
    const transfer = parsed.payloadSummary.operations[0]!;
    if (transfer.kind !== 'knownOperation' || !('transfer' in transfer.operation)) {
      throw new Error('Expected a known transfer operation.');
    }
    const recipientAddress = transfer.operation.transfer.recipient;
    const projected = toJsonSafe(annotateParsedTransactionAccounts(parsed, { caip2Ref: 'network-ref' }));

    expect(transfer.participantLabels.get(recipientAddress)).toBe('recipientLabel');
    expect(projected).toMatchObject({
      payloadSummary: {
        operations: [
          { transfer: { recipient: { address: recipient, accountLabel: 'recipientLabel', coinInfo: 919 } } },
          { addAllowList: { target: { address: sponsor, accountLabel: 'sponsorLabel' } } },
          { removeAllowList: { target: { address: sponsor, accountLabel: 'sponsorLabel' } } },
          { addDenyList: { target: { address: sponsor, accountLabel: 'sponsorLabel' } } },
          { removeDenyList: { target: { address: sponsor, accountLabel: 'sponsorLabel' } } },
          { assignAdminRoles: { account: { address: sender, accountLabel: 'senderLabel' } } },
          { revokeAdminRoles: { account: { address: sender, accountLabel: 'senderLabel' } } },
        ],
      },
    });
  });

  it('annotates lock-create, lock-send, and lock-release participant paths', () => {
    const lockCreate = {
      [OperationType.LockCreate]: LockConfig.simpleV0(
        [account(recipient)],
        CborEpoch.fromEpochSeconds(1_800_000_000),
        [{ account: account(sponsor), roles: [LockConfig.SimpleV0Capability.Send] }],
        [TokenId.fromString('TOK')],
      ),
    };
    const tokenScopedLockCreate = annotate(
      Payload.tokenUpdate({
        variant: 'scoped',
        tokenId: TokenId.fromString('TOK'),
        operations: Cbor.encode([lockCreate]),
      }),
    );
    expect(tokenScopedLockCreate).toMatchObject({
      payloadSummary: {
        operations: [
          {
            lockCreate: {
              simpleV0: {
                recipients: [{ address: recipient, coinInfo: 919 }],
                grants: [{ account: { address: sponsor, coinInfo: 919 } }],
              },
            },
          },
        ],
      },
    });
    expect(JSON.stringify(tokenScopedLockCreate)).not.toContain('recipientLabel');
    expect(JSON.stringify(tokenScopedLockCreate)).not.toContain('sponsorLabel');

    const payload = Payload.tokenUpdate(
      createTokenUpdatePayload({
        operations: [
          lockCreate,
          {
            [OperationType.LockSend]: {
              token: TokenId.fromString('TOK'),
              lock,
              source: account(sender),
              amount,
              recipient: account(recipient),
            },
          },
          {
            [OperationType.LockRelease]: {
              token: TokenId.fromString('TOK'),
              lock,
              source: account(sponsor),
              amount,
            },
          },
        ],
      }),
    );

    expect(annotate(payload)).toMatchObject({
      payloadSummary: {
        operations: [
          {
            lockCreate: {
              simpleV0: {
                recipients: [{ address: recipient, accountLabel: 'recipientLabel' }],
                grants: [{ account: { address: sponsor, accountLabel: 'sponsorLabel' } }],
              },
            },
          },
          {
            lockSend: {
              source: { address: sender, accountLabel: 'senderLabel' },
              recipient: { address: recipient, accountLabel: 'recipientLabel' },
            },
          },
          { lockRelease: { source: { address: sponsor, accountLabel: 'sponsorLabel' } } },
        ],
      },
    });
  });

  it('keeps known and unnamed addresses distinct within the same operation', () => {
    vi.mocked(loadAccountLabels).mockReturnValue({ recipientLabel: recipient });
    const payload = Payload.tokenUpdate(
      createTokenUpdatePayload({
        operations: {
          [OperationType.LockSend]: {
            token: TokenId.fromString('TOK'),
            lock,
            source: account(sender),
            amount,
            recipient: account(recipient),
          },
        },
      }),
    );

    const projected = annotate(payload);
    expect(projected).toMatchObject({
      payloadSummary: {
        operations: [
          {
            lockSend: {
              source: { address: sender },
              recipient: { address: recipient, accountLabel: 'recipientLabel' },
            },
          },
        ],
      },
    });
    expect(JSON.stringify(projected)).not.toContain('senderLabel');
  });

  it('annotates equal source and recipient addresses represented by separate SDK values', () => {
    const payload = Payload.tokenUpdate(
      createTokenUpdatePayload({
        operations: {
          [OperationType.LockSend]: {
            token: TokenId.fromString('TOK'),
            lock,
            source: account(recipient),
            amount,
            recipient: account(recipient),
          },
        },
      }),
    );

    expect(annotate(payload)).toMatchObject({
      payloadSummary: {
        operations: [
          {
            lockSend: {
              source: { address: recipient, accountLabel: 'recipientLabel' },
              recipient: { address: recipient, accountLabel: 'recipientLabel' },
            },
          },
        ],
      },
    });
  });

  it('leaves every account-label field absent when no local labels match', () => {
    vi.mocked(loadAccountLabels).mockReturnValue({});
    const sponsored = toJsonSafe(
      annotateParsedTransactionAccounts(parseTransaction(transactionFixtures.sponsoredPltTransferTransactionHex), {
        caip2Ref: 'network-ref',
      }),
    );
    const transfer = annotate(
      Payload.transfer({ amount: CcdAmount.fromMicroCcd(1n), toAddress: AccountAddress.fromBase58(recipient) }),
    );

    expect(JSON.stringify(sponsored)).not.toContain('AccountLabel');
    expect(JSON.stringify(transfer)).not.toContain('AccountLabel');
  });

  it('accepts lock creation for any recipient and account transactions without annotatable payloads', () => {
    const lockCreate = {
      [OperationType.LockCreate]: LockConfig.simpleV0(
        'any' as const,
        CborEpoch.fromEpochSeconds(1_800_000_000),
        [],
        [TokenId.fromString('TOK')],
      ),
    };

    expect(annotate(Payload.tokenUpdate(createTokenUpdatePayload({ operations: lockCreate })))).toMatchObject({
      payloadSummary: { operations: [{ lockCreate: { simpleV0: { recipients: 'any' } } }] },
    });
    expect(annotate(Payload.configureDelegation({}))).toMatchObject({
      payloadSummary: { kind: 'configureDelegation' },
    });
  });

  it.each(['scoped', 'unscoped'] as const)(
    'preserves an unknown %s operation as raw wire output without inspecting address-shaped data',
    (scope) => {
      const rawOperation = {
        futureOp: {
          participant: { address: recipient, coinInfo: 919 },
          memo: { nested: { address: sender, coinInfo: 919 } },
        },
      };
      const operations = Cbor.encode([rawOperation]);
      const payload =
        scope === 'scoped'
          ? Payload.tokenUpdate({ variant: 'scoped', tokenId: TokenId.fromString('TOK'), operations })
          : Payload.tokenUpdate({ variant: 'unscoped', operations });

      const projected = annotate(payload);
      expect(projected).toMatchObject({ payloadSummary: { operations: [rawOperation] } });
      expect(JSON.stringify(projected)).not.toContain('"coinInfo":919,"accountLabel"');
    },
  );

  it('preserves supported metadata fields in terminal MCP projection', () => {
    const metadata = {
      url: 'https://example.com/token.json',
      checksumSha256: Uint8Array.from({ length: 32 }, () => 0xaa),
    };
    const payload = Payload.tokenUpdate(
      createTokenUpdatePayload({
        tokenId: TokenId.fromString('TOK'),
        operations: { [TokenOperationType.UpdateMetadata]: metadata },
      }),
    );

    expect(annotate(payload)).toMatchObject({
      payloadSummary: {
        operations: [
          {
            updateMetadata: {
              url: 'https://example.com/token.json',
              checksumSha256: 'aa'.repeat(32),
            },
          },
        ],
      },
    });
  });

  it('leaves non-account transaction families unchanged', () => {
    const parsed = { kind: 'credentialDeployment', expiry: 42 } as const;

    expect(annotateParsedTransactionAccounts(parsed, { caip2Ref: 'network-ref' })).toEqual(parsed);
    expect(loadAccountLabels).not.toHaveBeenCalled();
  });
});
