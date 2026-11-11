import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, vi } from 'vitest';
import { makeTestTempDir } from './tempDir.js';

export function useConfigSandbox(): void {
  let root: string;
  beforeEach(() => {
    root = makeTestTempDir('config-');
    for (const name of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME']) {
      vi.stubEnv(name, join(root, name));
    }
    // Keep Unix-domain socket paths below the macOS length limit.
    vi.stubEnv('XDG_RUNTIME_DIR', root);
    vi.stubEnv('CCD_NETWORK', '');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });
}
