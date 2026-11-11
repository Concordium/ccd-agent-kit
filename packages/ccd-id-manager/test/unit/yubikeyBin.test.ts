import { expect,it,vi } from 'vitest';
import { runCli } from '../../src/cli/index.js';

vi.mock('../../src/cli/index.js', () => ({ runCli: vi.fn(async () => 2) }));

it('passes process arguments to the identity CLI and transfers its exit code', async () => {
  const originalExitCode = process.exitCode;
  try {
    await import('../../src/bin/ccd-id-manager.js');
    expect(runCli).toHaveBeenCalledExactlyOnceWith(process.argv.slice(2));
    expect(process.exitCode).toBe(2);
  } finally {
    process.exitCode = originalExitCode;
  }
});
