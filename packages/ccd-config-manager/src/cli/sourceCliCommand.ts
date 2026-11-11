import {
  createIdentitySourceRegistry,
  IdentitySourceError,
  parseCatalogLabel,
  resolveIdentitySource,
  type IdentitySourceRegistry,
} from '@ccd-agent-kit/config-utils';
import type { Command } from 'commander';
import { z } from 'zod';
import { locationList, locationObject } from './catalogOptions.js';

/** Registers identity-root summaries, full inspection, and public catalog management. */
export function registerSourceCliCommand(input: {
  program: Command; stdout: string[];
  /** Optional registry factory used by tests and embedded command hosts. */
  registryFactory?: () => IdentitySourceRegistry;
}): void {
  const root = input.program.commands.find(command => command.name() === 'identity-root')
    ?? input.program.command('identity-root').description('Manage the public identity-root catalog.');
  const registry = input.registryFactory ?? (() => createIdentitySourceRegistry());
  const json = (value: unknown): void => { input.stdout.push(JSON.stringify(value, null, 2)); };

  root.command('list').description('Summarize identity roots, backend IDs, and the default selection.').action(async () => {
    const document = await registry().read();
    json({ ...document, sources: Object.fromEntries(Object.entries(document.sources)
      .map(([id, record]) => [id, {
        ...(record.label === undefined ? {} : { label: parseCatalogLabel(record.label).label }),
        backends: record.backends.map(backend => backend.backend), default: id === document.defaultSourceId,
      }])) });
  });
  root.command('inspect').description('Inspect one identity root by ID or label.')
    .requiredOption('--identity-root <selector>')
    .action(async (options: { identityRoot: string }) => {
      const [id, record] = resolveIdentitySource(await registry().read(), options.identityRoot);
      json(projectSource(id, record));
    });

  const label = root.command('label').description('Set, convert, or remove identity-root labels.');
  label.command('set').requiredOption('--identity-root <selector>').option('--mode <hard|soft>')
    .option('--label <label>', 'Bare label text; omit when only converting mode.')
    .action(async (options: { identityRoot: string; mode?: string; label?: string }) => {
      const catalog = registry();
      if (options.mode !== undefined && options.mode !== 'hard' && options.mode !== 'soft') {
        throw new Error("Mode must be 'hard' or 'soft'.");
      }
      const [id] = resolveIdentitySource(await catalog.read(), options.identityRoot);
      json(projectSourceResult(await catalog.setLabel(id, {
        ...(options.label === undefined ? {} : { label: options.label }),
        ...(options.mode === undefined ? {} : { mode: options.mode }),
      })));
    });
  label.command('remove').requiredOption('--identity-root <selector>')
    .action(async (options: { identityRoot: string }) => {
      const catalog = registry();
      const [id] = resolveIdentitySource(await catalog.read(), options.identityRoot);
      json(projectSourceResult(await catalog.setLabel(id, { operation: 'remove' })));
    });

  const defaultCommand = root.command('default').description('Show or set the default identity root.');
  defaultCommand.command('show').action(async () => {
    const document = await registry().read();
    json({ defaultIdentityRoot: document.defaultSourceId });
  });
  defaultCommand.command('set').requiredOption('--identity-root <selector>')
    .action(async (options: { identityRoot: string }) => json(projectSourceResult(await registry().setDefault(options.identityRoot))));
  root.command('forget').requiredOption('--identity-root <selector>')
    .description('Forget public catalog metadata without changing hardware or identity objects.')
    .action(async (options: { identityRoot: string }) => json(await registry().forgetLocation(options.identityRoot, 'all')));

  const backend = root.command('backend').description('Manage ordered identity-root backends.');
  backend.command('order').requiredOption('--identity-root <selector>').requiredOption('--backends <ids>')
    .action(async (options: { identityRoot: string; backends: string }) =>
      json(projectSourceResult(await registry().reorderBackends(options.identityRoot, commaList(options.backends)))));

  const locations = root.command('locations').description('Manage ordered public locations for one identity root.');
  locations.command('order').requiredOption('--identity-root <selector>').requiredOption('--backend <backend>')
    .requiredOption('--locations <json>')
    .action(async (options: { identityRoot: string; backend: string; locations: string }) =>
      json(projectSourceResult(await registry()
        .reorderLocations(options.identityRoot, options.backend, locationList(options.locations, 'Location order must be a JSON array of location objects.')))));
  locations.command('forget').requiredOption('--identity-root <selector>').requiredOption('--backend <backend>')
    .requiredOption('--location <json>')
    .action(async (options: { identityRoot: string; backend: string; location: string }) => {
      if (options.backend !== 'yubikey-piv') throw new Error("Identity-root locations require backend 'yubikey-piv'.");
      try {
        const location = z.strictObject({ serial: z.string().regex(/^\d+$/) }).parse(locationObject(options.location));
        const result = await registry().forgetLocation(options.identityRoot, { backend: 'yubikey-piv', location });
        json('backends' in result ? projectSourceResult(result) : result);
      }
      catch (error) {
        if (error instanceof IdentitySourceError && error.code === 'SOURCE_NOT_FOUND') {
          throw new Error('Identity root was not found.', { cause: error });
        }
        if (error instanceof IdentitySourceError && error.code === 'INVALID_SOURCE') {
          throw new Error('Identity-root location is not registered.', { cause: error });
        }
        throw error;
      }
    });
}

function projectSource(id: string, record: Awaited<ReturnType<IdentitySourceRegistry['read']>>['sources'][string]) {
  return { id, ...projectSourceRecord(record) };
}

function projectSourceRecord(record: Awaited<ReturnType<IdentitySourceRegistry['read']>>['sources'][string]) {
  const { label, ...publicRecord } = record;
  return { ...(label === undefined ? {} : { label: parseCatalogLabel(label).label }), ...publicRecord };
}

function projectSourceResult(result: Awaited<ReturnType<IdentitySourceRegistry['setLabel']>>) {
  const { id, ...record } = result;
  return projectSource(id, record);
}

function commaList(value: string): string[] {
  const entries = value.split(',').map((entry) => entry.trim());
  if (entries.length === 0 || entries.some((entry) => entry.length === 0)) {
    throw new Error('Backend order must be a non-empty comma-separated list.');
  }
  return entries;
}
