import { z } from 'zod';
import { stringifyBigInt } from '@ccd-agent-kit/mcp-utils';
import { validateCliOptions } from '@ccd-agent-kit/cli-utils';

import { describeTransaction } from '../core/describe/describeTransaction.js';
import { ParseTransactionError, parseTransaction } from '../core/parser/parseTransaction.js';
import { projectParsedTransaction } from '../core/model/projectParsedTransaction.js';
import { loadCliInputSource, resolveCliInputSource, type CliInputSource } from './inputLoader.js';

/**
 * The supported output formats for the describe command.
 */
export type DescribeOutputFormat = 'json' | 'text';

/** Typed request accepted by the describe domain handler after Commander parsing. */
export interface DescribeCommandRequest {
  /** Resolved transaction input source. */
  source: CliInputSource;
  /** Selected output format. */
  output: DescribeOutputFormat;
}

/**
 * Runtime hooks used by the CLI command implementation.
 */
export interface RunDescribeCommandOptions {
  /** Typed request from the Commander adapter. */
  request: DescribeCommandRequest;
  /** Optional stdin content for tests and non-process callers. */
  stdin?: string;
  /** Receives stdout lines. */
  stdout: string[];
  /** Receives stderr lines. */
  stderr: string[];
}

/** User-facing messages owned by the transaction description CLI command. */
export const describeCommandMessages = {
  singleInputSourceRequired: 'A single input source must be provided via --input, --input-file, or --stdin.',
} as const;

/**
 * Error raised for CLI usage problems.
 */
export class CliUsageError extends Error {
  /**
   * Creates a CLI usage error.
   *
   * @param message - The usage error message.
   */
  public constructor(message: string) {
    super(message);
    this.name = 'CliUsageError';
  }
}

/** Builds a describe request from already parsed CLI option values. */
export function createDescribeCommandRequest(options: { input?: string; inputFile?: string; stdin?: boolean; output?: string }): DescribeCommandRequest {
  try {
    const output = validateCliOptions(z.object({ output: z.enum(['json', 'text']).default('json') }), { output: options.output }).output;
    return { output, source: resolveCliInputSource(options, describeCommandMessages.singleInputSourceRequired) };
  } catch (error) {
    throw new CliUsageError(error instanceof Error ? error.message : String(error));
  }
}

/**
 * Runs the `describe` command and returns its process exit code.
 *
 * @param options - The runtime command options.
 * @returns A promise resolving to the command exit code.
 */
export async function runDescribeCommand(options: RunDescribeCommandOptions): Promise<number> {
  try {
    const rawInput = await loadCliInputSource(options.request.source, options.stdin);
    const transaction = parseTransaction(rawInput);

    options.stdout.push(
      options.request.output === 'json'
        ? JSON.stringify(stringifyBigInt(projectParsedTransaction(transaction)))
        : describeTransaction(transaction),
    );

    return 0;
  } catch (error) {
    if (error instanceof ParseTransactionError) {
      options.stderr.push(error.message);
      return 1;
    }

    throw error;
  }
}
