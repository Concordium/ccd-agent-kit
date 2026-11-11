import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Ed25519PrivateKeyHex, Ed25519PublicKeyHex } from '@ccd-agent-kit/sdk-utils';

import { getSignerDataDir, getSignerKeyStorageDir } from '../paths.js';
import { protectedFileExists, writeProtectedJsonAtomic } from './protectedFile.js';

const STORAGE_STATE_TYPE = 'ccd-signer.encrypted-file-storage';
const KEY_FILE_TYPE = 'ccd-signer.ed25519-key';
const VERIFIER_TEXT = 'ccd-signer encrypted file storage';
const SCRYPT_PARAMS = { n: 16_384, r: 8, p: 1, keyLength: 32 } as const;
const PKCS8_ED25519_SEED_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const ENCRYPTED_KEY_REFERENCE = /^keys\/ed25519-encrypted\/([0-9a-f]{64})\.json$/;
const HEX_12_BYTES = /^[0-9a-f]{24}$/;
const HEX_16_BYTES = /^[0-9a-f]{32}$/;
const HEX_32_BYTES = /^[0-9a-f]{64}$/;
const EVEN_HEX = /^(?:[0-9a-f]{2})+$/;

interface AesGcmBox {
  cipher: 'aes-256-gcm';
  iv: string;
  tag: string;
  cipherText: string;
}

interface StorageState {
  version: 1;
  type: typeof STORAGE_STATE_TYPE;
  kdf: {
    name: 'scrypt';
    salt: string;
    n: number;
    r: number;
    p: number;
    keyLength: number;
  };
  encryptedStorageKey: AesGcmBox;
  verifier: AesGcmBox;
}

interface KeyFile extends AesGcmBox {
  version: 1;
  type: typeof KEY_FILE_TYPE;
}

let unlockedStorageKey: Buffer | undefined;

/** Returns whether protected encrypted signer storage has been initialized. */
export function isEncryptedFileStorageConfigured(): boolean {
  return protectedFileExists(storageStatePath());
}

/** Returns whether this process currently holds the decrypted storage key. */
export function isEncryptedFileStorageUnlocked(): boolean {
  return unlockedStorageKey !== undefined;
}

/** Initializes encrypted signer storage with a new non-empty password. */
export function initializeEncryptedFileStorage(password: string): void {
  requirePassword(password);
  if (isEncryptedFileStorageConfigured()) throw new Error('Encrypted-file storage is already initialized.');
  const storageKey = randomBytes(32);
  let retained = false;
  try {
    writeStorageState(storageKey, password);
    retained = true;
  } finally {
    if (!retained) storageKey.fill(0);
  }
}

/** Unlocks encrypted signer storage for this process. */
export function unlockEncryptedFileStorage(password: string): void {
  requirePassword(password);
  if (!isEncryptedFileStorageConfigured()) throw new Error('Encrypted-file storage is not initialized.');
  const state = readStorageState();
  let passwordKey: Buffer | undefined;
  let candidate: Buffer | undefined;
  let verifier: Buffer | undefined;
  try {
    passwordKey = derivePasswordKey(password, state.kdf);
    candidate = decryptBox(state.encryptedStorageKey, passwordKey);
    verifier = decryptBox(state.verifier, candidate);
    if (!timingSafeEqual(verifier, Buffer.from(VERIFIER_TEXT, 'utf8'))) throw new Error();
    replaceUnlockedStorageKey(candidate);
    candidate = undefined;
  } catch {
    throw new Error('Encrypted storage password is incorrect.');
  } finally {
    passwordKey?.fill(0);
    candidate?.fill(0);
    verifier?.fill(0);
  }
}

/** Changes the password protecting the storage key without rewriting encrypted key files. */
export function changeEncryptedFileStoragePassword(currentPassword: string, newPassword: string): void {
  requirePassword(newPassword);
  if (!isEncryptedFileStorageConfigured()) throw new Error('Encrypted-file storage is not initialized.');
  unlockEncryptedFileStorage(currentPassword);
  writeStorageState(requireUnlockedStorageKey(), newPassword);
}

/** Clears the decrypted storage key held by this process. */
export function lockEncryptedFileStorage(): void {
  unlockedStorageKey?.fill(0);
  unlockedStorageKey = undefined;
}

/** Encrypts one producer-validated Ed25519 private key and returns its signer-data-relative reference. */
export function writeEncryptedEd25519KeyFile(
  publicKey: Ed25519PublicKeyHex,
  privateKeyHex: Ed25519PrivateKeyHex,
): string {
  const keyReference = encryptedKeyReference(publicKey);
  const privateKey = Buffer.from(privateKeyHex, 'hex');
  try {
    const file: KeyFile = { version: 1, type: KEY_FILE_TYPE, ...encryptBox(privateKey, requireUnlockedStorageKey()) };
    writeProtectedJsonAtomic(encryptedKeyPath(keyReference, publicKey), file, 'ed25519-key');
    return keyReference;
  } finally {
    privateKey.fill(0);
  }
}

/** Decrypts one validated fixed-size Ed25519 key after binding its reference and bytes to the expected public key. */
export function loadEncryptedEd25519PrivateKey(
  keyReference: string,
  publicKey: Ed25519PublicKeyHex,
): Uint8Array {
  const filename = encryptedKeyPath(keyReference, publicKey);
  if (!protectedFileExists(filename)) throw new Error('Encrypted key file was not found.');
  const file = parseKeyFile(JSON.parse(readFileSync(filename, 'utf8')) as unknown);
  const privateKey = decryptBox(file, requireUnlockedStorageKey());
  try {
    assertPrivateKeyMatchesPublicKey(privateKey, publicKey);
    return Uint8Array.from(privateKey);
  } finally {
    privateKey.fill(0);
  }
}

function requirePassword(password: string): void {
  if (password.length === 0) throw new Error('Encrypted storage password must not be empty.');
}

function requireUnlockedStorageKey(): Buffer {
  if (unlockedStorageKey === undefined) throw new Error('ENCRYPTED_STORAGE_LOCKED');
  return unlockedStorageKey;
}

function replaceUnlockedStorageKey(next: Buffer): void {
  if (unlockedStorageKey !== undefined && unlockedStorageKey !== next) unlockedStorageKey.fill(0);
  unlockedStorageKey = next;
}

function storageStatePath(): string {
  return join(getSignerKeyStorageDir(), 'encrypted-file.json');
}

function encryptedKeyReference(publicKey: Ed25519PublicKeyHex): string {
  return `keys/ed25519-encrypted/${publicKey}.json`;
}

function encryptedKeyPath(keyReference: string, publicKey: Ed25519PublicKeyHex): string {
  const match = ENCRYPTED_KEY_REFERENCE.exec(keyReference);
  if (match?.[1] !== publicKey) throw new Error('Encrypted key reference does not match the expected public key.');
  return join(getSignerDataDir(), ...keyReference.split('/'));
}

function readStorageState(): StorageState {
  return parseStorageState(JSON.parse(readFileSync(storageStatePath(), 'utf8')) as unknown);
}

function writeStorageState(storageKey: Buffer, password: string): void {
  const kdf = { name: 'scrypt' as const, salt: randomBytes(16).toString('hex'), ...SCRYPT_PARAMS };
  let passwordKey: Buffer | undefined;
  const verifierText = Buffer.from(VERIFIER_TEXT, 'utf8');
  try {
    passwordKey = derivePasswordKey(password, kdf);
    const state: StorageState = {
      version: 1,
      type: STORAGE_STATE_TYPE,
      kdf,
      encryptedStorageKey: encryptBox(storageKey, passwordKey),
      verifier: encryptBox(verifierText, storageKey),
    };
    writeProtectedJsonAtomic(storageStatePath(), state, 'encrypted-file');
    replaceUnlockedStorageKey(storageKey);
  } finally {
    passwordKey?.fill(0);
    verifierText.fill(0);
  }
}

function parseStorageState(value: unknown): StorageState {
  if (!isRecord(value) || !hasExactKeys(value, ['version', 'type', 'kdf', 'encryptedStorageKey', 'verifier'])
    || value.version !== 1 || value.type !== STORAGE_STATE_TYPE || !isRecord(value.kdf)
    || !hasExactKeys(value.kdf, ['name', 'salt', 'n', 'r', 'p', 'keyLength'])
    || value.kdf.name !== 'scrypt' || !HEX_16_BYTES.test(String(value.kdf.salt))
    || value.kdf.n !== SCRYPT_PARAMS.n || value.kdf.r !== SCRYPT_PARAMS.r
    || value.kdf.p !== SCRYPT_PARAMS.p || value.kdf.keyLength !== SCRYPT_PARAMS.keyLength
    || !isAesGcmBox(value.encryptedStorageKey, HEX_32_BYTES)
    || !isAesGcmBox(value.verifier, EVEN_HEX)) {
    throw new Error('Encrypted storage state is not supported.');
  }
  return structuredClone(value) as unknown as StorageState;
}

function parseKeyFile(value: unknown): KeyFile {
  if (!isRecord(value) || !hasExactKeys(value, ['version', 'type', 'cipher', 'iv', 'tag', 'cipherText'])
    || value.version !== 1 || value.type !== KEY_FILE_TYPE || !isAesGcmBox(value, HEX_32_BYTES)) {
    throw new Error('Encrypted key file is not supported or malformed.');
  }
  return structuredClone(value) as unknown as KeyFile;
}

function isAesGcmBox(value: unknown, cipherTextPattern: RegExp): value is AesGcmBox {
  return isRecord(value) && value.cipher === 'aes-256-gcm'
    && typeof value.iv === 'string' && HEX_12_BYTES.test(value.iv)
    && typeof value.tag === 'string' && HEX_16_BYTES.test(value.tag)
    && typeof value.cipherText === 'string' && cipherTextPattern.test(value.cipherText);
}

function derivePasswordKey(password: string, params: StorageState['kdf']): Buffer {
  return scryptSync(password, Buffer.from(params.salt, 'hex'), params.keyLength, {
    N: params.n,
    r: params.r,
    p: params.p,
  });
}

function encryptBox(plainText: Buffer, key: Buffer): AesGcmBox {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const cipherText = Buffer.concat([cipher.update(plainText), cipher.final()]);
  return {
    cipher: 'aes-256-gcm',
    iv: iv.toString('hex'),
    tag: cipher.getAuthTag().toString('hex'),
    cipherText: cipherText.toString('hex'),
  };
}

function decryptBox(box: AesGcmBox, key: Buffer): Buffer {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(box.iv, 'hex'));
  decipher.setAuthTag(Buffer.from(box.tag, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(box.cipherText, 'hex')), decipher.final()]);
}

function assertPrivateKeyMatchesPublicKey(privateKey: Buffer, publicKey: Ed25519PublicKeyHex): void {
  const encodedPrivateKey = Buffer.concat([PKCS8_ED25519_SEED_PREFIX, privateKey]);
  try {
    const derived = createPublicKey(createPrivateKey({ key: encodedPrivateKey, format: 'der', type: 'pkcs8' }))
      .export({ format: 'der', type: 'spki' }).subarray(-32);
    if (!timingSafeEqual(derived, Buffer.from(publicKey, 'hex'))) {
      throw new Error('Encrypted key private key does not match the expected public key.');
    }
  } finally {
    encodedPrivateKey.fill(0);
  }
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
