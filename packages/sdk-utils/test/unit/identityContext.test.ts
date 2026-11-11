import { describe, expect, it } from 'vitest';

import { parseIdentityContextSnapshot, type IdentityContextSnapshot } from '../../src/index.js';

const GENESIS = '12'.repeat(32);
const CAIP2 = `ccd:${GENESIS.slice(0, 32)}`;

function snapshot(): IdentityContextSnapshot {
  return {
    version: 1,
    network: { caip2: CAIP2, genesisHash: GENESIS },
    sourceBlock: {
      hash: 'ab'.repeat(32),
      height: '123',
      time: '2026-10-16T11:59:59.000Z',
    },
    observedAt: '2026-10-16T12:00:00.000Z',
    globalContext: {
      onChainCommitmentKey: '66'.repeat(48),
      bulletproofGenerators: '77'.repeat(64),
      genesisString: 'local-testnet-genesis',
    },
    identityProviders: [
      {
        ipIdentity: 0,
        ipDescription: { name: 'Zero ID', url: 'https://zero.example.test', description: 'Provider zero' },
        ipVerifyKey: '22'.repeat(32),
        ipCdiVerifyKey: '33'.repeat(96),
      },
      {
        ipIdentity: 2_147_483_647,
        ipDescription: { name: 'Last ID', url: 'https://last.example.test/path', description: '' },
        ipVerifyKey: '23'.repeat(32),
        ipCdiVerifyKey: '34'.repeat(96),
      },
    ],
    anonymityRevokers: [
      {
        arIdentity: 1,
        arDescription: { name: 'AR one', url: 'https://ar1.example.test', description: '' },
        arPublicKey: '44'.repeat(96),
      },
    ],
  };
}

function changed(mutator: (value: Record<string, any>) => void): unknown {
  const value = structuredClone(snapshot()) as unknown as Record<string, any>;
  mutator(value);
  return value;
}

describe('parseIdentityContextSnapshot', () => {
  it('accepts the complete SDK JSON shape and returns a detached copy', () => {
    const input = snapshot();
    const parsed = parseIdentityContextSnapshot(input);

    expect(parsed).toEqual(input);
    expect(parsed).not.toBe(input);
    expect(parsed.globalContext).not.toBe(input.globalContext);
    expect(parsed.identityProviders[0]).not.toBe(input.identityProviders[0]);

    input.globalContext.genesisString = 'mutated';
    input.identityProviders[0]!.ipDescription.name = 'mutated';
    expect(parsed.globalContext.genesisString).toBe('local-testnet-genesis');
    expect(parsed.identityProviders[0]!.ipDescription.name).toBe('Zero ID');
  });

  it('preserves empty SDK description fields', () => {
    const input = snapshot();
    input.identityProviders[0]!.ipDescription.name = '';
    input.identityProviders[0]!.ipDescription.url = '';
    input.identityProviders[0]!.ipDescription.description = '';
    input.anonymityRevokers[0]!.arDescription = { name: '', url: '', description: '' };

    expect(parseIdentityContextSnapshot(input).identityProviders[0]!.ipDescription).toEqual({
      name: '',
      url: '',
      description: '',
    });
    expect(parseIdentityContextSnapshot(input).anonymityRevokers[0]!.arDescription).toEqual({
      name: '', url: '', description: '',
    });
  });

  it.each([
    ['a non-object', null],
    ['an unsupported version', changed((value) => (value.version = 2))],
    ['an extra root property', changed((value) => (value.extra = true))],
    ['an extra nested property', changed((value) => (value.network.extra = true))],
    ['an extra source-block property', changed((value) => (value.sourceBlock.extra = true))],
    ['an extra global-context property', changed((value) => (value.globalContext.extra = true))],
    ['an extra provider property', changed((value) => (value.identityProviders[0].extra = true))],
    ['an extra provider-description property', changed((value) => (value.identityProviders[0].ipDescription.extra = true))],
    ['an extra revoker property', changed((value) => (value.anonymityRevokers[0].extra = true))],
    ['an extra revoker-description property', changed((value) => (value.anonymityRevokers[0].arDescription.extra = true))],
    ['a malformed CAIP-2 identifier', changed((value) => (value.network.caip2 = 'ccd:12'))],
    ['a malformed genesis hash', changed((value) => (value.network.genesisHash = '12'.repeat(31)))],
    ['a CAIP-2/genesis mismatch', changed((value) => (value.network.genesisHash = '34'.repeat(32)))],
    ['a malformed source block hash', changed((value) => (value.sourceBlock.hash = 'not-hex'))],
    ['a non-canonical height', changed((value) => (value.sourceBlock.height = '001'))],
    ['a negative height', changed((value) => (value.sourceBlock.height = '-1'))],
    ['a malformed source time', changed((value) => (value.sourceBlock.time = 'yesterday'))],
    ['a non-canonical source time', changed((value) => (value.sourceBlock.time = '2026-10-16T11:59:59Z'))],
    ['a malformed observation time', changed((value) => (value.observedAt = 'invalid'))],
    ['an incomplete global context', changed((value) => delete value.globalContext.genesisString)],
    ['a non-hex global key', changed((value) => (value.globalContext.onChainCommitmentKey = 'not-hex'))],
    ['a blank genesis string', changed((value) => (value.globalContext.genesisString = ''))],
    ['a non-array provider collection', changed((value) => (value.identityProviders = {}))],
    ['a non-string provider URL', changed((value) => (value.identityProviders[0].ipDescription.url = 123))],
    ['an incomplete provider', changed((value) => delete value.identityProviders[0].ipCdiVerifyKey)],
    ['a non-hex provider key', changed((value) => (value.identityProviders[0].ipVerifyKey = 'zz'))],
    ['a non-array revoker collection', changed((value) => (value.anonymityRevokers = {}))],
    ['an incomplete revoker', changed((value) => delete value.anonymityRevokers[0].arPublicKey)],
    ['a non-hex revoker key', changed((value) => (value.anonymityRevokers[0].arPublicKey = 'zz'))],
  ])('rejects %s', (_label, value) => {
    expect(() => parseIdentityContextSnapshot(value)).toThrow();
  });

  it.each([-1, 2_147_483_648, 1.5, '1'])('rejects invalid provider identity %s', (identity) => {
    expect(() =>
      parseIdentityContextSnapshot(changed((value) => (value.identityProviders[0].ipIdentity = identity))),
    ).toThrow();
  });

  it('accepts the full positive uint32 range for AR identities independently of provider indexes', () => {
    const parsed = parseIdentityContextSnapshot(changed((value) => {
      value.anonymityRevokers[0].arIdentity = 0xffff_ffff;
    }));
    expect(parsed.anonymityRevokers[0]!.arIdentity).toBe(0xffff_ffff);
  });

  it.each([0, -1, 0x1_0000_0000, 1.5, '1'])('rejects invalid AR identity %s', (identity) => {
    expect(() =>
      parseIdentityContextSnapshot(changed((value) => (value.anonymityRevokers[0].arIdentity = identity))),
    ).toThrow();
  });

  it('rejects duplicate provider and revoker identities', () => {
    expect(() =>
      parseIdentityContextSnapshot(
        changed((value) => value.identityProviders.push(structuredClone(value.identityProviders[0]))),
      ),
    ).toThrow();
    expect(() =>
      parseIdentityContextSnapshot(
        changed((value) => value.anonymityRevokers.push(structuredClone(value.anonymityRevokers[0]))),
      ),
    ).toThrow();
  });
});
