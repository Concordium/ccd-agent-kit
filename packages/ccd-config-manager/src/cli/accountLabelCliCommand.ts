import {
  findAccountLabelForAddress,
  findAccountLabelScopes,
  findCatalogLabel,
  loadAccountLabels,
  loadNetworks,
  normalizeCatalogLabel,
  parseCatalogLabel,
  type NetworksFile,
  resolveNetworkFromRegistry,
  setAccountLabel,
} from '@ccd-agent-kit/config-utils';
import { CommanderError, type Command } from 'commander';
import { z } from 'zod';
import { caip2Reference } from '../core/grpc.js';

interface Scope { name: string; caip2: string }
type ReadScopeSelection = { kind: 'single'; scope: Scope } | { kind: 'all'; scopes: Scope[] };

const readOptionsShape = { network: z.string().optional(), allNetworks: z.boolean().optional() };
const listOptionsSchema = z.looseObject(readOptionsShape);
const inspectOptionsSchema = z.looseObject({
  ...readOptionsShape, label: z.string().transform((value) => normalizeCatalogLabel(value)),
});
const findOptionsSchema = z.looseObject({ ...readOptionsShape, address: z.string() });
const modeSchema = z.enum(['hard', 'soft']).catch(() => { throw new Error("Mode must be 'hard' or 'soft'."); });
const setOptionsSchema = z.looseObject({
  address: z.string(), mode: modeSchema.optional(),
  label: z.string().transform((value) => normalizeCatalogLabel(value)).optional(), network: z.string().optional(),
});
const removeOptionsSchema = z.looseObject({ address: z.string(), network: z.string().optional() });

/**
 * Registers network-scoped account-label reads and hard/soft mutations.
 * Read selectors resolve against one registry snapshot; mutations delegate label policy to the config owner.
 */
export function registerAccountLabelCliCommand(input: { program: Command; stdout: string[]; stderr: string[] }): void {
  const parent = input.program.commands.find(command => command.name() === 'account')
    ?? input.program.command('account').description('Manage accounts.');
  const account = parent.command('label').description('Manage network-scoped hard and soft account labels.');
  const readOptions = (command: Command) => command.option('--network <name>').option('--all-networks');

  readOptions(account.command('list').description('List account labels for one network or all networks.'))
    .action((rawOptions: unknown) => readAction(input, () => {
      const options = listOptionsSchema.parse(rawOptions);
      const selection = readScopeSelection(input, options);
      const scopes = selection.kind === 'all' ? selection.scopes : [selection.scope];
      if (selection.kind === 'all') input.stdout.push('Account labels by network:', '');
      for (const scope of scopes) {
        const entries = Object.entries(loadAccountLabels(scope.caip2))
          .map(([stored, address]) => [parseCatalogLabel(stored).label, address] as const)
          .sort(([a], [b]) => a.localeCompare(b));
        input.stdout.push(selection.kind === 'all' ? `${scope.name}:` : `Account labels for ${scope.name}:`, '');
        if (entries.length === 0) input.stdout.push(selection.kind === 'all' ? '  No account labels configured.' : `No account labels configured for ${scope.name}.`);
        else for (const [label, address] of entries) input.stdout.push(`  ${label.padEnd(16)} ${address}`);
      }
    }));
  readOptions(account.command('inspect').description('Inspect the address for an account label.').requiredOption('--label <label>'))
    .action((rawOptions: unknown) => readAction(input, () => {
      const options = inspectOptionsSchema.parse(rawOptions);
      const selection = readScopeSelection(input, options);
      if (selection.kind === 'single') {
        const match = findAccountLabelMatch(options.label, selection.scope.caip2);
        if (match !== undefined) {
          writeMatch(input.stdout, match.label, match.address, selection.scope, false);
          return;
        }
        const message = `Account label '${options.label}' is not configured for ${selection.scope.name}.`;
        input.stderr.push(message);
        const elsewhere = findAccountLabelScopes(options.label)
          .filter((match) => match.network !== selection.scope.name).map((match) => match.network);
        if (elsewhere.length > 0) input.stderr.push(`It exists for ${networkList(elsewhere)}.`);
        throw new CommanderError(1, 'ccd.commandFailed', message);
      }
      const matches = selection.scopes.flatMap((scope) => {
        const match = findAccountLabelMatch(options.label, scope.caip2);
        return match === undefined ? [] : [{ ...scope, ...match }];
      });
      if (matches.length === 0) {
        const message = `Account label '${options.label}' is not configured on any network.`;
        input.stderr.push(message);
        throw new CommanderError(1, 'ccd.commandFailed', message);
      }
      input.stdout.push(`Account label '${options.label}':`, '');
      for (const match of matches) writeMatch(input.stdout, match.label, match.address, match, true);
    }));
  readOptions(account.command('find').description('Find account labels for an address.').requiredOption('--address <address>'))
    .action((rawOptions: unknown) => readAction(input, () => {
      const options = findOptionsSchema.parse(rawOptions);
      const selection = readScopeSelection(input, options);
      if (selection.kind === 'single') {
        const label = findAccountLabelForAddress(options.address, selection.scope.caip2);
        if (label === undefined) fail(input, `Address has no account label for ${selection.scope.name}.`);
        writeMatch(input.stdout, label, options.address, selection.scope, false);
        return;
      }
      const matches = selection.scopes.flatMap((scope) => {
        const label = findAccountLabelForAddress(options.address, scope.caip2);
        return label === undefined ? [] : [{ name: scope.name, label }];
      });
      if (matches.length === 0) fail(input, 'Address has no account label on any network.');
      input.stdout.push('Address matches:', '');
      for (const match of matches) input.stdout.push(`${match.name}:`, `  ${match.label}`);
    }));

  account.command('set').description('Set, relabel, or convert an account label; omitted label preserves its text.')
    .requiredOption('--address <address>').option('--mode <hard|soft>').option('--label <label>').option('--network <name>')
    .action((rawOptions: unknown) => {
      const options = setOptionsSchema.parse(rawOptions);
      const caip2 = scope(options.network, loadNetworks()).caip2;
      const result = setAccountLabel({ address: options.address,
        ...(options.label === undefined ? {} : { label: options.label }),
        ...(options.mode === undefined ? {} : { mode: options.mode }) }, caip2);
      if (result !== undefined) input.stdout.push(JSON.stringify({ address: options.address, ...result }, null, 2));
    });
  account.command('remove').description('Remove every alias-equivalent label for an account on one network.')
    .requiredOption('--address <address>').option('--network <name>')
    .action((rawOptions: unknown) => {
      const options = removeOptionsSchema.parse(rawOptions);
      setAccountLabel({ address: options.address, operation: 'remove' }, scope(options.network, loadNetworks()).caip2);
      input.stdout.push(JSON.stringify({ address: options.address }, null, 2));
    });
}

function readAction(input: { stdout: string[]; stderr: string[] }, action: () => void): void {
  try { action(); }
  catch (error) {
    if (error instanceof CommanderError) throw error;
    input.stderr.push(error instanceof Error ? error.message : String(error));
    throw new CommanderError(2, 'ccd.commandFailed', 'Account-label read failed.');
  }
}

function readScopeSelection(
  input: { stderr: string[] },
  options: { network?: string; allNetworks?: boolean },
): ReadScopeSelection {
  if (options.network !== undefined && options.allNetworks === true) {
    fail(input, 'Use either --network <name> or --all-networks, not both.', 2);
  }
  const registry = loadNetworks();
  return options.allNetworks === true
    ? { kind: 'all', scopes: allScopes(registry) }
    : { kind: 'single', scope: scope(options.network, registry) };
}
function scope(network: string | undefined, registry: NetworksFile): Scope {
  const resolved = resolveNetworkFromRegistry(network, registry);
  return { name: resolved.name, caip2: caip2Reference(resolved.config.caip2) };
}
function allScopes(registry: NetworksFile): Scope[] {
  return Object.entries(registry.networks).sort(([a], [b]) => a.localeCompare(b))
    .map(([name, config]) => ({ name, caip2: caip2Reference(config.caip2) }));
}
function findAccountLabelMatch(label: string, caip2: string): { label: string; address: string } | undefined {
  const match = findCatalogLabel(Object.entries(loadAccountLabels(caip2)), label, ([stored]) => stored);
  return match === undefined ? undefined : { label: parseCatalogLabel(match[0]).label, address: match[1] };
}
function writeMatch(output: string[], label: string, address: string, scope: Scope, compact: boolean): void {
  if (compact) output.push(`${scope.name}:`, `  ${address}`);
  else output.push(`Label:   ${label}`, `Network: ${scope.name}`, `Address: ${address}`);
}
function fail(input: { stderr: string[] }, message: string, exitCode = 1): never {
  input.stderr.push(message); throw new CommanderError(exitCode, 'ccd.commandFailed', message);
}
function networkList(networks: string[]): string {
  const values = [...new Set(networks)].sort();
  return values.length === 1 ? values[0]! : `${values.slice(0, -1).join(', ')} and ${values.at(-1)}`;
}
