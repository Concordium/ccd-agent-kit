import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, vi } from 'vitest';
import { makeTestTempDir } from './tempDir.js';

/** Isolates every XDG namespace, including config reads made by runtime modules. */
export function useSignerSandbox(options: { resetNetwork?: boolean } = {}): () => string {
  let root: string;
  beforeEach(() => {
    root = makeTestTempDir('ms-');
    vi.stubEnv('XDG_CONFIG_HOME', join(root, 'config'));
    vi.stubEnv('XDG_DATA_HOME', join(root, 'data'));
    vi.stubEnv('XDG_STATE_HOME', root);
    for (const home of [process.env.XDG_CONFIG_HOME!, process.env.XDG_DATA_HOME!, root]) {
      mkdirSync(join(home, 'ccd-agent-kit'), { recursive: true, mode: 0o700 });
    }
    if (options.resetNetwork) vi.stubEnv('CCD_NETWORK', undefined);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });
  return () => root;
}
