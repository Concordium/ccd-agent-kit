import { notifyMcpInstancesConfigChanged, type McpConfigRefreshTarget } from '@ccd-agent-kit/config-utils';
import type { Command } from 'commander';

const SIGNER_MUTATIONS = new Set([
  'signing-key generate', 'signing-key import', 'signing-key adopt', 'signing-key forget',
  'signing-key backend order',
  'signing-key locations order', 'signing-key locations forget',
  'storage enable', 'storage disable',
  'service signer module enable', 'service signer module disable',
]);

const ID_MANAGER_MUTATIONS = new Set([
  'service id-manager module enable', 'service id-manager module disable',
  'identity-root generate', 'identity-root import', 'identity-root adopt', 'identity-root forget',
  'identity-root default set',
  'identity-root backend order', 'identity-root locations order', 'identity-root locations forget',
]);

const SHARED_MUTATIONS = new Set([
  'device lock', 'device unlock',
]);

/** Returns the exact MCP runtime domains refreshed after a successful CLI command. */
export function classifyMcpConfigRefreshTargets(
  commandPath: readonly string[],
  options: unknown,
): readonly McpConfigRefreshTarget[] {
  const path = commandPath.join(' ');
  if (SIGNER_MUTATIONS.has(path)) return ['signer'];
  if (ID_MANAGER_MUTATIONS.has(path)) return ['idManager'];
  if (SHARED_MUTATIONS.has(path)) return ['signer', 'idManager'];
  if (hasFixOption(options)) {
    if (path === 'storage integrity') return ['signer'];
    if (path === 'device integrity') return ['signer', 'idManager'];
  }
  return [];
}

/** Adds best-effort post-success config refresh delivery to a Commander root. */
export function registerMcpConfigRefreshHook(program: Command): void {
  program.hook('postAction', async (_command, actionCommand) => {
    const targets = classifyMcpConfigRefreshTargets(commandPath(actionCommand), actionCommand.opts());
    if (targets.length === 0) return;
    try {
      await notifyMcpInstancesConfigChanged(targets);
    } catch {
      // Runtime refresh delivery must not fail an already completed CLI mutation.
    }
  });
}

function commandPath(command: Command): string[] {
  const path: string[] = [];
  for (let current: Command | null = command; current.parent !== null; current = current.parent) {
    path.unshift(current.name());
  }
  return path;
}

function hasFixOption(options: unknown): boolean {
  return typeof options === 'object' && options !== null
    && 'fix' in options && (options as { fix?: unknown }).fix === true;
}
