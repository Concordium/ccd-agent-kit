import type { AccountCredential, CredentialPublicKeys } from '@concordium/web-sdk';

/** Complete SDK credential fixtures; type checking prevents invented wrapper shapes. */
export function accountCredential(
  type: 'initial' | 'normal' = 'normal',
  id = 'ab'.repeat(48),
  publicKeys: CredentialPublicKeys = { threshold: 1, keys: { 0: { schemeId: 'Ed25519', verifyKey: 'cd'.repeat(32) } } },
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
        ? { type, contents: { ...common, regId: id } }
        : {
            type,
            contents: {
              ...common,
              credId: id,
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
