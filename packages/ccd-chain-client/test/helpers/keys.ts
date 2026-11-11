import { ed25519PublicKey } from '@ccd-agent-kit/sdk-utils';

export const FIXTURE_PUBLIC_KEY = ed25519PublicKey.require('ab'.repeat(32));
export const CREDENTIAL_PUBLIC_KEY = ed25519PublicKey.require('cd'.repeat(32));
export const UPDATED_PUBLIC_KEY = ed25519PublicKey.require('ef'.repeat(32));

export function fixturePublicKey(byteHex: string) {
  return ed25519PublicKey.require(byteHex.repeat(32));
}
