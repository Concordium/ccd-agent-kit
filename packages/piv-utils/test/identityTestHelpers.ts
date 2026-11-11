import { createECDH } from 'node:crypto';
import { expect } from 'vitest';

export const PRIVATE_DIAGNOSTIC = 'secret=deadbeef /protected/identity/private-state';

export function expectSanitized(error: unknown, errorClass: new (...args: never[]) => Error, code: string) {
  expect(error).toBeInstanceOf(errorClass);
  expect(error).toHaveProperty('code', code);
  expect(error).not.toHaveProperty('cause');
  expect(`${String(error)} ${JSON.stringify(error)} ${(error as Error).stack}`).not.toContain(PRIVATE_DIAGNOSTIC);
}

export function protocolPeer(): Buffer {
  const ecdh = createECDH('prime256v1'); const scalar = Buffer.alloc(32); scalar[31] = 3;
  ecdh.setPrivateKey(scalar); return ecdh.getPublicKey(undefined, 'uncompressed');
}
