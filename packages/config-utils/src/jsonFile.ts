import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { serializeJsonFile } from '@ccd-agent-kit/mcp-utils';

/** Reads and validates local JSON; missing, unreadable, or malformed files use the caller's default. */
export function readJsonFile<T>(filePath: string, normalize: (value: unknown) => T | undefined): T | undefined {
  try {
    return normalize(JSON.parse(readFileSync(filePath, 'utf8')) as unknown);
  } catch {
    return undefined;
  }
}

/** Writes pretty-printed JSON with a trailing newline; directory and write failures propagate. */
export function writeJsonFile(filePath: string, value: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  writeFileSync(filePath, serializeJsonFile(value), 'utf8');
}

/** Narrows JSON objects without accepting null or arrays. */
export function isStringRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
