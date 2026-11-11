import { describe,expect,it,vi } from 'vitest';
import {
IDENTITY_ROOT_DERIVATION_VERSION,
RootDerivationError,
deriveIdentityRoot,
identityRootPeerPublicKey,
validateIdentityRootPublicKey,
type IdentityRootAgreement,
} from '../../src/core/identityRoot.js';
import { PRIVATE_DIAGNOSTIC,expectSanitized } from '../helpers.js';
import {
MAINNET_VECTOR,
PEER_HEX,
ROOT_CONTEXT,
ROOT_PUBLIC_KEY_HEX,
SEED_HEX,
SHARED_SECRET_HEX,
fixedScalarDevice,
independentHkdf,
independentPeer
} from '../identityCryptoFixtures.js';

function agreementFor(secret = Buffer.from(SHARED_SECRET_HEX, 'hex')) {
  const transferred: Buffer[] = [];
  const agree = vi.fn<IdentityRootAgreement['agree']>(async () => {
    transferred.push(secret);
    return { publicKey: Buffer.from(ROOT_PUBLIC_KEY_HEX, 'hex'), sharedSecret: secret };
  });
  return { agree, transferred };
}

function input(agreement: IdentityRootAgreement) {
  return { ...ROOT_CONTEXT, expectedPublicKey: Buffer.from(ROOT_PUBLIC_KEY_HEX, 'hex'), agreement };
}

async function expectRootError(operation: Promise<unknown>, code: string) {
  await expect(operation).rejects.toBeInstanceOf(RootDerivationError);
  await operation.catch((error: unknown) => expectSanitized(error, RootDerivationError, code));
}

describe('context-bound identity root', () => {
  it('pins the v1 protocol and exact RFC 9380 context encoding', () => {
    expect(IDENTITY_ROOT_DERIVATION_VERSION).toBe('piv-p256-hkdf-sha256-v1');
    const peer = identityRootPeerPublicKey(ROOT_CONTEXT);
    expect(Buffer.isBuffer(peer)).toBe(true);
    expect(peer).toHaveLength(65);
    expect(peer.toString('hex')).toBe(PEER_HEX);
    expect(peer).toEqual(independentPeer());
  });

  it('encodes SDK coin types as eight lower-case hex digits', () => {
    expect(identityRootPeerPublicKey({ ...ROOT_CONTEXT, network: 'Mainnet' }).toString('hex'))
      .toBe(MAINNET_VECTOR.peer);
    expect(identityRootPeerPublicKey({ network: 'Mainnet', identityProviderIndex: 10, identityIndex: 11 }).toString('hex'))
      .toBe('04436d3e9d7a0da60595d26e7b08ab371531e30d00d346bb63e200017c78b1c4a003aac682a572293037f07f989319a3bff9baa4c65354871ab7b7c0b32da96f10');
  });

  it('passes the exact context peer to one ECDH operation and applies the independently computed seed HKDF', async () => {
    const device = fixedScalarDevice();
    const transferred: Buffer[] = [];
    const agreement: IdentityRootAgreement = {
      agree: vi.fn(async (peer) => {
        const sharedSecret = device.secret(peer);
        transferred.push(sharedSecret);
        return { publicKey: device.publicKey, sharedSecret };
      }),
    };
    const root = await deriveIdentityRoot(input(agreement));
    expect(agreement.agree).toHaveBeenCalledExactlyOnceWith(Buffer.from(PEER_HEX, 'hex'));
    expect(root).toEqual(
      independentHkdf(Buffer.from(SHARED_SECRET_HEX, 'hex'), 'ccd-id-manager/identity-sdk-seed/v1', 64),
    );
    expect(root.toString('hex')).toBe(SEED_HEX);
    expect(transferred[0]).toEqual(Buffer.alloc(32));
  });


  it.each([
    ['SDK namespace', { network: 'Mainnet' as const }],
    ['IDP index', { identityProviderIndex: 4 }],
    ['identity index', { identityIndex: 8 }],
  ])('separates the peer and seed by %s', async (_label, change) => {
    const context = { ...ROOT_CONTEXT, ...change };
    const peer = identityRootPeerPublicKey(context);
    expect(peer).toEqual(independentPeer(context));
    expect(peer).not.toEqual(Buffer.from(PEER_HEX, 'hex'));
    const device = fixedScalarDevice();
    const agreement = {
      agree: vi.fn(async (requestedPeer: Uint8Array) => ({
        publicKey: device.publicKey,
        sharedSecret: device.secret(requestedPeer),
      })),
    };
    const root = await deriveIdentityRoot({ ...input(agreement), ...context });
    expect(root).toEqual(independentHkdf(device.secret(peer), 'ccd-id-manager/identity-sdk-seed/v1', 64));
    expect(root.toString('hex')).not.toBe(SEED_HEX);
  });


  it('excludes credential number from the peer context', () => {
    const withCredential = { ...ROOT_CONTEXT, credentialNumber: 255 };
    expect(identityRootPeerPublicKey(withCredential)).toEqual(identityRootPeerPublicKey(ROOT_CONTEXT));
  });

  it('returns isolated peer and seed buffers', async () => {
    identityRootPeerPublicKey(ROOT_CONTEXT).fill(0);
    const firstAgreement = agreementFor();
    const secondAgreement = agreementFor();
    const first = await deriveIdentityRoot(input(firstAgreement));
    const second = await deriveIdentityRoot(input(secondAgreement));
    first.fill(0);
    expect(identityRootPeerPublicKey(ROOT_CONTEXT).toString('hex')).toBe(PEER_HEX);
    expect(second.toString('hex')).toBe(SEED_HEX);
  });

  it('validates and copies canonical root public keys', () => {
    const key = Buffer.from(ROOT_PUBLIC_KEY_HEX, 'hex');
    const validated = validateIdentityRootPublicKey(key);
    key.fill(0);
    expect(validated.toString('hex')).toBe(ROOT_PUBLIC_KEY_HEX);
    expect(() => validateIdentityRootPublicKey(key)).toThrow(RootDerivationError);
  });

  it.each([
    ['unknown network', 'Devnet', 3, 7],
    ['lower-case network', 'testnet', 3, 7],
    ['missing network', undefined, 3, 7],
    ['negative IDP', 'Testnet', -1, 7],
    ['fractional identity', 'Testnet', 3, 7.5],
    ['oversized identity', 'Testnet', 3, 0x80000000],
  ])('rejects invalid context (%s) before agreement', async (_label, network, identityProviderIndex, identityIndex) => {
    const agreement = agreementFor();
    await expectRootError(
      deriveIdentityRoot({ ...input(agreement), network, identityProviderIndex, identityIndex } as never),
      'INVALID_CONTEXT',
    );
    expect(agreement.agree).not.toHaveBeenCalled();
  });

  it('pins the expected key before awaiting agreement', async () => {
    const expectedPublicKey = Buffer.from(ROOT_PUBLIC_KEY_HEX, 'hex');
    const agreement = agreementFor();
    agreement.agree.mockImplementation(async () => {
      expectedPublicKey.fill(0);
      await Promise.resolve();
      const sharedSecret = Buffer.from(SHARED_SECRET_HEX, 'hex');
      return { publicKey: Buffer.from(ROOT_PUBLIC_KEY_HEX, 'hex'), sharedSecret };
    });
    await expect(deriveIdentityRoot({ ...ROOT_CONTEXT, expectedPublicKey, agreement })).resolves.toHaveLength(64);
  });

  it('rejects a mismatched operation-bound public key and clears its secret', async () => {
    const secret = Buffer.alloc(32, 7);
    const agreement = agreementFor(secret);
    agreement.agree.mockResolvedValue({ publicKey: fixedScalarDevice(2).publicKey, sharedSecret: secret });
    await expectRootError(deriveIdentityRoot(input(agreement)), 'ROOT_KEY_MISMATCH');
    expect(secret).toEqual(Buffer.alloc(32));
  });

  it.each([new Error(PRIVATE_DIAGNOSTIC), PRIVATE_DIAGNOSTIC, { detail: PRIVATE_DIAGNOSTIC }])(
    'sanitizes agreement failures (%s)',
    async (failure) => {
      const agreement = { agree: vi.fn(async () => { throw failure; }) };
      await expectRootError(deriveIdentityRoot(input(agreement)), 'AGREEMENT_FAILED');
    },
  );
});
