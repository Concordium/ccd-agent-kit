import {
  AccountAddress,
  AccountTransactionV0,
  AccountTransactionV1,
  type AccountInfo,
} from '@concordium/web-sdk';
import * as ed from '@concordium/web-sdk/shims/ed25519';
import { caip2Reference, ed25519PublicKey, parseUnsignedAccountTransactionHex, type Ed25519PublicKeyHex } from '@ccd-agent-kit/sdk-utils';
import type { AccountCredentialObservation } from '@ccd-agent-kit/config-utils';
import type { ToolResult } from '../../../../src/mcp/toolPlumbing/toolTypes.js';

export const SENDER = '4StnMEQCKtfDRuHJfsY6eZL9KJWqdYoqRVRoDSSAz35LsmHcmg';
export const SPONSOR = '4soVbMFX1vu7evzS4mhLTh1qscPiCgJFztNnHTTKF3yydvKMEm';
export const MAINNET_REF = caip2Reference('ccd:9dd9ca4d19e9393877d2c44b70f89acb');
export const CREDENTIAL_PUBLIC_KEY = ed25519PublicKey.require('e734ea6c2b6257de72355e472aa05a4c487e6b463c029ed306df2f01b5636b58');
export const MESSAGE_EXPIRY_HEX = '000000006ab6a117';
export const SYNTHETIC_CREDENTIAL_VALUES = [
  '01',
  '00',
  '00',
  CREDENTIAL_PUBLIC_KEY,
  '01',
  'aa'.repeat(48),
  '00000000',
  '01',
  '0000',
  '07eb09',
  '07ea09',
  '0000',
].join('');
export const CREDENTIAL_HANDOFF_HEX = `00${MESSAGE_EXPIRY_HEX}${SYNTHETIC_CREDENTIAL_VALUES}${[
  'bb'.repeat(96),
  'cc'.repeat(64),
  'dd'.repeat(740),
].join('')}`;

export function accountInfo(
  address: string,
  verifyKey: string,
): Pick<AccountInfo, 'accountAddress' | 'accountThreshold' | 'accountCredentials'> {
  return {
    accountAddress: AccountAddress.fromBase58(address),
    accountThreshold: 1,
    accountCredentials: {
      0: {
        v: 0,
        value: {
          type: 'normal',
          contents: {
            credentialPublicKeys: {
              threshold: 1,
              keys: { 0: { schemeId: 'Ed25519', verifyKey } },
            },
          },
        },
      },
    } as unknown as Pick<AccountInfo, 'accountCredentials'>['accountCredentials'],
  };
}

export function accountObservation(
  verifyKey: Ed25519PublicKeyHex,
  options: { accountThreshold?: string; credentialThreshold?: string; key1?: Ed25519PublicKeyHex } = {},
): AccountCredentialObservation {
  return {
    accountThreshold: options.accountThreshold ?? '1',
    credentials: {
      '0': {
        threshold: options.credentialThreshold ?? '1',
        keys: {
          '0': { publicKey: verifyKey, scheme: 'Ed25519' },
          ...(options.key1 !== undefined ? { '1': { publicKey: options.key1, scheme: 'Ed25519' as const } } : {}),
        },
      },
    },
    sourceBlock: { hash: '11'.repeat(32), height: '123', time: '2026-09-24T00:00:00.000Z' },
  };
}

export async function keyPair(seedByte: string): Promise<{ signKey: string; verifyKey: Ed25519PublicKeyHex }> {
  const signKey = seedByte.repeat(64);
  const verifyKey = Buffer.from(await ed.getPublicKeyAsync(Uint8Array.from(Buffer.from(signKey, 'hex')))).toString(
    'hex',
  );
  return { signKey, verifyKey: ed25519PublicKey.require(verifyKey) };
}

export function parseV0Unsigned(transactionHex: string): AccountTransactionV0.Unsigned {
  const parsed = parseUnsignedAccountTransactionHex(transactionHex);
  if (parsed.version !== 0) throw new Error('Expected a V0 account transaction fixture.');
  return parsed.transaction;
}

export function parseV1Unsigned(transactionHex: string): AccountTransactionV1.Unsigned {
  const parsed = parseUnsignedAccountTransactionHex(transactionHex);
  if (parsed.version !== 1) throw new Error('Expected a V1 account transaction fixture.');
  return parsed.transaction;
}

export function textOf(result: ToolResult): string {
  const block = result.content[0];
  return block?.type === 'text' ? block.text : '';
}
