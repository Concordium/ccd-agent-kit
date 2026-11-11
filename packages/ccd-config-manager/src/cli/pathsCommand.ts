import {
  getAccountCredentialsPathForNetwork,
  getAccountLabelsPath,
  getAccountLabelsPathForNetwork,
  getActiveNetwork,
  getConfigDir,
  getDataDir,
  getNetworksFilePath,
  getSignerConfigPath,
  getSignerDataDir,
  getSignerInventoryPath,
  getSignerKeyStorageDir,
  getSignerYubiKeyConfigPath,
  getYubiKeyRegistrationsPath,
  getStateDir,
  resolveNetwork,
} from '@ccd-agent-kit/config-utils';
import { caip2Reference } from '../core/grpc.js';

export interface RunPathsCommandOptions {
  request: PathsCommandRequest;
  stdout: string[];
  stderr: string[];
}

/** Domain-owned typed request for printing shared configuration paths after Commander parsing. */
export interface PathsCommandRequest {
  network?: string;
}

/** One printed path entry: its label, resolved path, and the consumers that read or write it. */
interface PathEntry {
  label: string;
  path: string;
  consumers: string[];
}

/** Writes one path entry, and optionally the blank line that separates it from the next entry. */
function pushPathEntry(stdout: string[], entry: PathEntry, separator: boolean): void {
  if (separator) stdout.push('');
  stdout.push(`  ${entry.label}`);
  stdout.push(`    ${entry.path}`);
  stdout.push(`    used by: ${entry.consumers.join(', ')}`);
}

/** Prints human-readable shared configuration paths. */
export async function runPathsCommand(options: RunPathsCommandOptions): Promise<number> {
  let networkName: string;
  let networkSource: string;
  let caip2Ref: string;

  try {
    const selected = options.request.network;
    if (selected === undefined) {
      const active = getActiveNetwork();
      networkName = active.name;
      networkSource = active.source === 'session' ? 'session (CCD_NETWORK)' : 'config';
      caip2Ref = caip2Reference(active.config.caip2);
    } else {
      const resolved = resolveNetwork(selected);
      networkName = resolved.name;
      networkSource = 'explicit';
      caip2Ref = caip2Reference(resolved.config.caip2);
    }
  } catch (error) {
    options.stderr.push(error instanceof Error ? error.message : String(error));
    return 2;
  }

  const entries: PathEntry[] = [
    { label: 'Network registry [config]', path: getNetworksFilePath(), consumers: ['ccd-config-manager (w)', 'ccd-signer', 'ccd-chain-client-mcp'] },
    { label: 'Account labels [data]', path: getAccountLabelsPathForNetwork(caip2Ref), consumers: ['ccd-config-manager (w)', 'ccd-signer', 'ccd-chain-client-mcp'] },
    { label: 'Account label index [state]', path: getAccountLabelsPath(), consumers: ['ccd-config-manager (w)'] },
    {
      label: 'Account credentials [state]',
      path: getAccountCredentialsPathForNetwork(caip2Ref),
      consumers: ['ccd-config-manager (w)', 'ccd-signer', 'ccd-chain-client-mcp (w)'],
    },
    { label: 'Signer config [config]', path: getSignerConfigPath(), consumers: ['ccd-config-manager (w)', 'ccd-signer (w)'] },
    { label: 'Signer data root [data]', path: getSignerDataDir(), consumers: ['ccd-config-manager (w)', 'ccd-signer'] },
    { label: 'Signer inventory [data]', path: getSignerInventoryPath(), consumers: ['ccd-config-manager (w)', 'ccd-signer'] },
    { label: 'Signer key-storage metadata [data]', path: getSignerKeyStorageDir(), consumers: ['ccd-config-manager (w)', 'ccd-signer'] },
    { label: 'YubiKey registry [data]', path: getYubiKeyRegistrationsPath(), consumers: ['ccd-config-manager (w)', 'ccd-signer', 'ccd-id-manager'] },
    { label: 'YubiKey defaults [config]', path: getSignerYubiKeyConfigPath(), consumers: ['ccd-config-manager (w)'] },
  ];

  options.stdout.push('Legend: (w) = writes');
  options.stdout.push('');
  options.stdout.push('Base directories:');
  options.stdout.push(`  Config: ${getConfigDir()}`);
  options.stdout.push(`  Data:   ${getDataDir()}`);
  options.stdout.push(`  State:  ${getStateDir()}`);
  options.stdout.push('');
  options.stdout.push('Active network:');
  options.stdout.push(`  Name:           ${networkName}`);
  options.stdout.push(`  Default source: ${networkSource}`);
  options.stdout.push(`  CAIP-2 ref:     ${caip2Ref}`);
  options.stdout.push('');
  options.stdout.push('Paths:');
  for (const [index, entry] of entries.entries()) {
    pushPathEntry(options.stdout, entry, index > 0);
  }
  return 0;
}
