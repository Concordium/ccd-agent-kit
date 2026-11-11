#!/usr/bin/env node

import { runCliEntrypoint } from '@ccd-agent-kit/cli-utils';
import { getNetworksFilePath, listNetworks } from '@ccd-agent-kit/config-utils';
import { parseConfig } from '../config.js';
import { createServerFactory } from '../mcp/server.js';
import { startStartupRefresh } from '../mcp/startupRefresh.js';
import { createCachingNetworkClientProvider } from '../mcp/toolPlumbing/networkClient.js';
import { startHttp } from '../mcp/transports/httpTransport.js';
import { startStdio } from '../mcp/transports/stdioTransport.js';

export interface ChainClientMcpIo {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

/** Returns the `ccd-chain-client-mcp` command help text. */
export function helpText(): string {
  return ['Usage: ccd-chain-client-mcp', '', 'Starts the CCD chain MCP server over stdio or HTTP.'].join('\n');
}

/** Entrypoint: reads env, parses config, creates client, starts transport. */
export const main = async (
  argv: string[] = process.argv.slice(2),
  env: Record<string, string | undefined> = process.env,
  io: ChainClientMcpIo = { stdout: console.log, stderr: console.error },
): Promise<number> => {
  if (argv.includes('--help') || argv.includes('-h')) {
    io.stdout(helpText());
    return 0;
  }

  const restoreEnv = useProcessEnv(env);
  const parsed = parseConfig(env);
  if (!parsed.ok) {
    for (const message of parsed.errors) {
      io.stderr(`ccd-chain-client-mcp: config error: ${message}`);
    }
    writeStartupDiagnostics(io);
    restoreEnv();
    return 1;
  }

  const config = parsed.value;
  const clients = createCachingNetworkClientProvider(config);
  const serverFactory = createServerFactory({ config, clients });
  startStartupRefresh({ config, clients, stderr: io.stderr });

  try {
    if (config.transport === 'http') {
      await startHttp(config, serverFactory);
    } else {
      await startStdio(serverFactory);
    }
  } catch (error) {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    io.stderr(`ccd-chain-client-mcp: startup failed: ${message}`);
    restoreEnv();
    return 1;
  }

  restoreEnv();
  return 0;
};

function useProcessEnv(env: Record<string, string | undefined>): () => void {
  if (env === process.env) {
    return () => undefined;
  }

  const originalEnv = process.env;
  process.env = { ...originalEnv, ...env };
  return () => {
    process.env = originalEnv;
  };
}

function writeStartupDiagnostics(io: Pick<ChainClientMcpIo, 'stderr'>): void {
  io.stderr(`ccd-chain-client-mcp: network config: ${getNetworksFilePath()}`);
  io.stderr(`ccd-chain-client-mcp: available networks: ${listNetworks().join(', ') || '(none)'}`);
  io.stderr('ccd-chain-client-mcp: Set CCD_NETWORK to an available network or update the ccd-agent-kit network registry.');
}

// Runs only when executed as the `ccd-chain-client-mcp` binary; importing this
// module (e.g. from tests) does not start a server.
await runCliEntrypoint(import.meta.main, main);

export * from '../concordium/client.js';
export * from '../config.js';
