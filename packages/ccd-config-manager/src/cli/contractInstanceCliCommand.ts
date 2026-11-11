import {
  findContractInstanceLabelForAddress,
  findContractInstanceLabelScopes,
  findCatalogLabel,
  loadContractInstanceLabels,
  loadNetworks,
  normalizeCatalogLabel,
  parseCatalogLabel,
  resolveNetworkFromRegistry,
  setContractInstanceLabel,
  type NetworksFile,
} from '@ccd-agent-kit/config-utils';
import { contractInstance, type ContractInstanceAddress } from '@ccd-agent-kit/sdk-utils';
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
 * Registers network-scoped contract-instance-label reads and hard/soft mutations.
 * Mutations affect exactly one resolved network and delegate persistence policy to config.
 */
export function registerContractInstanceCliCommand(
  input: { /** Commander root program. */ program: Command; /** Captured standard output. */ stdout: string[]; /** Captured standard error. */ stderr: string[] },
): void {
  const parent = input.program.command('contract-instance').description('Manage contract instances.');
  const command = parent.command('label')
    .description('Manage network-scoped hard and soft contract instance labels.');
  const readOptions = (child: Command) => child.option('--network <name>').option('--all-networks');

  readOptions(command.command('list').description('List contract instance labels for one network or all networks.'))
    .action((raw: unknown) => readAction(input, () => {
      const selection = readScopeSelection(input, listOptionsSchema.parse(raw));
      const scopes = selection.kind === 'all' ? selection.scopes : [selection.scope];
      if (selection.kind === 'all') input.stdout.push('Contract instance labels by network:', '');
      for (const scope of scopes) {
        const entries = Object.entries(loadContractInstanceLabels(scope.caip2))
          .map(([stored, address]) => [parseCatalogLabel(stored).label, address] as const)
          .sort(([left], [right]) => left.localeCompare(right));
        input.stdout.push(selection.kind === 'all' ? `${scope.name}:` : `Contract instance labels for ${scope.name}:`, '');
        if (entries.length === 0) input.stdout.push(selection.kind === 'all'
          ? '  No contract instance labels configured.' : `No contract instance labels configured for ${scope.name}.`);
        else for (const [label, address] of entries) input.stdout.push(`  ${label.padEnd(16)} ${contractInstance.format(address)}`);
      }
    }));

  readOptions(command.command('inspect').description('Inspect the address for a contract instance label.')
    .requiredOption('--label <label>')).action((raw: unknown) => readAction(input, () => {
      const options = inspectOptionsSchema.parse(raw);
      const selection = readScopeSelection(input, options);
      if (selection.kind === 'single') {
        const match = findContractInstanceLabelMatch(options.label, selection.scope.caip2);
        if (match !== undefined) {
          writeMatch(input.stdout, match.label, match.address, selection.scope, false);
          return;
        }
        const message = `Contract instance label '${options.label}' is not configured for ${selection.scope.name}.`;
        input.stderr.push(message);
        const elsewhere = findContractInstanceLabelScopes(options.label)
          .filter((match) => match.network !== selection.scope.name).map((match) => match.network);
        if (elsewhere.length > 0) input.stderr.push(`It exists for ${networkList(elsewhere)}.`);
        throw new CommanderError(1, 'ccd.commandFailed', message);
      }
      const matches = selection.scopes.flatMap((scope) => {
        const match = findContractInstanceLabelMatch(options.label, scope.caip2);
        return match === undefined ? [] : [{ ...scope, ...match }];
      });
      if (matches.length === 0) fail(input, `Contract instance label '${options.label}' is not configured on any network.`);
      input.stdout.push(`Contract instance label '${options.label}':`, '');
      for (const match of matches) writeMatch(input.stdout, match.label, match.address, match, true);
    }));

  readOptions(command.command('find').description('Find contract instance labels for an address.')
    .requiredOption('--address <address>')).action((raw: unknown) => readAction(input, () => {
      const options = findOptionsSchema.parse(raw);
      const address = contractInstance.require(options.address);
      const selection = readScopeSelection(input, options);
      if (selection.kind === 'single') {
        const label = findContractInstanceLabelForAddress(address, selection.scope.caip2);
        if (label === undefined) fail(input, `Address has no contract instance label for ${selection.scope.name}.`);
        writeMatch(input.stdout, label, address, selection.scope, false);
        return;
      }
      const matches = selection.scopes.flatMap((scope) => {
        const label = findContractInstanceLabelForAddress(address, scope.caip2);
        return label === undefined ? [] : [{ name: scope.name, label }];
      });
      if (matches.length === 0) fail(input, 'Address has no contract instance label on any network.');
      input.stdout.push('Address matches:', '');
      for (const match of matches) input.stdout.push(`${match.name}:`, `  ${match.label}`);
    }));

  command.command('set').description('Set, relabel, or convert a contract instance label; omitted label preserves its text.')
    .requiredOption('--address <address>').option('--mode <hard|soft>').option('--label <label>')
    .option('--network <name>').action((raw: unknown) => {
      const options = setOptionsSchema.parse(raw);
      const address = contractInstance.require(options.address);
      const caip2 = scope(options.network, loadNetworks()).caip2;
      const result = setContractInstanceLabel({ address,
        ...(options.label === undefined ? {} : { label: options.label }),
        ...(options.mode === undefined ? {} : { mode: options.mode }) }, caip2);
      if (result !== undefined) {
        input.stdout.push(JSON.stringify({ address: contractInstance.format(address), ...result }, null, 2));
      }
    });

  command.command('remove').description('Remove a contract instance label by address on one network.')
    .requiredOption('--address <address>').option('--network <name>').action((raw: unknown) => {
      const options = removeOptionsSchema.parse(raw);
      const address = contractInstance.require(options.address);
      setContractInstanceLabel({ address, operation: 'remove' }, scope(options.network, loadNetworks()).caip2);
      input.stdout.push(JSON.stringify({ address: contractInstance.format(address) }, null, 2));
    });
}

function readAction(input: { stdout: string[]; stderr: string[] }, action: () => void): void {
  try { action(); }
  catch (error) {
    if (error instanceof CommanderError) throw error;
    input.stderr.push(error instanceof Error ? error.message : String(error));
    throw new CommanderError(2, 'ccd.commandFailed', 'Contract-instance-label read failed.');
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
  return Object.entries(registry.networks).sort(([left], [right]) => left.localeCompare(right))
    .map(([name, config]) => ({ name, caip2: caip2Reference(config.caip2) }));
}

function findContractInstanceLabelMatch(
  label: string,
  caip2: string,
): { label: string; address: ContractInstanceAddress } | undefined {
  const match = findCatalogLabel(Object.entries(loadContractInstanceLabels(caip2)), label, ([stored]) => stored);
  return match === undefined ? undefined : { label: parseCatalogLabel(match[0]).label, address: match[1] };
}

function writeMatch(
  output: string[], label: string, address: ContractInstanceAddress, scope: Scope, compact: boolean,
): void {
  if (compact) output.push(`${scope.name}:`, `  ${contractInstance.format(address)}`);
  else output.push(`Label:   ${label}`, `Network: ${scope.name}`, `Address: ${contractInstance.format(address)}`);
}

function fail(input: { stderr: string[] }, message: string, exitCode = 1): never {
  input.stderr.push(message);
  throw new CommanderError(exitCode, 'ccd.commandFailed', message);
}

function networkList(networks: string[]): string {
  const values = [...new Set(networks)].sort();
  return values.length === 1 ? values[0]! : `${values.slice(0, -1).join(', ')} and ${values.at(-1)}`;
}
