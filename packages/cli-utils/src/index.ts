import type { EventEmitter } from 'node:events';
import type { Command, CommanderError } from 'commander';
import type { ZodType } from 'zod';
export type UsageErrorFactory = (message: string) => Error;

interface HiddenInput extends EventEmitter {
  isRaw?: boolean;
  isTTY?: boolean;
  off(eventName: 'data' | 'error', listener: (...args: any[]) => void): this;
  on(eventName: 'data' | 'error', listener: (...args: any[]) => void): this;
  pause(): void;
  resume(): void;
  setRawMode(mode: boolean): void;
}

interface HiddenOutput {
  write(chunk: string): void;
}

/**
 * Run a CLI only when Node identifies its module as the executable entrypoint.
 *
 * @param isMain - The caller's native `import.meta.main` value.
 * @param run - Command handler receiving process arguments without the executable paths.
 * @returns Resolves after recording the handler's exit code; runner failures propagate unchanged.
 */
export async function runCliEntrypoint(isMain: boolean, run: (argv: string[]) => Promise<number>): Promise<void> {
  if (isMain) process.exitCode = await run(process.argv.slice(2));
}

/**
 * Maps a Commander control-flow error to the CCD CLI exit-code policy.
 *
 * @param error - The Commander error raised while parsing or running a command.
 * @returns Zero for successful control flow, the original status for CCD command
 * failures, or two for all other parser and usage failures.
 */
export function commanderExitCode(error: CommanderError): number {
  if (error.exitCode === 0) return 0;
  return error.code === 'ccd.commandFailed' ? error.exitCode : 2;
}

/**
 * Disables Commander's generated help subcommand throughout a completed command tree.
 *
 * Help flags such as `-h` and `--help` remain enabled.
 *
 * @param command - The root of the fully registered command tree.
 */
export function disableHelpCommands(command: Command): void {
  command.addHelpCommand(false);
  for (const child of command.commands) disableHelpCommands(child);
}

/** Validates parsed CLI option objects and throws the first user-facing issue message on failure. */
export function validateCliOptions<T>(schema: ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (result.success) {
    return result.data;
  }

  throw new Error(result.error.issues[0].message);
}

/** Reads all data from process stdin as UTF-8 text. */
export async function readProcessStdin(): Promise<string> {
  const chunks: Buffer[] = [];

  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }

  return Buffer.concat(chunks).toString('utf8');
}

/** Parses a JSON CLI option as unknown data, converting parse errors into the caller's usage error. */
export function parseJsonCliValue(value: string, error: string, usageError: UsageErrorFactory): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw usageError(error);
  }
}

/** Reads one secret line from an interactive terminal without echoing typed characters. */
export async function readHiddenLine(
  inputStream: HiddenInput,
  outputStream: HiddenOutput,
  prompt: string,
  nonInteractiveMessage = 'Private-key import requires an interactive terminal.',
): Promise<string> {
  if (!inputStream.isTTY) {
    throw new Error(nonInteractiveMessage);
  }

  outputStream.write(prompt);

  return new Promise((resolve, reject) => {
    let secret = '';
    const previousRawMode = inputStream.isRaw;

    const cleanup = () => {
      inputStream.off('data', onData);
      inputStream.off('error', onError);
      if (inputStream.isTTY) {
        inputStream.setRawMode(Boolean(previousRawMode));
      }
      inputStream.pause();
    };

    const finish = (callback: () => void) => {
      cleanup();
      outputStream.write('\n');
      callback();
    };

    const onError = (error: Error) => finish(() => reject(error));

    const onData = (chunk: Buffer | string) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');

      for (const character of text) {
        if (character === '\u0003') {
          finish(() => reject(new Error('Private-key entry cancelled.')));
          return;
        }

        if (character === '\r' || character === '\n') {
          finish(() => resolve(secret.trim()));
          return;
        }

        if (character === '\u007f') {
          secret = secret.slice(0, -1);
          continue;
        }

        secret += character;
      }
    };

    inputStream.setRawMode(true);
    inputStream.resume();
    inputStream.on('data', onData);
    inputStream.on('error', onError);
  });
}
