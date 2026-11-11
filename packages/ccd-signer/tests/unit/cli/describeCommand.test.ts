import { Payload, TokenId, TokenOperationType, createTokenUpdatePayload } from '@concordium/web-sdk';
import { describe, expect, it } from 'vitest';

import { CliUsageError, createDescribeCommandRequest, runDescribeCommand } from '../../../src/cli/describeCommand.js';
import { transactionFixtures } from '../../helpers/transactionFixtures.js';
import { unsignedHexForPayload } from '../../helpers/unsignedAccountTransaction.js';

describe('createDescribeCommandRequest', () => {
  it('parses direct input with autodetected format', () => {
    expect(createDescribeCommandRequest({ input: transactionFixtures.v0HexString })).toEqual({
      output: 'json',
      source: { kind: 'input', value: transactionFixtures.v0HexString },
    });
  });

  it('rejects conflicting input sources', () => {
    expect(() => {
      createDescribeCommandRequest({ input: 'abc', stdin: true });
    }).toThrowError(CliUsageError);
  });

  it('rejects a missing input source', () => {
    expect(() => {
      createDescribeCommandRequest({});
    }).toThrowError(CliUsageError);
  });

  it('preserves supported metadata fields in terminal JSON output', async () => {
    const metadata = {
      url: 'https://example.com/token.json',
      checksumSha256: Uint8Array.from({ length: 32 }, () => 0xaa),
    };
    const transactionHex = unsignedHexForPayload(
      Payload.tokenUpdate(
        createTokenUpdatePayload({
          tokenId: TokenId.fromString('TOK'),
          operations: { [TokenOperationType.UpdateMetadata]: metadata },
        }),
      ),
      0,
    );
    const stdout: string[] = [];

    await expect(
      runDescribeCommand({
        request: { source: { kind: 'input', value: transactionHex }, output: 'json' },
        stdout,
        stderr: [],
      }),
    ).resolves.toBe(0);
    expect(JSON.parse(stdout[0]!)).toMatchObject({
      payloadSummary: {
        operations: [
          {
            updateMetadata: {
              checksumSha256: 'aa'.repeat(32),
            },
          },
        ],
      },
    });
  });
});
