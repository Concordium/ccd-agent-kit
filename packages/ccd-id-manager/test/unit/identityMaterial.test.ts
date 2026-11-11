import { AttributesKeys,ConcordiumHdWallet } from '@concordium/web-sdk';
import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
import {
IdentityMaterialError,
deriveAttributeRandomness,
deriveCredentialRegistrationId,
deriveIdentityMaterial,
} from '../../src/core/identityMaterial.js';
import { PRIVATE_DIAGNOSTIC,expectSanitized } from '../helpers.js';
import { ON_CHAIN_COMMITMENT_KEY } from '../workflowFixtures.js';

const seedBytes = () => Uint8Array.from({ length: 64 }, (_, i) => i);
const input = () => ({ seed: seedBytes(), network: 'Mainnet' as const, identityProviderIndex: 0, identityIndex: 0 });
const openingInput = () => ({ ...input(), credentialIndex: 2, attribute: AttributesKeys.firstName });
type MaterialInput = Parameters<typeof deriveIdentityMaterial>[0];
type OpeningInput = Parameters<typeof deriveAttributeRandomness>[0];
type CredentialIdInput = Parameters<typeof deriveCredentialRegistrationId>[0];

function walletExpected(args: MaterialInput) {
  const wallet = ConcordiumHdWallet.fromHex(Buffer.from(args.seed).toString('hex'), args.network);
  return {
    idCredSec: Buffer.from(wallet.getIdCredSec(args.identityProviderIndex, args.identityIndex)),
    prfKey: Buffer.from(wallet.getPrfKey(args.identityProviderIndex, args.identityIndex)),
    signatureBlindingRandomness: Buffer.from(
      wallet.getSignatureBlindingRandomness(args.identityProviderIndex, args.identityIndex),
    ),
  };
}

function openingExpected(args: OpeningInput) {
  const wallet = ConcordiumHdWallet.fromHex(Buffer.from(args.seed).toString('hex'), args.network);
  return Buffer.from(
    wallet.getAttributeCommitmentRandomness(
      args.identityProviderIndex,
      args.identityIndex,
      args.credentialIndex,
      args.attribute,
    ),
  );
}

function expectMaterialError(run: () => unknown, code: string) {
  let failure: unknown;
  try {
    run();
  } catch (error) {
    failure = error;
  }
  expectSanitized(failure, IdentityMaterialError, code);
}

describe('identity-only SDK orchestration', () => {
  beforeEach(() => {
    // Real SDK implementations remain active; these spies enforce the ownership boundary.
    vi.spyOn(ConcordiumHdWallet.prototype, 'getAccountSigningKey');
    vi.spyOn(ConcordiumHdWallet.prototype, 'getAccountPublicKey');
    vi.spyOn(ConcordiumHdWallet.prototype, 'getVerifiableCredentialSigningKey');
  });

  afterEach(() => {
    expect(ConcordiumHdWallet.prototype.getAccountSigningKey).not.toHaveBeenCalled();
    expect(ConcordiumHdWallet.prototype.getAccountPublicKey).not.toHaveBeenCalled();
    expect(ConcordiumHdWallet.prototype.getVerifiableCredentialSigningKey).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it.each([
    {
      network: 'Mainnet' as const, identityProviderIndex: 0, identityIndex: 0, credentialIndex: 0,
      credentialId: 'a7de4f804513ff2882ca5bab3d7be96938b036785fe5aabb340361badc4c7b80af8a1256469da538b16c5caaf41cab5b',
    },
    {
      network: 'Testnet' as const, identityProviderIndex: 3, identityIndex: 7, credentialIndex: 2,
      credentialId: '8fcebec3708b806a3e25134460d689d2164e3b8437fbb8ff49d86134b27c12d42bb79af151258859e08466a2839dd5ee',
    },
  ])('derives pinned SDK registration-id vector for $network credential $credentialIndex', (vector) => {
    const getCredentialId = vi.spyOn(ConcordiumHdWallet.prototype, 'getCredentialId');
    const args = {
      seed: seedBytes(), network: vector.network,
      identityProviderIndex: vector.identityProviderIndex, identityIndex: vector.identityIndex,
      credentialIndex: vector.credentialIndex, onChainCommitmentKey: ON_CHAIN_COMMITMENT_KEY,
    };

    expect(deriveCredentialRegistrationId(args)).toBe(vector.credentialId);
    expect(getCredentialId).toHaveBeenCalledExactlyOnceWith(
      vector.identityProviderIndex, vector.identityIndex, vector.credentialIndex,
      { onChainCommitmentKey: ON_CHAIN_COMMITMENT_KEY },
    );
    expect(args.seed).toEqual(seedBytes());
  });

  it.each([
    ['credentialIndex', -1, 'INVALID_INDEX'],
    ['credentialIndex', 256, 'INVALID_INDEX'],
    ['onChainCommitmentKey', 'not-hex', 'DERIVATION_FAILED'],
    ['onChainCommitmentKey', '11'.repeat(96), 'DERIVATION_FAILED'],
  ])('rejects credential-id %s=%s without deriving account keys', (field, value, code) => {
    const args = {
      ...input(), credentialIndex: 0, onChainCommitmentKey: ON_CHAIN_COMMITMENT_KEY, [field]: value,
    } as CredentialIdInput;
    expectMaterialError(() => deriveCredentialRegistrationId(args), code);
  });

  it.each([
    {
      network: 'Mainnet' as const,
      identityProviderIndex: 0,
      identityIndex: 0,
      idCredSec: '2998b614d67d5a18535a310c433b6ae2b8167e147dc52d677870576e02f35a42',
      prfKey: '1c5e9d52625632e4532411792081d4671d5bfae72a088dec9929a310f3f2365d',
      signatureBlindingRandomness: '6e1f896fba255f9f1d2ebc46ebe401a39e564e87d00d6458d58ba4e0be61c4e9',
      opening: '2f9bec3dca0dcb182c76ff5357f8e7e926955e6c4b4fa0337e2f7e24b6dfe8f9',
    },
    {
      network: 'Testnet' as const,
      identityProviderIndex: 3,
      identityIndex: 7,
      idCredSec: '462906c73df23ae26e61c07eafbdbd7966512170c764ed2584dd05d961bccda9',
      prfKey: '5f8aaedd9aaecc5ae5828e56025a8e7e41854f49d80d06cf6d01ebf1fcfdcccc',
      signatureBlindingRandomness: '431104719ce91b6611a369c3797ac288ac555342293b8239c494c368aa78ce74',
      opening: '3990280e3ffe45ae60f8b108ce53dcbc70b4c8548f62581bb66803775322d674',
    },
  ])('matches pinned SDK vectors for $network IDP $identityProviderIndex identity $identityIndex', (vector) => {
    const args = {
      seed: seedBytes(),
      network: vector.network,
      identityProviderIndex: vector.identityProviderIndex,
      identityIndex: vector.identityIndex,
    };
    const originalSeed = args.seed.slice();
    const expected = walletExpected(args);
    const material = deriveIdentityMaterial(args);
    expect(material).toEqual(expected);
    expect(Object.keys(material).sort()).toEqual(['idCredSec', 'prfKey', 'signatureBlindingRandomness']);
    for (const key of ['idCredSec', 'prfKey', 'signatureBlindingRandomness'] as const) {
      expect(Buffer.isBuffer(material[key])).toBe(true);
      expect(material[key].toString('hex')).toBe(vector[key]);
    }
    const openingArgs = { ...args, credentialIndex: 2, attribute: AttributesKeys.firstName };
    const opening = deriveAttributeRandomness(openingArgs);
    expect(Buffer.isBuffer(opening)).toBe(true);
    expect(opening).toEqual(openingExpected(openingArgs));
    expect(opening.toString('hex')).toBe(vector.opening);
    expect(args.seed).toEqual(originalSeed);
  });

  it.each([{ network: 'Testnet' as const }, { identityProviderIndex: 1 }, { identityIndex: 1 }])(
    'separates identity material by network, IDP and identity (%j)',
    (change) => {
      const base = input();
      const changed = { ...base, ...change };
      const first = deriveIdentityMaterial(base);
      const next = deriveIdentityMaterial(changed);
      expect(next).toEqual(walletExpected(changed));
      for (const key of ['idCredSec', 'prfKey', 'signatureBlindingRandomness'] as const) {
        expect(next[key]).not.toEqual(first[key]);
      }
      const baseOpening = { ...openingInput(), ...base };
      const nextOpening = { ...baseOpening, ...change };
      expect(deriveAttributeRandomness(nextOpening)).toEqual(openingExpected(nextOpening));
      expect(deriveAttributeRandomness(nextOpening)).not.toEqual(deriveAttributeRandomness(baseOpening));
    },
  );

  it('reproduces openings and separates credential and attribute selections', () => {
    const args = openingInput();
    const first = deriveAttributeRandomness(args);
    expect(deriveAttributeRandomness(args)).toEqual(first);
    for (const change of [{ credentialIndex: 3 }, { attribute: AttributesKeys.lastName }]) {
      const changed = { ...args, ...change };
      const opening = deriveAttributeRandomness(changed);
      expect(opening).toEqual(openingExpected(changed));
      expect(opening).not.toEqual(first);
    }
  });

  it('accepts conservative boundary indexes and the final enum member', () => {
    const args = { ...input(), identityProviderIndex: 0x7fffffff, identityIndex: 0x7fffffff };
    expect(deriveIdentityMaterial(args)).toEqual(walletExpected(args));
    for (const credentialIndex of [0, 255]) {
      const opening = { ...args, credentialIndex, attribute: 17 as AttributesKeys };
      expect(deriveAttributeRandomness(opening)).toEqual(openingExpected(opening));
    }
  });

  it('returns caller-owned buffers without mutating or retaining mutable seed input', () => {
    const args = input();
    const original = args.seed.slice();
    const first = deriveIdentityMaterial(args);
    const second = deriveIdentityMaterial(args);
    const openingArgs = { ...args, credentialIndex: 2, attribute: AttributesKeys.firstName };
    const firstOpening = deriveAttributeRandomness(openingArgs);
    const secondOpening = deriveAttributeRandomness(openingArgs);
    expect(args.seed).toEqual(original);
    const snapshot = {
      idCredSec: Buffer.from(second.idCredSec),
      prfKey: Buffer.from(second.prfKey),
      signatureBlindingRandomness: Buffer.from(second.signatureBlindingRandomness),
    };
    for (const key of ['idCredSec', 'prfKey', 'signatureBlindingRandomness'] as const) first[key].fill(0);
    firstOpening.fill(0);
    expect(second).toEqual(snapshot);
    expect(secondOpening).toEqual(openingExpected(openingArgs));
    args.seed.fill(255);
    expect(second).toEqual(snapshot);
    expect(secondOpening).toEqual(openingExpected({ ...openingArgs, seed: original }));
    expect(deriveIdentityMaterial({ ...args, seed: original })).toEqual(snapshot);
  });

  const invalidInputs: [string, unknown, string][] = [
    ['seed', undefined, 'INVALID_SEED'],
    ['seed', 'deadbeef', 'INVALID_SEED'],
    ['seed', Array(64).fill(1), 'INVALID_SEED'],
    ['seed', new Uint8Array(63), 'INVALID_SEED'],
    ['seed', new Uint8Array(65), 'INVALID_SEED'],
    ['network', 'mainnet', 'INVALID_NETWORK'],
    ['network', 'testnet', 'INVALID_NETWORK'],
    ['network', 'Devnet', 'INVALID_NETWORK'],
    ['network', undefined, 'INVALID_NETWORK'],
    ['network', 0, 'INVALID_NETWORK'],
  ];
  for (const field of ['identityProviderIndex', 'identityIndex']) {
    for (const value of [-1, 0x80000000, 0.5, NaN, Infinity, '1', null]) {
      invalidInputs.push([field, value, 'INVALID_INDEX']);
    }
  }

  it.each(invalidInputs)('guards %s=%s before constructing an SDK wallet', (field, value, code) => {
    const fromHex = vi.spyOn(ConcordiumHdWallet, 'fromHex');
    const args = { ...input(), [field]: value } as MaterialInput;
    const before = args.seed instanceof Uint8Array ? args.seed.slice() : args.seed;
    expectMaterialError(() => deriveIdentityMaterial(args), code);
    expectMaterialError(
      () => deriveAttributeRandomness({ ...args, credentialIndex: 2, attribute: AttributesKeys.firstName }),
      code,
    );
    expect(fromHex).not.toHaveBeenCalled();
    expect(args.seed).toEqual(before);
  });

  it.each([
    ['credentialIndex', -1, 'INVALID_INDEX'],
    ['credentialIndex', 256, 'INVALID_INDEX'],
    ['credentialIndex', 0.5, 'INVALID_INDEX'],
    ['credentialIndex', NaN, 'INVALID_INDEX'],
    ['credentialIndex', Infinity, 'INVALID_INDEX'],
    ['credentialIndex', '2', 'INVALID_INDEX'],
    ['credentialIndex', undefined, 'INVALID_INDEX'],
    ['attribute', -1, 'INVALID_ATTRIBUTE'],
    ['attribute', 18, 'INVALID_ATTRIBUTE'],
    ['attribute', 0.5, 'INVALID_ATTRIBUTE'],
    ['attribute', NaN, 'INVALID_ATTRIBUTE'],
    ['attribute', Infinity, 'INVALID_ATTRIBUTE'],
    ['attribute', 'firstName', 'INVALID_ATTRIBUTE'],
    ['attribute', '0', 'INVALID_ATTRIBUTE'],
    ['attribute', undefined, 'INVALID_ATTRIBUTE'],
  ])('guards opening %s=%s before invoking the SDK', (field, value, code) => {
    const fromHex = vi.spyOn(ConcordiumHdWallet, 'fromHex');
    const args = { ...openingInput(), [field as string]: value } as OpeningInput;
    expectMaterialError(() => deriveAttributeRandomness(args), code as string);
    expect(fromHex).not.toHaveBeenCalled();
    expect(args.seed).toEqual(seedBytes());
  });

  it.each([new Error(PRIVATE_DIAGNOSTIC), PRIVATE_DIAGNOSTIC, { detail: PRIVATE_DIAGNOSTIC }])(
    'sanitizes SDK constructor failures (%s)',
    (failure) => {
      vi.spyOn(ConcordiumHdWallet, 'fromHex').mockImplementation(() => {
        throw failure;
      });
      const args = input();
      expectMaterialError(() => deriveIdentityMaterial(args), 'DERIVATION_FAILED');
      expectMaterialError(() => deriveAttributeRandomness({ ...openingInput(), seed: args.seed }), 'DERIVATION_FAILED');
      expect(args.seed).toEqual(seedBytes());
    },
  );

  it.each(['getIdCredSec', 'getPrfKey', 'getSignatureBlindingRandomness', 'getAttributeCommitmentRandomness'] as const)(
    'sanitizes failures during %s without returning partial material',
    (method) => {
      vi.spyOn(ConcordiumHdWallet.prototype, method).mockImplementation(() => {
        throw new Error(PRIVATE_DIAGNOSTIC);
      });
      const args = input();
      const run =
        method === 'getAttributeCommitmentRandomness'
          ? () => deriveAttributeRandomness({ ...openingInput(), seed: args.seed })
          : () => deriveIdentityMaterial(args);
      expectMaterialError(run, 'DERIVATION_FAILED');
      expect(args.seed).toEqual(seedBytes());
    },
  );

  it('clears SDK-owned secret buffers and already-copied outputs if a later derivation fails', () => {
    const source = ConcordiumHdWallet.fromHex(Buffer.from(seedBytes()).toString('hex'), 'Mainnet').getIdCredSec(0, 0);
    vi.spyOn(ConcordiumHdWallet.prototype, 'getIdCredSec').mockReturnValue(source);
    const copiedOutputs: Buffer[] = [];
    const originalFrom = Buffer.from;
    const from = vi.spyOn(Buffer, 'from');
    from.mockImplementation(((...args: unknown[]) => {
      const copy = Reflect.apply(originalFrom, Buffer, args) as Buffer;
      if (args[0] === source) copiedOutputs.push(copy);
      return copy;
    }) as typeof Buffer.from);
    vi.spyOn(ConcordiumHdWallet.prototype, 'getPrfKey').mockImplementation(() => {
      throw new Error(PRIVATE_DIAGNOSTIC);
    });
    expectMaterialError(() => deriveIdentityMaterial(input()), 'DERIVATION_FAILED');
    expect(Array.from(source)).toEqual(Array(32).fill(0));
    expect(copiedOutputs).toHaveLength(1);
    for (const output of copiedOutputs) expect(output).toEqual(Buffer.alloc(32));
  });
});
