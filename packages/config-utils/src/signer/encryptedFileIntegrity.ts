import { existsSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { ed25519PublicKey, type Ed25519PublicKeyHex } from '@ccd-agent-kit/sdk-utils';

import { getSignerDataDir } from '../paths.js';
import { ENCRYPTED_FILE_STORAGE_MODULE_ID, SOFTWARE_SIGNER_MODULE_ID } from './constants.js';
import { parseSoftwareBackend } from './backends.js';
import { loadEncryptedEd25519PrivateKey } from './encryptedKeyFiles.js';
import { isSoftwareStorageModuleEnabled } from './moduleConfig.js';
import {
  createSignerInventoryUpdater, ed25519SignerKeyRef, loadSignerInventory,
  publicKeyFromEd25519SignerKeyRef, saveSignerInventory, type SignerInventoryBackendEntry,
} from './inventory.js';

/** One public-key-addressed encrypted-storage integrity finding. */
export interface EncryptedFileIntegrityFinding { publicKey: Ed25519PublicKeyHex; }
/** Safe encrypted-storage integrity report. */
export interface EncryptedFileIntegrityReport {
  okReferences: EncryptedFileIntegrityFinding[];
  missingReferences: EncryptedFileIntegrityFinding[];
  adoptableOrphans: EncryptedFileIntegrityFinding[];
  invalidEntries: EncryptedFileIntegrityFinding[];
  prunedMissingReferences: EncryptedFileIntegrityFinding[];
}

/** Checks encrypted signer storage; repair only prunes missing references and never adopts orphan files. */
export async function checkEncryptedFileIntegrity(options: { fix: boolean }): Promise<EncryptedFileIntegrityReport> {
  const references = listReferences(); const files = listFiles(); const referenced = new Set(references.map((entry) => entry.keyRef));
  const report: EncryptedFileIntegrityReport = { okReferences: [], missingReferences: [], adoptableOrphans: [], invalidEntries: [], prunedMissingReferences: [] };
  for (const reference of references) {
    if (!existsSync(join(getSignerDataDir(), reference.keyRef))) report.missingReferences.push({ publicKey: reference.publicKey });
    else (await matches(reference.keyRef, reference.publicKey) ? report.okReferences : report.invalidEntries).push({ publicKey: reference.publicKey });
  }
  for (const file of files) if (!referenced.has(file.keyRef)) (await matches(file.keyRef, file.publicKey) ? report.adoptableOrphans : report.invalidEntries).push({ publicKey: file.publicKey });
  sort(report); if (!options.fix) return report;
  prune(report.missingReferences.map(({ publicKey }) => publicKey));
  report.prunedMissingReferences.push(...report.missingReferences); sort(report); return report;
}

/** Adopts one canonical encrypted key after unlock and public-key verification, without rewriting its file. */
export function adoptEncryptedFileKey(input: { publicKey: Ed25519PublicKeyHex; label?: string }): void {
  if (!isSoftwareStorageModuleEnabled(ENCRYPTED_FILE_STORAGE_MODULE_ID)) {
    throw new Error(`Software key-storage module ${ENCRYPTED_FILE_STORAGE_MODULE_ID} is disabled.`);
  }
  const publicKey = ed25519PublicKey.require(input.publicKey);
  const keyRef = encryptedRef(publicKey);
  loadEncryptedEd25519PrivateKey(keyRef, publicKey).fill(0);
  createSignerInventoryUpdater().upsert({
    publicKey, scheme: 'Ed25519', signingModule: SOFTWARE_SIGNER_MODULE_ID,
    backend: { keyRef, storageModule: ENCRYPTED_FILE_STORAGE_MODULE_ID },
    ...(input.label === undefined ? {} : { label: input.label }),
  });
}

function listReferences(): Array<{ publicKey: Ed25519PublicKeyHex; keyRef: string }> {
  return Object.entries(loadSignerInventory().keys).flatMap(([reference, entry]) => {
    // Loaded inventory references are canonical and schema-validated; Object.entries erases that key brand.
    const publicKey = publicKeyFromEd25519SignerKeyRef(reference)!;
    return entry.backends.flatMap((backend) => { const parsed = parseSoftwareBackend(backend.backend); return backend.signingModule === SOFTWARE_SIGNER_MODULE_ID && parsed?.storageModule === ENCRYPTED_FILE_STORAGE_MODULE_ID ? [{ publicKey, keyRef: parsed.keyRef }] : []; });
  });
}
function listFiles(): Array<{ publicKey: Ed25519PublicKeyHex; keyRef: string }> {
  const directory = join(getSignerDataDir(), 'keys', 'ed25519-encrypted'); if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => { const key = entry.isFile() ? ed25519PublicKey.from(basename(entry.name, '.json')) : undefined; return key !== undefined && entry.name === `${key}.json` ? [{ publicKey: key, keyRef: encryptedRef(key) }] : []; });
}
function matches(reference: string, publicKey: Ed25519PublicKeyHex): boolean { try { loadEncryptedEd25519PrivateKey(reference, publicKey).fill(0); return true; } catch { return false; } }
function prune(keys: Ed25519PublicKeyHex[]): void {
  if (keys.length === 0) return; const inventory = loadSignerInventory();
  for (const publicKey of keys) { const reference = ed25519SignerKeyRef(publicKey); const entry = inventory.keys[reference]; if (entry === undefined) continue; entry.backends = entry.backends.filter((backend) => !encryptedBackend(backend, publicKey)); if (entry.backends.length === 0) delete inventory.keys[reference]; }
  inventory.updatedAt = new Date().toISOString(); saveSignerInventory(inventory);
}
function encryptedBackend(entry: SignerInventoryBackendEntry, publicKey: Ed25519PublicKeyHex): boolean { const parsed = parseSoftwareBackend(entry.backend); return entry.signingModule === SOFTWARE_SIGNER_MODULE_ID && parsed?.storageModule === ENCRYPTED_FILE_STORAGE_MODULE_ID && parsed.keyRef === encryptedRef(publicKey); }
function encryptedRef(key: Ed25519PublicKeyHex): string { return join('keys', 'ed25519-encrypted', `${key}.json`); }
function sort(report: EncryptedFileIntegrityReport): void {
  const findings: EncryptedFileIntegrityFinding[][] = [
    report.okReferences, report.missingReferences, report.adoptableOrphans,
    report.invalidEntries, report.prunedMissingReferences,
  ];
  for (const entries of findings) entries.sort((left, right) => left.publicKey.localeCompare(right.publicKey));
}
