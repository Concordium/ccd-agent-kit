import { describe, expect, it, vi } from 'vitest';

import { useSignerSandbox } from '../helpers/sandbox.js';

const entrypointFakes = vi.hoisted(() => ({
  createNativePivYubiKeyService: vi.fn(),
  runMcpServer: vi.fn(),
  startSignerInstanceControlServer: vi.fn(),
}));

vi.mock('@ccd-agent-kit/piv-utils', async (importOriginal) => ({
  ...await importOriginal<typeof import('@ccd-agent-kit/piv-utils')>(),
  createNativePivYubiKeyService: entrypointFakes.createNativePivYubiKeyService,
}));

vi.mock('../../src/mcp/server.js', () => ({ runMcpServer: entrypointFakes.runMcpServer }));

vi.mock('../../src/core/instance/signerInstance.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/core/instance/signerInstance.js')>(),
  startSignerInstanceControlServer: entrypointFakes.startSignerInstanceControlServer,
}));

describe('signer binary entrypoints', () => {
  useSignerSandbox({ resetNetwork: true });

  it('imports the CLI and MCP binaries without process or native-service side effects', async () => {
    const originalArgv = process.argv;
    const originalExitCode = process.exitCode;
    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const stderrWrite = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    process.argv = ['node', '/workspace/bin/ccd-signer', '--help'];
    process.exitCode = 8;

    try {
      await import('../../src/bin/ccd-signer.js');
      await import('../../src/bin/ccd-signer-mcp.js');

      expect(stdoutWrite).not.toHaveBeenCalled();
      expect(stderrWrite).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(8);
      expect(entrypointFakes.runMcpServer).not.toHaveBeenCalled();
      expect(entrypointFakes.createNativePivYubiKeyService).not.toHaveBeenCalled();
      expect(entrypointFakes.startSignerInstanceControlServer).not.toHaveBeenCalled();
    } finally {
      process.argv = originalArgv;
      process.exitCode = originalExitCode;
      stdoutWrite.mockRestore();
      stderrWrite.mockRestore();
    }
  });
});
