import { describe, expect, it } from 'vitest';
import type { AccountCredential, CredentialPublicKeys } from '@concordium/web-sdk';
import {
  credentialIdOf,
  credentialPublicData,
  credentialSigningThreshold,
  extractAccountCredentials,
} from '../../src/index.js';

function credential(
  type: 'normal' | 'initial',
  publicKeys: CredentialPublicKeys = {
    threshold: 2,
    keys: { 3: { schemeId: 'Ed25519', verifyKey: 'AB'.repeat(32) } },
  },
): AccountCredential {
  const common = {
    ipIdentity: 0,
    policy: { createdAt: '202601', validTo: '202701', revealedAttributes: {} },
    credentialPublicKeys: publicKeys,
  };
  return {
    v: 0,
    value:
      type === 'initial'
        ? { type, contents: { ...common, regId: '11'.repeat(48) } }
        : {
            type,
            contents: {
              ...common,
              credId: '22'.repeat(48),
              revocationThreshold: 1,
              arData: {},
              commitments: {
                cmmPrf: '',
                cmmCredCounter: '',
                cmmIdCredSecSharingCoeff: [],
                cmmAttributes: {},
                cmmMaxAccounts: '',
              },
            },
          },
  };
}

describe('SDK account credentials', () => {
  it.each([
    ['initial', '11'],
    ['normal', '22'],
  ] as const)('reads the %s credential ID and keys from contents', (type, idByte) => {
    const input = credential(type);
    expect(credentialIdOf(input)).toBe(idByte.repeat(48));
    expect(credentialSigningThreshold(input)).toBe(2);
    expect(credentialPublicData(input)).toEqual({
      credentialId: idByte.repeat(48),
      threshold: '2',
      keys: { '3': { scheme: 'Ed25519', publicKey: 'ab'.repeat(32) } },
    });
  });

  it('filters SDK-unknown keys, unsupported schemes and malformed public keys', () => {
    const input = credential('normal', {
      threshold: 3,
      keys: {
        0: null,
        1: { schemeId: 'Other', verifyKey: 'ab'.repeat(32) },
        2: { schemeId: 'Ed25519', verifyKey: 'invalid' },
        4: { schemeId: 'ed25519', verifyKey: 'CD'.repeat(32) },
      },
    });
    expect(credentialPublicData(input)).toEqual({
      credentialId: '22'.repeat(48),
      threshold: '3',
      keys: { '4': { scheme: 'Ed25519', publicKey: 'cd'.repeat(32) } },
    });
    expect(credentialSigningThreshold(input)).toBe(3);
  });

  it('preserves sparse credential indexes and empty key maps', () => {
    expect(
      extractAccountCredentials({
        accountCredentials: {
          7: credential('initial', { threshold: 1, keys: {} }),
          12: credential('normal'),
        },
      }),
    ).toEqual({
      '7': { credentialId: '11'.repeat(48), threshold: '1', keys: {} },
      '12': {
        credentialId: '22'.repeat(48),
        threshold: '2',
        keys: { '3': { scheme: 'Ed25519', publicKey: 'ab'.repeat(32) } },
      },
    });
    expect(extractAccountCredentials({ accountCredentials: {} })).toEqual({});
  });
});
