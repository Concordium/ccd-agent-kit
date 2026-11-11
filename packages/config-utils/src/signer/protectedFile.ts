import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { serializeJsonFile } from '@ccd-agent-kit/mcp-utils';

/** Returns whether a protected regular file exists after rejecting unsafe ancestors and targets. */
export function protectedFileExists(filename: string): boolean {
  try {
    lstatSync(filename);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  try {
    if (!validateDirectories(dirname(filename), false)) return false;
    assertProtectedFileDetails(filename);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** Atomically writes JSON after rejecting unsafe existing directories and targets. */
export function writeProtectedJsonAtomic(filename: string, value: unknown, temporaryPrefix: string): void {
  const directory = dirname(filename);
  validateDirectories(directory, true);
  assertSafeTargetIfPresent(filename);
  const temporary = join(directory, `.${temporaryPrefix}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, serializeJsonFile(value), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    assertSafeTargetIfPresent(filename);
    renameSync(temporary, filename);
  } finally { rmSync(temporary, { force: true }); }
}

function assertSafeTargetIfPresent(filename: string): void {
  try {
    assertProtectedFileDetails(filename);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function assertProtectedFileDetails(filename: string): void {
  const details = lstatSync(filename);
  if (!details.isFile() || details.isSymbolicLink() || (details.mode & 0o077) !== 0) {
    throw new Error('Unsafe protected data file.');
  }
}

function validateDirectories(directory: string, create: boolean): boolean {
  const chain: string[] = [];
  for (let current = directory; ; current = dirname(current)) {
    chain.push(current);
    if (dirname(current) === current) break;
  }
  chain.reverse();
  const appRootIndex = chain.findIndex((entry, index) => {
    const namespace = chain[index + 1];
    return basename(entry) === 'ccd-agent-kit' && namespace !== undefined
      && (basename(namespace) === 'signer' || basename(namespace) === 'id-manager');
  });
  const protectedStart = appRootIndex < 0 ? chain.length - 1 : appRootIndex;
  for (const [index, current] of chain.entries()) {
    try {
      const details = lstatSync(current);
      if (!details.isDirectory() || details.isSymbolicLink()
        || (index >= protectedStart && (details.mode & 0o077) !== 0)) {
        throw new Error('Unsafe protected data directory.');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (!create) return false;
      mkdirSync(current, { mode: 0o700 });
    }
  }
  return true;
}
