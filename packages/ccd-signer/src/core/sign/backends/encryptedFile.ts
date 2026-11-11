import { randomBytes, createCipheriv, createDecipheriv, scryptSync } from 'node:crypto';
import { readFileSync } from 'node:fs';

import type { AccountTransactionSignature } from '@concordium/web-sdk';
import { signAsync } from '@noble/ed25519';

import type { TransactionSigningBackend, TransactionSigningRequest } from '../transactionSigningBackend.js';

/**
 * On-disk format for an AES-256-GCM encrypted private key file.
 */
export interface EncryptedKeyFile {
  /** Format version. Currently `1`. */
  version: number;
  /** The account address this key controls (informational). */
  address?: string;
  /** Encryption parameters. */
  crypto: {
    /** The cipher used. Currently `"aes-256-gcm"`. */
    cipher: string;
    /** Key-derivation function. Currently `"scrypt"`. */
    kdf: string;
    /** KDF parameters. */
    kdfParams: {
      /** Hex-encoded random salt. */
      salt: string;
      /** scrypt CPU/memory cost parameter. */
      n: number;
      /** scrypt block size parameter. */
      r: number;
      /** scrypt parallelization parameter. */
      p: number;
      /** Derived key length in bytes. */
      keyLength: number;
    };
    /** Hex-encoded initialization vector. */
    iv: string;
    /** Hex-encoded GCM authentication tag. */
    tag: string;
  };
  /** Hex-encoded AES-256-GCM ciphertext of the ed25519 private key. */
  ciphertext: string;
}

const CURRENT_VERSION = 1;

/**
 * Derives a 32-byte AES key from a password using scrypt.
 */
function deriveKey(password: string, params: EncryptedKeyFile['crypto']['kdfParams']): Buffer {
  return scryptSync(password, Buffer.from(params.salt, 'hex'), params.keyLength, {
    N: params.n,
    r: params.r,
    p: params.p,
  });
}

/**
 * Decrypts an ed25519 private key from an encrypted key file.
 */
function decryptPrivateKey(file: EncryptedKeyFile, password: string): string {
  if (file.crypto.cipher !== 'aes-256-gcm') {
    throw new Error(`Unsupported cipher: ${file.crypto.cipher}`);
  }
  if (file.crypto.kdf !== 'scrypt') {
    throw new Error(`Unsupported KDF: ${file.crypto.kdf}`);
  }

  const key = deriveKey(password, file.crypto.kdfParams);
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(file.crypto.iv, 'hex'));
  decipher.setAuthTag(Buffer.from(file.crypto.tag, 'hex'));

  const decrypted = Buffer.concat([decipher.update(Buffer.from(file.ciphertext, 'hex')), decipher.final()]);

  return decrypted.toString('hex');
}

/**
 * Creates an encrypted key file from a plaintext hex private key and a password.
 *
 * @param privateKeyHex - The hex-encoded ed25519 private key (32 bytes / 64 hex chars).
 * @param password - The encryption password.
 * @param address - Optional account address for the file header.
 * @returns The encrypted key file object.
 */
export function createEncryptedKeyFile(privateKeyHex: string, password: string, address?: string): EncryptedKeyFile {
  const salt = randomBytes(16).toString('hex');
  const kdfParams = { salt, n: 16_384, r: 8, p: 1, keyLength: 32 };
  const key = deriveKey(password, kdfParams);
  const iv = randomBytes(12);

  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(Buffer.from(privateKeyHex, 'hex')), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    version: CURRENT_VERSION,
    address,
    crypto: {
      cipher: 'aes-256-gcm',
      kdf: 'scrypt',
      kdfParams,
      iv: iv.toString('hex'),
      tag: tag.toString('hex'),
    },
    ciphertext: encrypted.toString('hex'),
  };
}

/**
 * A signing backend that reads a private key from an AES-256-GCM encrypted JSON file.
 *
 * Works around an SDK alpha bug where `buildBasicAccountSigner` passes a hex string
 * to `@noble/ed25519` v2 which expects `Uint8Array`.
 */
export class EncryptedFileSigningBackend implements TransactionSigningBackend {
  private readonly privateKeyBytes: Uint8Array;

  /**
   * Creates a backend by decrypting the key file with the given password.
   *
   * @param filePath - Absolute path to the encrypted key JSON file.
   * @param password - The decryption password.
   */
  public constructor(filePath: string, password: string) {
    const raw = readFileSync(filePath, 'utf-8');
    const file: EncryptedKeyFile = JSON.parse(raw);
    const privateKeyHex = decryptPrivateKey(file, password);
    this.privateKeyBytes = Uint8Array.from(Buffer.from(privateKeyHex, 'hex'));
  }

  /**
   * Produces a Concordium account-transaction signature using the decrypted private key.
   *
   * Signs the provided transaction digest directly with `@noble/ed25519`,
   * returning the raw signature without mutating the original transaction data.
   *
   * @param request - The signing request.
   * @returns The account transaction signature.
   */
  public async createSignature(request: TransactionSigningRequest): Promise<AccountTransactionSignature> {
    const sig = await signAsync(request.digest, this.privateKeyBytes);
    return {
      0: {
        0: Buffer.from(sig).toString('hex'),
      },
    };
  }
}
