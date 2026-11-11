import { createECDH, hkdfSync } from 'node:crypto';
import { hashToCurve, p256 } from '@noble/curves/p256';
import { expect, vi } from 'vitest';
import type { IdentityRootAgreement } from '../src/core/identityRoot.js';
import type { IdentityProviderService } from '../src/core/providers/types.js';

export const PRIVATE_DIAGNOSTIC = 'secret=deadbeef /protected/identity/private-state';
export const TEST_GENESIS_HASH = '12'.repeat(32);
export const TEST_CANONICAL_NETWORK = {
  caip2: `ccd:${TEST_GENESIS_HASH.slice(0, 32)}`,
  genesisHash: TEST_GENESIS_HASH,
};

export function identityProviderServiceFixture(
  overrides: Partial<IdentityProviderService> = {},
): IdentityProviderService {
  return {
    inventory: vi.fn(async ({ network }) => ({
      network: network.caip2,
      providers: [{ index: 4, name: 'Provider Four', enabled: true }],
    })),
    refresh: vi.fn(),
    configure: vi.fn(),
    inspect: vi.fn(),
    setEnabled: vi.fn(),
    getIdentityRequestTimeoutMs: vi.fn(async () => 86_400_000),
    configureIdentityRequestTimeout: vi.fn(async ({ network, seconds }) => ({
      network: network.caip2, identityRequestTimeoutSeconds: seconds,
    })),
    resolve: vi.fn(async () => ({
      index: 4,
      issuanceUrl: 'https://idp.example/issue',
      recoveryUrl: 'https://idp.example/recover',
      issuanceMethod: 'GET' as const,
    })),
    ...overrides,
  };
}

export function expectSanitized(error: unknown, errorClass: new (...args: never[]) => Error, code: string) {
  expect(error).toBeInstanceOf(errorClass);
  expect(error).toHaveProperty('code', code);
  expect(error).not.toHaveProperty('cause');
  const visible = `${String(error)} ${JSON.stringify(error)} ${(error as Error).stack}`;
  expect(visible).not.toContain(PRIVATE_DIAGNOSTIC);
  expect(visible).not.toContain('/protected/identity');
  expect(visible).not.toContain('deadbeef');
}

export function protocolPeer(): Buffer {
  return Buffer.from(
    p256.ProjectivePoint.fromAffine(
      hashToCurve(Buffer.from('ccd-agent-kit/ccd-id-manager/identity-root/v1-spike'), {
        DST: Buffer.from('ccd-agent-kit/ccd-id-manager/hash-to-curve/v1-spike'),
      }).toAffine(),
    ).toRawBytes(false),
  );
}

export function independentRoot(secret: Uint8Array): Buffer {
  return Buffer.from(
    hkdfSync(
      'sha256',
      secret,
      Buffer.from('ccd-agent-kit/ccd-id-manager/root-extraction/v1-spike'),
      Buffer.from('concordium/identity-sdk-seed/v1-spike'),
      64,
    ),
  );
}

// A software device-side fake only: the host core never receives this scalar.
export function softwareDevice(scalar = 1) {
  const device = createECDH('prime256v1');
  const privateKey = Buffer.alloc(32);
  privateKey.writeUInt32BE(scalar, 28);
  device.setPrivateKey(privateKey);
  privateKey.fill(0);
  const publicKey = device.getPublicKey(undefined, 'uncompressed');
  const transferred: Buffer[] = [];
  const agree = vi.fn<IdentityRootAgreement['agree']>(async (peer: Uint8Array) => {
    const sharedSecret = device.computeSecret(peer);
    transferred.push(sharedSecret);
    return { publicKey: Buffer.from(publicKey), sharedSecret };
  });
  return { publicKey, agree, transferred, computeSecret: (peer: Uint8Array) => device.computeSecret(peer) };
}
