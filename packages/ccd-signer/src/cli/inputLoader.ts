import { readFile } from 'node:fs/promises';
import { readProcessStdin } from '@ccd-agent-kit/cli-utils';

/** Signer CLI input sources shared by commands that accept direct, file, or stdin input. */
export type CliInputSource =
  | { kind: 'input'; value: string }
  | { kind: 'input-file'; path: string }
  | { kind: 'stdin' };

/** Error raised when a command receives zero or multiple input sources. */
export class CliInputSourceError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'CliInputSourceError';
  }
}

/** Resolves exactly one direct, file, or stdin input source before any file or stdin IO. */
export function resolveCliInputSource(
  values: { input?: string; inputFile?: string; stdin?: boolean },
  message: string,
): CliInputSource {
  const count = Number(Boolean(values.input)) + Number(Boolean(values.inputFile)) + Number(values.stdin === true);
  if (count !== 1) throw new CliInputSourceError(message);
  if (values.input !== undefined) return { kind: 'input', value: values.input };
  if (values.inputFile !== undefined) return { kind: 'input-file', path: values.inputFile };
  return { kind: 'stdin' };
}

/** Loads a resolved signer CLI input source, preserving exact bytes as UTF-8 text. */
export async function loadCliInputSource(source: CliInputSource, injectedStdin?: string): Promise<string> {
  switch (source.kind) {
    case 'input':
      return source.value;
    case 'input-file':
      return readFile(source.path, 'utf8');
    case 'stdin':
      return injectedStdin !== undefined ? injectedStdin : readProcessStdin();
  }
}
