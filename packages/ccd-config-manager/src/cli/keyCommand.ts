import { stdin as input, stdout as output } from 'node:process';
import { readHiddenLine } from '@ccd-agent-kit/cli-utils';

import {
  adoptEncryptedFileKey,
  ENCRYPTED_FILE_STORAGE_MODULE_ID,
  generateLocalEd25519Key,
  importLocalEd25519Key,
  importSoftwareKeyFile,
  isEncryptedFileStorageConfigured,
  loadSignerInventory,
  normalizeCatalogLabel,
  parseCatalogLabel,
  parseSoftwareKeyStorageModule,
  unlockEncryptedFileStorage,
} from '@ccd-agent-kit/config-utils';
import type { Ed25519PublicKeyHex } from '@ccd-agent-kit/sdk-utils';

/** Typed key-management request and injectable command IO. */
export interface RunKeyCommandOptions {
  request: KeyCommandRequest;
  stderr: string[];
  stdout: string[];
  promptPrivateKey?: () => Promise<string>;
  promptUnlockPassword?: () => Promise<string>;
}

/** Operational request accepted by the software key command after Commander parsing. */
export type KeyCommandRequest =
  | { action: 'adopt'; publicKey: Ed25519PublicKeyHex; label?: string }
  | { action: 'generate'; label?: string; storage?: string }
  | { action: 'import'; file?: string; label?: string; storage?: string };

/** User-facing messages owned by the software key command. */
export const keyCommandMessages = {
  encryptedStorageUninitialized: 'Encrypted-file storage is not initialized. Run: ccd-config-manager storage init --storage encrypted-file',
} as const;

/** Runs config-owned accountless software-key management commands. */
export async function runKeyCommand(options: RunKeyCommandOptions): Promise<number> {
  try {
    switch (options.request.action) {
      case 'adopt':
        return await runAdopt(options, options.request);
      case 'generate':
        return await runGenerate(options, options.request);
      case 'import':
        return await runImport(options, options.request);
    }
  } catch (error) {
    options.stderr.push(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

async function runAdopt(options: RunKeyCommandOptions, request: Extract<KeyCommandRequest, { action: 'adopt' }>): Promise<number> {
  await unlockStorage(options);
  adoptEncryptedFileKey({ publicKey: request.publicKey, ...(request.label === undefined ? {} : { label: request.label }) });
  options.stdout.push(JSON.stringify({ publicKey: request.publicKey }, null, 2));
  return 0;
}

async function runImport(options: RunKeyCommandOptions, request: Extract<KeyCommandRequest, { action: 'import' }>): Promise<number> {
  const resolvedStorage = request.storage === undefined ? ENCRYPTED_FILE_STORAGE_MODULE_ID : parseSoftwareKeyStorageModule(request.storage);
  await unlockStorage(options);
  let importedPublicKeys: string[];
  if (request.file !== undefined) {
    const result = await importSoftwareKeyFile({ filePath: request.file, label: request.label, storage: resolvedStorage });
    importedPublicKeys = result.kind === 'wallet-export' ? result.publicKeys : [result.publicKey];
    if (result.kind === 'wallet-export') {
      options.stdout.push(
        'Imported wallet export keys successfully.',
        `Account: ${result.address}`,
        `Imported keys: ${result.publicKeys.length}`,
        ...result.publicKeys.map((publicKey) => `Public key: ${publicKey}`),
        `Next: refresh account credentials on the network where this account exists: ccd-config-manager account credentials refresh --address ${result.address} --network <name>`,
      );
    } else {
      options.stdout.push('Imported key successfully.', `Public key: ${result.publicKey}`);
    }
  } else {
    const result = await importLocalEd25519Key({
      label: request.label,
      privateKeyHex: await (options.promptPrivateKey ?? promptPrivateKey)(),
      storage: resolvedStorage,
    });
    importedPublicKeys = [result.publicKey];
    options.stdout.push('Imported key successfully.', `Public key: ${result.publicKey}`);
  }
  options.stdout.push(`Storage: ${resolvedStorage}`);
  if (request.label !== undefined) {
    const inventory = loadSignerInventory();
    let emitted = false;
    for (const publicKey of importedPublicKeys) {
      const stored = Object.entries(inventory.keys)
        .find(([keyRef]) => keyRef === `ed25519:${publicKey}`)?.[1].label;
      if (stored !== undefined) {
        options.stdout.push(`Label: ${parseCatalogLabel(stored).label}`);
        emitted = true;
      }
    }
    if (!emitted) options.stdout.push(`Label: ${normalizeCatalogLabel(request.label)}`);
  }
  return 0;
}

async function runGenerate(options: RunKeyCommandOptions, request: Extract<KeyCommandRequest, { action: 'generate' }>): Promise<number> {
  const storage = parseSoftwareKeyStorageModule(request.storage ?? 'encrypted-file');
  await unlockStorage(options);
  const generated = await generateLocalEd25519Key({
    ...(request.label === undefined ? {} : { label: request.label }),
    storage,
  });
  options.stdout.push(`Public key: ${generated.publicKey}`, `Storage: ${storage}`);
  if (request.label !== undefined) options.stdout.push(`Label: ${normalizeCatalogLabel(request.label)}`);
  return 0;
}

async function promptPrivateKey(): Promise<string> {
  return readHiddenLine(input, output, 'Private key: ');
}

async function promptUnlockPassword(): Promise<string> {
  return readHiddenLine(input, output, 'Signer storage password: ', 'Signer unlock requires an interactive terminal.');
}

async function unlockStorage(options: RunKeyCommandOptions): Promise<void> {
  if (!isEncryptedFileStorageConfigured()) {
    throw new Error(keyCommandMessages.encryptedStorageUninitialized);
  }
  const password = await (options.promptUnlockPassword ?? promptUnlockPassword)();
  unlockEncryptedFileStorage(password);
}
