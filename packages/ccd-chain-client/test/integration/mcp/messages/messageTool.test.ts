import { AccountAddress, buildBasicAccountSigner, signMessage, type AccountInfo } from '@concordium/web-sdk';
import * as ed from '@concordium/web-sdk/shims/ed25519';
import { caip2Reference, ed25519PublicKey } from '@ccd-agent-kit/sdk-utils';
import {
  getAccountCredentialObservation,
  setAccountCredentialObservation,
  type AccountCredentialObservation,
} from '@ccd-agent-kit/config-utils';
import { rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { verifyMessage } from '../../../../src/mcp/messages/handlers.js';
import { FakeConcordiumClient, makeContext } from '../../../helpers/fakes.js';
import { makeTestTempDir } from '../../../helpers/tempDir.js';

const ADDRESS = '4StnMEQCKtfDRuHJfsY6eZL9KJWqdYoqRVRoDSSAz35LsmHcmg';
const TEST_NETWORK = 'mainnet';
const TEST_NETWORK_REF = caip2Reference('ccd:9dd9ca4d19e9393877d2c44b70f89acb');

function accountInfo(
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

async function keyPair(seedByte: string) {
  const signKey = seedByte.repeat(64);
  const verifyKey = Buffer.from(await ed.getPublicKeyAsync(Uint8Array.from(Buffer.from(signKey, 'hex')))).toString(
    'hex',
  );
  return { signKey, verifyKey };
}

function accountObservation(verifyKey: string): AccountCredentialObservation {
  return {
    accountThreshold: '1',
    credentials: {
      '0': { threshold: '1', keys: { '0': { publicKey: ed25519PublicKey.require(verifyKey), scheme: 'Ed25519' } } },
    },
    sourceBlock: { hash: '11'.repeat(32), height: '123', time: '2026-09-24T00:00:00.000Z' },
  };
}

describe('verifyMessage', () => {
  let stateHome: string;
  let previousStateHome: string | undefined;

  beforeEach(() => {
    previousStateHome = process.env.XDG_STATE_HOME;
    stateHome = makeTestTempDir('verify-message-');
    process.env.XDG_STATE_HOME = stateHome;
  });

  afterEach(() => {
    if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previousStateHome;
    rmSync(stateHome, { recursive: true, force: true });
  });

  it('verifies text message signatures against chain account keys', async () => {
    const keys = await keyPair('8');
    const signature = await signMessage(
      AccountAddress.fromBase58(ADDRESS),
      'hello',
      buildBasicAccountSigner(keys.signKey),
    );
    const ctx = makeContext(
      new FakeConcordiumClient({
        accountVerificationInfos: { [ADDRESS]: accountInfo(ADDRESS, keys.verifyKey) },
      }),
      { network: TEST_NETWORK },
    );

    await expect(
      verifyMessage(ctx, {
        address: ADDRESS,
        messageText: 'hello',
        signature,
        network: TEST_NETWORK,
      }),
    ).resolves.toEqual({
      valid: true,
      network: TEST_NETWORK,
      address: ADDRESS,
      inputFormat: 'text',
    });
  });

  it('uses a complete cached observation without querying account verification info', async () => {
    const keys = await keyPair('c');
    setAccountCredentialObservation(ADDRESS, accountObservation(keys.verifyKey), TEST_NETWORK_REF);
    const signature = await signMessage(
      AccountAddress.fromBase58(ADDRESS),
      'hello',
      buildBasicAccountSigner(keys.signKey),
    );
    const client = new FakeConcordiumClient();

    await expect(
      verifyMessage(makeContext(client, { network: TEST_NETWORK }), {
        address: ADDRESS,
        messageText: 'hello',
        signature,
        network: TEST_NETWORK,
      }),
    ).resolves.toMatchObject({ valid: true, address: ADDRESS });
    expect(client.calls.getAccountVerificationInfo ?? 0).toBe(0);
  });

  it('refreshes once before treating a cached message verification failure as invalid', async () => {
    const staleKeys = await keyPair('d');
    const freshKeys = await keyPair('e');
    setAccountCredentialObservation(ADDRESS, accountObservation(staleKeys.verifyKey), TEST_NETWORK_REF);
    const signature = await signMessage(
      AccountAddress.fromBase58(ADDRESS),
      'hello',
      buildBasicAccountSigner(freshKeys.signKey),
    );
    const client = new FakeConcordiumClient({
      accountCredentialObservations: {
        [ADDRESS]: { canonicalAddress: ADDRESS, observation: accountObservation(freshKeys.verifyKey) },
      },
    });

    await expect(
      verifyMessage(makeContext(client, { network: TEST_NETWORK }), {
        address: ADDRESS,
        messageText: 'hello',
        signature,
        network: TEST_NETWORK,
      }),
    ).resolves.toMatchObject({ valid: true });
    expect(client.calls.getFinalizedAccountCredentials).toBe(1);
    expect(getAccountCredentialObservation(ADDRESS, TEST_NETWORK_REF)?.credentials['0']?.keys['0']?.publicKey).toBe(
      freshKeys.verifyKey,
    );
  });

  it('verifies hex message signatures against chain account keys', async () => {
    const keys = await keyPair('9');
    const message = Uint8Array.from(Buffer.from('68656c6c6f', 'hex'));
    const signature = await signMessage(
      AccountAddress.fromBase58(ADDRESS),
      message,
      buildBasicAccountSigner(keys.signKey),
    );
    const ctx = makeContext(
      new FakeConcordiumClient({
        accountVerificationInfos: { [ADDRESS]: accountInfo(ADDRESS, keys.verifyKey) },
      }),
      { network: TEST_NETWORK },
    );

    await expect(
      verifyMessage(ctx, {
        address: ADDRESS,
        messageHex: '68656c6c6f',
        signature,
        network: TEST_NETWORK,
      }),
    ).resolves.toMatchObject({
      valid: true,
      address: ADDRESS,
      inputFormat: 'hex',
    });
  });

  it('returns invalid for a mismatched message', async () => {
    const keys = await keyPair('a');
    const signature = await signMessage(
      AccountAddress.fromBase58(ADDRESS),
      'hello',
      buildBasicAccountSigner(keys.signKey),
    );
    const ctx = makeContext(
      new FakeConcordiumClient({
        accountVerificationInfos: { [ADDRESS]: accountInfo(ADDRESS, keys.verifyKey) },
      }),
      { network: TEST_NETWORK },
    );

    await expect(
      verifyMessage(ctx, {
        address: ADDRESS,
        messageText: 'goodbye',
        signature,
        network: TEST_NETWORK,
      }),
    ).resolves.toMatchObject({ valid: false });
  });
});
