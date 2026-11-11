import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { setupCliTestEnv } from '../helpers/testEnv.js';

describe('setupCliTestEnv', () => {
  it('sandboxes and restores an existing runtime directory with the other XDG paths', () => {
    const originalRuntime = process.env.XDG_RUNTIME_DIR;
    const existingRuntime = join(process.cwd(), '.test-tmp', 'existing-runtime');
    let env: ReturnType<typeof setupCliTestEnv> | undefined;

    try {
      process.env.XDG_RUNTIME_DIR = existingRuntime;
      env = setupCliTestEnv('cli-env-');
      const sandboxRoot = dirname(process.env.XDG_CONFIG_HOME!);
      expect(process.env.XDG_RUNTIME_DIR).toBe(join(sandboxRoot, 'runtime'));
      expect(process.env.XDG_RUNTIME_DIR).not.toBe(existingRuntime);
      env.restore();
      env = undefined;
      expect(process.env.XDG_RUNTIME_DIR).toBe(existingRuntime);
      expect(existsSync(sandboxRoot)).toBe(false);
    } finally {
      env?.restore();
      if (originalRuntime === undefined) delete process.env.XDG_RUNTIME_DIR;
      else process.env.XDG_RUNTIME_DIR = originalRuntime;
    }
  });
});
