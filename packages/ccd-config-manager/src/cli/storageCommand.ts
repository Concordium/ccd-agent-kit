import { stdin as input, stdout as output } from 'node:process';
import { readHiddenLine } from '@ccd-agent-kit/cli-utils';

import {
  changeEncryptedFileStoragePassword,
  initializeEncryptedFileStorage,
  isEncryptedFileStorageConfigured,
  isEncryptedFileStorageUnlocked,
  lockEncryptedFileStorage,
  unlockEncryptedFileStorage,
  checkEncryptedFileIntegrity,
  ENCRYPTED_FILE_STORAGE_MODULE_ID,
  isSoftwareStorageModuleEnabled,
  parseSoftwareKeyStorageModule,
  setSoftwareStorageModulePolicy,
  type EncryptedFileIntegrityReport,
} from '@ccd-agent-kit/config-utils';

/** Typed storage-management request and injectable command IO. */
export interface RunStorageCommandOptions {
  request: StorageCommandRequest;
  stderr: string[];
  stdout: string[];
  promptPassword?: (prompt: string) => Promise<string>;
}

/** Operational request accepted by the software storage command after Commander parsing. */
export type StorageCommandRequest =
  | { action: 'status' }
  | { action: 'inspect'; backend: string }
  | { action: 'enable'; backend: string }
  | { action: 'disable'; backend: string }
  | { action: 'init'; backend: string }
  | { action: 'change-password'; backend: string }
  | { action: 'integrity'; backend: string; fix: boolean };

/** User-facing messages owned by the software storage command. */
export const storageCommandMessages = {
  passwordMismatch: 'New encrypted-file passwords do not match.',
} as const;

/** Runs signer key-storage backend lifecycle and configuration commands. */
export async function runStorageCommand(options: RunStorageCommandOptions): Promise<number> {
  try {
    switch (options.request.action) {
      case 'status':
        return await runStatus(options);
      case 'inspect':
        return runInspect(options, options.request.backend);
      case 'init':
        return await initBackend(options, options.request.backend);
      case 'change-password':
        return await changeBackendPassword(options, options.request.backend);
      case 'enable':
        return setBackendPolicy(options, options.request.backend, 'enabled');
      case 'disable':
        return setBackendPolicy(options, options.request.backend, 'disabled');
      case 'integrity':
        return await checkBackendIntegrity(options, options.request.backend, options.request.fix);
    }
  } catch (error) {
    options.stderr.push(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

function runInspect(options: RunStorageCommandOptions, backend: string): number {
  const parsed = parseSoftwareKeyStorageModule(backend);
  options.stdout.push(JSON.stringify({
    storage: parsed,
    policy: isSoftwareStorageModuleEnabled(parsed) ? 'enabled' : 'disabled',
    readiness: encryptedFileReadiness(),
  }, null, 2));
  return 0;
}

async function runStatus(options: RunStorageCommandOptions): Promise<number> {
  options.stdout.push(
    JSON.stringify(
      {
        backends: {
          [ENCRYPTED_FILE_STORAGE_MODULE_ID]: {
            policy: isSoftwareStorageModuleEnabled(ENCRYPTED_FILE_STORAGE_MODULE_ID) ? 'enabled' : 'disabled',
            readiness: encryptedFileReadiness(),
          },
        },
      },
      null,
      2,
    ),
  );
  return 0;
}

async function initBackend(options: RunStorageCommandOptions, backend: string): Promise<number> {
  parseSoftwareKeyStorageModule(backend);
  const password = await promptNewPassword(options);
  initializeEncryptedFileStorage(password);
  options.stdout.push('Encrypted-file storage initialized.');
  return 0;
}

async function changeBackendPassword(options: RunStorageCommandOptions, backend: string): Promise<number> {
  parseSoftwareKeyStorageModule(backend);
  const currentPassword = await promptPassword(options, 'Current encrypted-file password: ');
  const newPassword = await promptNewPassword(options);
  changeEncryptedFileStoragePassword(currentPassword, newPassword);
  lockEncryptedFileStorage();
  options.stdout.push('Encrypted-file storage password changed.');
  return 0;
}

function setBackendPolicy(options: RunStorageCommandOptions, backend: string, policy: 'enabled' | 'disabled'): number {
  const parsed = parseSoftwareKeyStorageModule(backend);
  setSoftwareStorageModulePolicy(parsed, policy);
  options.stdout.push(`Software storage module ${parsed}: ${policy}`);
  return 0;
}

async function checkBackendIntegrity(options: RunStorageCommandOptions, backend: string, fix: boolean): Promise<number> {
  parseSoftwareKeyStorageModule(backend);
  if (!isEncryptedFileStorageConfigured()) throw new Error('Encrypted-file storage is not initialized. Run: ccd-config-manager storage init --storage encrypted-file');
  unlockEncryptedFileStorage(await promptPassword(options, 'Encrypted-file storage password: '));
  options.stdout.push(renderIntegrityReport(await checkEncryptedFileIntegrity({ fix }), fix));
  return 0;
}

function renderIntegrityReport(report: EncryptedFileIntegrityReport, fixed: boolean): string {
  const lines = [fixed ? 'Encrypted-file storage integrity repaired.' : 'Encrypted-file storage integrity', ''];
  lines.push('Inventory references:');
  lines.push(`  OK: ${report.okReferences.length}`);
  lines.push(`  Missing files: ${report.missingReferences.length}`);
  lines.push(`  Invalid files: ${report.invalidEntries.length}`);
  for (const finding of report.missingReferences) lines.push(`  Missing reference: ${finding.publicKey}`);
  lines.push('', 'Storage files:');
  lines.push(`  Orphaned adoptable: ${report.adoptableOrphans.length}`);
  for (const finding of report.adoptableOrphans) {
    lines.push(`  Adoptable orphan: ${finding.publicKey}`);
    lines.push(`    Adopt: ccd-config-manager signing-key adopt --backend software --storage encrypted-file --public-key ${finding.publicKey}`);
  }
  if (report.invalidEntries.length > 0) {
    lines.push('', 'Skipped:');
    for (const finding of report.invalidEntries) lines.push(`  Invalid entry: ${finding.publicKey}`);
  }
  if (fixed) {
    lines.push('', 'Applied safe repairs:');
    lines.push(`  Pruned missing references: ${report.prunedMissingReferences.length}`);
    for (const finding of report.prunedMissingReferences) lines.push(`  Pruned missing reference: ${finding.publicKey}`);
  } else {
    lines.push('', 'No changes made. Run with --fix to apply safe repairs.');
  }
  return lines.join('\n');
}

function encryptedFileReadiness(): string {
  if (!isEncryptedFileStorageConfigured()) return 'uninitialized';
  return isEncryptedFileStorageUnlocked() ? 'ready' : 'locked';
}

async function promptNewPassword(options: RunStorageCommandOptions): Promise<string> {
  const password = await promptPassword(options, 'New encrypted-file password: ');
  const repeated = await promptPassword(options, 'Repeat new encrypted-file password: ');
  if (password !== repeated) {
    throw new Error(storageCommandMessages.passwordMismatch);
  }
  return password;
}

async function promptPassword(options: RunStorageCommandOptions, prompt: string): Promise<string> {
  return (options.promptPassword ?? ((line) => readHiddenLine(input, output, line, 'Storage password input requires an interactive terminal.')))(prompt);
}
