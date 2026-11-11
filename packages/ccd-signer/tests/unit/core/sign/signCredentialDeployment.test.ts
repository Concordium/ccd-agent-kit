import { createHash } from 'node:crypto';
import * as ed from '@concordium/web-sdk/shims/ed25519';

import { describe, expect, it } from 'vitest';
import {
  CredentialDeploymentSigningError,
  signCredentialDeployment,
  type CredentialDeploymentSigningBackend,
} from '../../../../src/core/sign/signCredentialDeployment.js';
import { transactionFixtures } from '../../../helpers/transactionFixtures.js';

class FakeCredentialBackend implements CredentialDeploymentSigningBackend {
  public readonly requests: Array<{ publicKey: string; digestHex: string }> = [];

  async signDigest(publicKey: string, digest: Uint8Array): Promise<string> {
    const digestHex = Buffer.from(digest).toString('hex');
    this.requests.push({ digestHex, publicKey });
    return '33'.repeat(64);
  }
}

async function validFixtureSignature(): Promise<string> {
  const handoff = Buffer.from(transactionFixtures.credentialDeploymentSigningNewAccountHex, 'hex');
  const digest = createHash('sha256').update(handoff.subarray(9)).update(handoff.subarray(0, 9)).digest();
  return Buffer.from(await ed.signAsync(digest, Uint8Array.from(Buffer.from('aa'.repeat(32), 'hex')))).toString('hex');
}

describe('signCredentialDeployment', () => {
  it('signs sha256(unsignedCredentialDeployment || targetContext)', async () => {
    const backend = new FakeCredentialBackend();
    const result = await signCredentialDeployment({
      backend,
      keys: ['0'],
      credDeploymentHex: transactionFixtures.credentialDeploymentSigningNewAccountHex,
    });
    const expectedDigest = createHash('sha256')
      .update(Buffer.from(transactionFixtures.credentialDeploymentSigningUnsignedHex, 'hex'))
      .update(Buffer.from('00000000006ab6a117', 'hex'))
      .digest('hex');

    expect(result.digestHex).toBe(expectedDigest);
    expect(backend.requests).toEqual([
      {
        digestHex: expectedDigest,
        publicKey: transactionFixtures.credentialDeploymentSigningPublicKey,
      },
    ]);
    expect(result.newSignatures).toEqual({ '0': '33'.repeat(64) });
    expect(result.signatures).toEqual(result.newSignatures);
    expect(result.isFullySigned).toBe(true);
    expect(result.missingSignatures).toBe(0);
  });

  it('automatically signs only missing credential keys needed for the threshold', async () => {
    const backend = new FakeCredentialBackend();
    const signature = await validFixtureSignature();
    const result = await signCredentialDeployment({
      backend,
      signatures: { '0': signature },
      credDeploymentHex: transactionFixtures.credentialDeploymentSigningNewAccountHex,
    });

    expect(backend.requests).toEqual([]);
    expect(result.newSignatures).toEqual({});
    expect(result.signatures).toEqual({ '0': signature });
    expect(result.isFullySigned).toBe(true);
    expect(result.missingSignatures).toBe(0);
  });

  it('rejects duplicate requested signatures', async () => {
    await expect(
      signCredentialDeployment({
        backend: new FakeCredentialBackend(),
        keys: ['0'],
        signatures: { '0': '22'.repeat(64) },
        credDeploymentHex: transactionFixtures.credentialDeploymentSigningNewAccountHex,
      }),
    ).rejects.toMatchObject({
      code: 'invalid_input',
    } satisfies Partial<CredentialDeploymentSigningError>);
  });

  it.each([
    ['an unknown key index', { '255': '22'.repeat(64) }],
    ['a prototype-name key', JSON.parse(`{"toString":"${'22'.repeat(64)}"}`)],
    ['an invalid signature shape', { '0': '22' }],
  ])('rejects existing signatures with %s before calling the backend', async (_label, signatures) => {
    const backend = new FakeCredentialBackend();

    await expect(signCredentialDeployment({
      backend,
      signatures,
      credDeploymentHex: transactionFixtures.credentialDeploymentSigningNewAccountHex,
    })).rejects.toMatchObject({ code: 'invalid_input' });
    expect(backend.requests).toEqual([]);
  });

  it.each(['9', 'toString'])('rejects unknown credential key index %s', async (keyIndex) => {
    await expect(
      signCredentialDeployment({
        backend: new FakeCredentialBackend(),
        keys: [keyIndex],
        credDeploymentHex: transactionFixtures.credentialDeploymentSigningNewAccountHex,
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('rejects invalid key selection controls before signing', async () => {
    await expect(
      signCredentialDeployment({
        backend: new FakeCredentialBackend(),
        keys: ['0'],
        maxSignatures: 1,
        credDeploymentHex: transactionFixtures.credentialDeploymentSigningNewAccountHex,
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' });

    await expect(
      signCredentialDeployment({
        backend: new FakeCredentialBackend(),
        keys: [],
        credDeploymentHex: transactionFixtures.credentialDeploymentSigningNewAccountHex,
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' });

    await expect(
      signCredentialDeployment({
        backend: new FakeCredentialBackend(),
        maxSignatures: 0,
        credDeploymentHex: transactionFixtures.credentialDeploymentSigningNewAccountHex,
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('rejects non-credential-deployment signing handoffs', async () => {
    await expect(
      signCredentialDeployment({
        backend: new FakeCredentialBackend(),
        credDeploymentHex: transactionFixtures.unsignedConfigureDelegationPoolHex,
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

});
