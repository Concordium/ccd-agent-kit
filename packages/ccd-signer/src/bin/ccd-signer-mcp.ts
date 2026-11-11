#!/usr/bin/env node

import { runCliEntrypoint } from '@ccd-agent-kit/cli-utils';
import { getActiveNetwork, getNetworksFilePath, listNetworks } from '@ccd-agent-kit/config-utils';

import { runMcpServer } from '../mcp/server.js';

export interface SignerMcpBinIo {
  stdout: (line: string) => void;
  stderr?: (line: string) => void;
}

/** Returns the `ccd-signer-mcp` command help text. */
export function signerMcpHelpText(): string {
  return ['Usage: ccd-signer-mcp', '', 'Starts the CCD signer MCP server over stdio.'].join('\n');
}

/** Runs the `ccd-signer-mcp` executable command. */
export async function runCcdSignerMcp(
  argv: string[] = process.argv.slice(2),
  io: SignerMcpBinIo = {
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
  },
): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    io.stdout(signerMcpHelpText());
    return 0;
  }

  try {
    getActiveNetwork();
    await runMcpServer();
    return 0;
  } catch (error) {
    writeStartupDiagnostics('ccd-signer-mcp', error, io);
    return 1;
  }
}

function writeStartupDiagnostics(serverName: string, error: unknown, io: Pick<SignerMcpBinIo, 'stderr'>): void {
  const stderr = io.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));
  const message = error instanceof Error ? error.message : String(error);
  stderr(`${serverName}: startup failed: ${message}`);
  stderr(`${serverName}: network config: ${getNetworksFilePath()}`);
  stderr(`${serverName}: available networks: ${listNetworks().join(', ') || '(none)'}`);
  stderr(`${serverName}: Set CCD_NETWORK to an available network or update the ccd-agent-kit network registry.`);
}

await runCliEntrypoint(import.meta.main, runCcdSignerMcp);
