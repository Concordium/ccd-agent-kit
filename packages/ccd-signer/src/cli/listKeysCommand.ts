import { listSignerKeys } from '../core/keys/listSignerKeys.js';

/** Buffered output for the parameterless key-listing command. */
export interface RunListKeysCommandOptions {
  stderr: string[];
  stdout: string[];
}

/** Runs the `ccd-signer list-keys` command. */
export async function runListKeysCommand(options: RunListKeysCommandOptions): Promise<number> {
  options.stdout.push(JSON.stringify(listSignerKeys(), null, 2));
  return 0;
}
