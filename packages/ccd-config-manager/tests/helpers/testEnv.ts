import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { makeTestTempDir } from '../helpers/tempDir.js';

export interface CliTestEnv {
  stderr: string[];
  stdout: string[];
  restore(): void;
}

export function setupCliTestEnv(prefix: string): CliTestEnv {
  const tempDir = makeTestTempDir(prefix);
  const originalEnv = { ...process.env };
  process.env = {
    ...originalEnv,
    XDG_CONFIG_HOME: join(tempDir, 'config'),
    XDG_DATA_HOME: join(tempDir, 'data'),
    XDG_RUNTIME_DIR: join(tempDir, 'runtime'),
    XDG_STATE_HOME: join(tempDir, 'state'),
  };
  delete process.env.CCD_NETWORK;

  return {
    stderr: [],
    stdout: [],
    restore() {
      process.env = originalEnv;
      rmSync(tempDir, { recursive: true, force: true });
    },
  };
}
