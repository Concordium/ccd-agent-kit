import { vi } from 'vitest';
import { runCli } from '../../src/bin/ccd-signer.js';

/** Exercises the public Commander boundary while capturing its process output. */
export async function runCliWithOutput(argv: string[], output: { stdout: string[]; stderr: string[] }): Promise<number> {
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((value) => {
    output.stdout.push(String(value).replace(/\n$/, ''));
    return true;
  });
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((value) => {
    output.stderr.push(String(value).replace(/\n$/, ''));
    return true;
  });
  try {
    return await runCli(argv);
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
  }
}
