import { describe,expect,it } from 'vitest';
import { deriveIdentityMaterial } from '../../src/core/identityMaterial.js';
import {
deriveIdentityRoot,
identityRootPeerPublicKey,
type IdentityRootAgreement
} from '../../src/core/identityRoot.js';
import { deriveIdentityStorageMaterial } from '../../src/core/identityStorageCrypto.js';
import {
LEADING_ZERO_VECTOR,
MAINNET_VECTOR,
PEER_HEX,
ROOT_CONTEXT,
ROOT_PUBLIC_KEY_HEX,
fixedScalarDevice
} from '../identityCryptoFixtures.js';

function input(agreement: IdentityRootAgreement) {
  return { ...ROOT_CONTEXT, expectedPublicKey: Buffer.from(ROOT_PUBLIC_KEY_HEX, 'hex'), agreement };
}

describe('context-bound identity root storage and SDK outputs', () => {
  it('preserves a leading-zero ECDH x coordinate across the complete derivation recipe', async () => {
    const vector = LEADING_ZERO_VECTOR;
    const device = fixedScalarDevice(vector.scalar);
    const sharedSecret = device.secret(Buffer.from(PEER_HEX, 'hex'));
    expect(sharedSecret.toString('hex')).toBe(vector.sharedSecret);
    expect(device.publicKey.toString('hex')).toBe(vector.publicKey);
    const seed = await deriveIdentityRoot({
      ...ROOT_CONTEXT,
      expectedPublicKey: device.publicKey,
      agreement: { agree: async () => ({ publicKey: device.publicKey, sharedSecret }) },
    });
    const storage = deriveIdentityStorageMaterial(seed);
    try {
      expect(seed.toString('hex')).toBe(vector.seed);
      expect(storage.fileId).toBe(vector.fileId);
      expect(storage.encryptionKey.toString('hex')).toBe(vector.fileKey);
      expect(sharedSecret).toEqual(Buffer.alloc(32));
    } finally {
      seed.fill(0);
      storage.encryptionKey.fill(0);
    }
  });
  it('separates Mainnet and Testnet peers, seeds, storage, and SDK identity outputs', async () => {
    const device = fixedScalarDevice();
    const derive = async (network: 'Mainnet' | 'Testnet') => {
      const context = { ...ROOT_CONTEXT, network };
      const peer = identityRootPeerPublicKey(context);
      const seed = await deriveIdentityRoot({
        ...input({ agree: async () => ({ publicKey: device.publicKey, sharedSecret: device.secret(peer) }) }),
        ...context,
      });
      return {
        peer,
        seed,
        storage: deriveIdentityStorageMaterial(seed),
        material: deriveIdentityMaterial({ seed, network, identityProviderIndex: 3, identityIndex: 7 }),
      };
    };
    const testnet = await derive('Testnet');
    const mainnet = await derive('Mainnet');
    try {
      expect(mainnet.peer.toString('hex')).toBe(MAINNET_VECTOR.peer);
      expect(mainnet.seed.toString('hex')).toBe(MAINNET_VECTOR.seed);
      expect(mainnet.storage.fileId).toBe(MAINNET_VECTOR.fileId);
      expect(mainnet.storage.encryptionKey.toString('hex')).toBe(MAINNET_VECTOR.fileKey);
      for (const key of ['peer', 'seed'] as const) expect(mainnet[key]).not.toEqual(testnet[key]);
      expect(mainnet.storage.fileId).not.toBe(testnet.storage.fileId);
      expect(mainnet.storage.encryptionKey).not.toEqual(testnet.storage.encryptionKey);
      for (const key of ['idCredSec', 'prfKey', 'signatureBlindingRandomness'] as const) {
        expect(mainnet.material[key]).not.toEqual(testnet.material[key]);
      }
    } finally {
      for (const output of [mainnet, testnet]) {
        output.seed.fill(0);
        output.storage.encryptionKey.fill(0);
        for (const value of Object.values(output.material)) value.fill(0);
      }
    }
  });
});
