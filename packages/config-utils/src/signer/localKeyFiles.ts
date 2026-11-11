import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { parseSimpleWallet, parseWallet, type SimpleWalletFormat } from '@concordium/web-sdk';
import { getPublicKeyAsync } from '@noble/ed25519';
import {
  ed25519PrivateKey, ed25519PublicKey, keySchemes, publicKeyScheme,
  type Ed25519PrivateKeyHex, type Ed25519PublicKeyHex, type PublicKeyScheme,
} from '@ccd-agent-kit/sdk-utils';

import { createSignerInventoryUpdater, normalizeSignerKeyLabel, type SignerInventoryUpdater } from './inventory.js';
import { ENCRYPTED_FILE_STORAGE_MODULE_ID, SOFTWARE_SIGNER_MODULE_ID, type SoftwareKeyStorageModuleId } from './constants.js';
import { parseSoftwareKeyStorageModuleId } from './backends.js';
import { isSoftwareStorageModuleEnabled } from './moduleConfig.js';
import { isEncryptedFileStorageConfigured, unlockEncryptedFileStorage, writeEncryptedEd25519KeyFile } from './encryptedKeyFiles.js';

/** Transient plaintext Ed25519 key-file format accepted as import input. */
export interface LocalEd25519KeyFile { scheme: PublicKeyScheme; signKey: Ed25519PrivateKeyHex; verifyKey: Ed25519PublicKeyHex; }
/** Result of importing one local Ed25519 key. */
export interface ImportLocalEd25519KeyResult { publicKey: Ed25519PublicKeyHex; keyRef: string; }
/** Result of importing signing keys from a browser wallet export. */
export interface ImportWalletExportKeysResult { address: string; publicKeys: Ed25519PublicKeyHex[]; }
/** Result of importing a detected supported software key file. */
export type ImportSoftwareKeyFileResult = ({ kind: 'local-key' } & ImportLocalEd25519KeyResult) | ({ kind: 'wallet-export' } & ImportWalletExportKeysResult);

/** Validates and persists one imported Ed25519 private key. */
export async function importLocalEd25519Key(input: { privateKeyHex: string; label?: string; storage?: SoftwareKeyStorageModuleId; storagePassword?: string }): Promise<ImportLocalEd25519KeyResult> {
  const storage = parseSoftwareKeyStorageModuleId(input.storage ?? ENCRYPTED_FILE_STORAGE_MODULE_ID);
  const signKey = ed25519PrivateKey.require(input.privateKeyHex);
  const key = { scheme: keySchemes.Ed25519, signKey, verifyKey: await publicKeyFromPrivateKey(signKey) };
  return persist(key, { ...input, storage }, createSignerInventoryUpdater());
}

/**
 * Generates an Ed25519 seed directly in encrypted storage.
 * The private key is never returned and owned seed bytes are cleared.
 */
export async function generateLocalEd25519Key(input: {
  label?: string;
  storage?: SoftwareKeyStorageModuleId;
  storagePassword?: string;
} = {}): Promise<ImportLocalEd25519KeyResult> {
  const storage = parseSoftwareKeyStorageModuleId(input.storage ?? ENCRYPTED_FILE_STORAGE_MODULE_ID);
  const seed = randomBytes(32);
  try {
    return await importLocalEd25519Key({
      ...input,
      privateKeyHex: seed.toString('hex'),
      storage,
    });
  } finally {
    seed.fill(0);
  }
}

/** Validates and imports a native local Ed25519 key file without retaining its source path. */
export async function importLocalEd25519KeyFile(input: { filePath: string; label?: string; storage?: SoftwareKeyStorageModuleId; storagePassword?: string }): Promise<ImportLocalEd25519KeyResult> {
  const storage = parseSoftwareKeyStorageModuleId(input.storage ?? ENCRYPTED_FILE_STORAGE_MODULE_ID);
  const key = await validateLocal(parseLocal(JSON.parse(readFileSync(input.filePath, 'utf8')) as unknown));
  return persist(key, { ...input, storage }, createSignerInventoryUpdater());
}

/** Detects and imports a native key file or supported browser wallet export. */
export async function importSoftwareKeyFile(input: { filePath: string; label?: string; storage?: SoftwareKeyStorageModuleId; storagePassword?: string }): Promise<ImportSoftwareKeyFileResult> {
  const storage = parseSoftwareKeyStorageModuleId(input.storage ?? ENCRYPTED_FILE_STORAGE_MODULE_ID);
  const content = readFileSync(input.filePath, 'utf8');
  let parsed: unknown;
  try { parsed = JSON.parse(content) as unknown; } catch { throw new Error('Key file must be valid JSON.'); }
  if (isLocalCandidate(parsed)) return { kind: 'local-key', ...persist(await validateLocal(parseLocal(parsed)), { ...input, storage }, createSignerInventoryUpdater()) };
  return { kind: 'wallet-export', ...await importWalletContent(content, parsed, { ...input, storage }) };
}

/** Imports all Ed25519 signing keys from a browser wallet export. */
export async function importWalletExportKeys(input: { filePath: string; label?: string; storage?: SoftwareKeyStorageModuleId; storagePassword?: string }): Promise<ImportWalletExportKeysResult> {
  const storage = parseSoftwareKeyStorageModuleId(input.storage ?? ENCRYPTED_FILE_STORAGE_MODULE_ID);
  return importWalletContent(readFileSync(input.filePath, 'utf8'), undefined, { ...input, storage });
}

async function importWalletContent(content: string, parsed: unknown, input: { label?: string; storage: SoftwareKeyStorageModuleId; storagePassword?: string }): Promise<ImportWalletExportKeysResult> {
  const wallet = parseSupportedWallet(content, parsed);
  const keys = await Promise.all(extractWalletKeys(wallet).map((key) => validateLocal({ scheme: keySchemes.Ed25519, ...key }, 'Wallet export verifyKey does not match signKey.')));
  if (keys.length === 0) throw new Error('Wallet export does not contain any Ed25519 signing keys.');
  const updater = createSignerInventoryUpdater(); const publicKeys: Ed25519PublicKeyHex[] = [];
  for (const [index, key] of keys.entries()) {
    const label = input.label === undefined ? undefined : normalizeSignerKeyLabel(keys.length === 1 ? input.label : `${input.label.trim()}-${index}`);
    publicKeys.push(persist(key, { ...input, ...(label === undefined ? {} : { label }) }, updater).publicKey);
  }
  return { address: wallet.address, publicKeys: [...new Set(publicKeys)] };
}

function persist(key: LocalEd25519KeyFile, input: { label?: string; storage: SoftwareKeyStorageModuleId; storagePassword?: string }, inventory: SignerInventoryUpdater): ImportLocalEd25519KeyResult {
  const label = input.label === undefined ? undefined : normalizeSignerKeyLabel(input.label);
  const storage = input.storage;
  if (!isSoftwareStorageModuleEnabled(storage)) throw new Error(`Software key-storage module ${storage} is disabled.`);
  if (!isEncryptedFileStorageConfigured()) throw new Error('Encrypted-file storage is not initialized.');
  if (input.storagePassword !== undefined) unlockEncryptedFileStorage(input.storagePassword);
  const keyRef = writeEncryptedEd25519KeyFile(key.verifyKey, key.signKey);
  inventory.upsert({ publicKey: key.verifyKey, scheme: key.scheme, signingModule: SOFTWARE_SIGNER_MODULE_ID, backend: { keyRef, storageModule: storage }, ...(label === undefined ? {} : { label }) });
  return { keyRef, publicKey: key.verifyKey };
}

function parseLocal(value: unknown): LocalEd25519KeyFile { if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error("Key file scheme must be 'Ed25519'."); const raw = value as Record<string, unknown>; return { scheme: publicKeyScheme.require(raw.scheme), signKey: ed25519PrivateKey.require(raw.signKey), verifyKey: ed25519PublicKey.require(raw.verifyKey) }; }
async function validateLocal(key: LocalEd25519KeyFile, message = 'Key file verifyKey does not match signKey.'): Promise<LocalEd25519KeyFile> { if (key.verifyKey !== await publicKeyFromPrivateKey(key.signKey)) throw new Error(message); return key; }
function isLocalCandidate(value: unknown): boolean { if (typeof value !== 'object' || value === null || Array.isArray(value)) return false; const raw = value as Record<string, unknown>; return raw.scheme !== undefined || raw.signKey !== undefined || raw.verifyKey !== undefined; }
function parseSupportedWallet(content: string, parsed: unknown): SimpleWalletFormat {
  for (const candidate of [parsed, tryParse(() => parseWallet(content)), tryParse(() => parseSimpleWallet(content))]) { const wallet = unwrapWallet(candidate); if (wallet !== undefined) return wallet; }
  throw new Error('Wallet export is missing an account address.');
}
function tryParse(operation: () => unknown): unknown { try { return operation(); } catch { return undefined; } }
function unwrapWallet(value: unknown): SimpleWalletFormat | undefined { if (typeof value !== 'object' || value === null) return undefined; const raw = value as Record<string, unknown>; const candidate = typeof raw.value === 'object' && raw.value !== null ? raw.value as SimpleWalletFormat : value as SimpleWalletFormat; return typeof candidate.address === 'string' ? candidate : undefined; }
function extractWalletKeys(wallet: SimpleWalletFormat): Array<{ signKey: Ed25519PrivateKeyHex; verifyKey: Ed25519PublicKeyHex }> { const credentials = wallet.accountKeys.keys as Record<string, { keys?: Record<string, { signKey?: string; verifyKey?: string }> }>; const output: Array<{ signKey: Ed25519PrivateKeyHex; verifyKey: Ed25519PublicKeyHex }> = []; for (const credential of Object.keys(credentials).sort(numeric)) for (const key of Object.keys(credentials[credential]?.keys ?? {}).sort(numeric)) { const raw = credentials[credential]!.keys![key]!; output.push({ signKey: ed25519PrivateKey.require(raw.signKey), verifyKey: ed25519PublicKey.require(raw.verifyKey) }); } return output; }
function numeric(left: string, right: string): number { return Number(left) - Number(right); }
async function publicKeyFromPrivateKey(key: Ed25519PrivateKeyHex): Promise<Ed25519PublicKeyHex> { return ed25519PublicKey.require(Buffer.from(await getPublicKeyAsync(key)).toString('hex')); }
