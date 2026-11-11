import { ed25519PrivateKey, ed25519PublicKey, type Ed25519PrivateKeyHex, type Ed25519PublicKeyHex } from '@ccd-agent-kit/sdk-utils';

/** Returns a branded synthetic Ed25519 public key for positive test fixtures. */
export function testEd25519PublicKey(byteHex: string): Ed25519PublicKeyHex {
  return ed25519PublicKey.require(byteHex.repeat(32));
}

/** Brands a full positive Ed25519 public-key hex fixture. */
export function testEd25519PublicKeyHex(value: string): Ed25519PublicKeyHex {
  return ed25519PublicKey.require(value);
}

export const TEST_PUBLIC_KEY_AB = testEd25519PublicKey('ab');
export const TEST_PUBLIC_KEY_CD = testEd25519PublicKey('cd');
export const TEST_PUBLIC_KEY_EF = testEd25519PublicKey('ef');

/** Returns a branded synthetic Ed25519 private key for positive test fixtures. */
export function testEd25519PrivateKey(byteHex: string): Ed25519PrivateKeyHex {
  return ed25519PrivateKey.require(byteHex.repeat(32));
}
