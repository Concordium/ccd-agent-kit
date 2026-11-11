import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach } from 'vitest';

type XdgName = 'XDG_CONFIG_HOME' | 'XDG_DATA_HOME' | 'XDG_STATE_HOME';

/** Installs isolated repository-local XDG roots for each test and restores the environment afterward. */
export function useTestXdg(prefix: string, names: XdgName[]) {
  const testRoot = path.join(process.cwd(), '.test-tmp');
  let scratch = '';
  let original: Partial<Record<XdgName, string>> = {};

  beforeEach(async () => {
    original = Object.fromEntries(names
      .map(name => [name, process.env[name]])
      .filter((entry): entry is [XdgName, string] => entry[1] !== undefined));
    await mkdir(testRoot, { recursive: true });
    scratch = await mkdtemp(path.join(testRoot, prefix));
    for (const name of names) process.env[name] = path.join(scratch, name.slice(4).toLowerCase());
  });

  afterEach(async () => {
    for (const name of names) {
      const value = original[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(scratch, { recursive: true, force: true });
  });

  return { scratch: () => scratch };
}
