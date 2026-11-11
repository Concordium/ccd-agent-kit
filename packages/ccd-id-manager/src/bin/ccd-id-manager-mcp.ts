#!/usr/bin/env node

import { runCliEntrypoint } from '@ccd-agent-kit/cli-utils';

/** I/O injection boundary for the identity MCP executable. */
export interface IdentityMcpBinIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

/** Return help without constructing native hardware or network dependencies. */
export function identityMcpHelpText(): string {
  return ['Usage: ccd-id-manager-mcp', '', 'Starts the identity MCP server over stdio.'].join('\n');
}

/** Run the stdio identity MCP executable; unexpected arguments are usage errors. */
export async function runCcdIdentityManagerMcp(
  argv: string[] = process.argv.slice(2),
  io: IdentityMcpBinIo = {
    stdout: (text) => process.stdout.write(`${text}\n`),
    stderr: (text) => process.stderr.write(`${text}\n`),
  },
): Promise<0 | 1 | 2> {
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) {
    io.stdout(identityMcpHelpText());
    return 0;
  }
  if (argv.length !== 0) {
    io.stderr('Invalid command usage. Run ccd-id-manager-mcp --help.');
    return 2;
  }
  try {
    const { runIdentityMcpServer } = await import('../mcp/server.js');
    await runIdentityMcpServer();
    return 0;
  } catch {
    io.stderr('ccd-id-manager-mcp: startup failed.');
    return 1;
  }
}

await runCliEntrypoint(import.meta.main, runCcdIdentityManagerMcp);
