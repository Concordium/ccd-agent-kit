import { mkdirSync, mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';

export function makeTestTempDir(prefix: string): string {
  const root = resolve(process.cwd(), '../..', '.test-tmp');
  mkdirSync(root, { recursive: true });
  return mkdtempSync(join(root, prefix));
}
