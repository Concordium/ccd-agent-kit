import {
  findSignerInventoryKeyByLabel,
  ed25519SignerKeyRef,
  loadSignerInventory,
  normalizeCatalogLabel,
  parseCatalogLabel,
  parseSoftwareBackend,
  parseYubiKeyPivBackend,
  reorderSignerInventoryKeyBackends,
  reorderSignerInventoryKeyLocations,
  forgetSignerInventoryKeyLocation,
  setSignerInventoryKeyLabel,
  type PivDeviceLocator,
  type SoftwareSignerBackend,
} from '@ccd-agent-kit/config-utils';
import { ed25519PublicKey, type Ed25519PublicKeyHex } from '@ccd-agent-kit/sdk-utils';
import type { Command } from 'commander';
import { z } from 'zod';
import { locationList, locationObject } from './catalogOptions.js';

const signingKeySelectorSchema = z.string().transform((value) => {
  const publicKey = ed25519PublicKey.from(value);
  return publicKey === undefined
    ? { kind: 'label' as const, label: normalizeCatalogLabel(value) }
    : { kind: 'publicKey' as const, publicKey };
});
const selectorOptionsSchema = z.looseObject({ signingKey: signingKeySelectorSchema });
const labelSetOptionsSchema = z.looseObject({
  signingKey: signingKeySelectorSchema,
  mode: z.enum(['hard', 'soft']).optional(),
  label: z.string().transform((value) => normalizeCatalogLabel(value)).optional(),
});
const backendOrderOptionsSchema = z.looseObject({ signingKey: signingKeySelectorSchema, backends: z.string() });
const locationOptionsSchema = z.looseObject({
  signingKey: signingKeySelectorSchema, backend: z.enum(['software-signer', 'yubikey-piv']),
});

/** Registers signing-key inspection and catalog mutations selected by one public key or bare label. */
export function registerSigningKeyCliCommand(input: { program: Command; stdout: string[]; stderr: string[] }): void {
  const signingKey = input.program.commands.find(command => command.name() === 'signing-key')
    ?? input.program.command('signing-key').description('Manage public signing keys and custody locations.');
  signingKey.command('list').description('Summarize public signing keys and backend IDs.')
    .action(() => {
      const inventory = loadSignerInventory();
      const signingKeys = Object.entries(inventory.keys).map(([keyRef, entry]) => ({
        keyRef, ...(entry.label === undefined ? {} : { label: parseCatalogLabel(entry.label) }),
        scheme: entry.scheme, backends: entry.backends.map(backend => backend.signingModule),
      }));
      input.stdout.push(JSON.stringify({ signingKeys }, null, 2));
    });
  signingKey.command('inspect').description('Inspect a signing key selected by public key or bare label.')
    .requiredOption('--signing-key <public-key-or-label>', 'Ed25519 public key or bare hard/soft label.')
    .action((rawOptions: unknown) => {
      const { signingKey: selector } = selectorOptionsSchema.parse(rawOptions);
      const match: ReturnType<typeof findSignerInventoryKeyByLabel> = selector.kind === 'publicKey'
        ? (() => { const keyRef = ed25519SignerKeyRef(selector.publicKey); const inventory = loadSignerInventory();
          const entry = inventory.keys[keyRef]; return entry === undefined ? undefined : [keyRef, entry]; })()
        : findSignerInventoryKeyByLabel(selector.label);
      if (match === undefined) throw new Error('Signing key was not found.');
      input.stdout.push(JSON.stringify({ keyRef: match[0], ...match[1],
        ...(match[1].label === undefined ? {} : { label: parseCatalogLabel(match[1].label) }) }, null, 2));
    });
  const label = signingKey.command('label').description('Set, convert, or remove signing-key labels.');
  label.command('set')
    .description('Set or convert a hard/soft signing-key label; omitted label preserves its text.')
    .requiredOption('--signing-key <public-key-or-label>', 'Ed25519 public key or bare hard/soft label.')
    .option('--mode <hard|soft>', 'Label protection mode.')
    .option('--label <label>', 'Bare label text; omit when only converting mode.')
    .action((rawOptions: unknown) => {
      const { signingKey, mode, label: requestedLabel } = labelSetOptionsSchema.parse(rawOptions);
      const publicKey = catalogPublicKey(signingKey);
      const result = setSignerInventoryKeyLabel({ publicKey,
        ...(requestedLabel === undefined ? {} : { label: requestedLabel }),
        ...(mode === undefined ? {} : { mode }) });
      if (result !== undefined) input.stdout.push(JSON.stringify({ publicKey, ...result }, null, 2));
    });
  label.command('remove').description('Remove a signing-key label.')
    .requiredOption('--signing-key <public-key-or-label>', 'Ed25519 public key or bare hard/soft label.')
    .action((rawOptions: unknown) => {
      const { signingKey } = selectorOptionsSchema.parse(rawOptions);
      const publicKey = catalogPublicKey(signingKey);
      setSignerInventoryKeyLabel({ publicKey, operation: 'remove' });
      input.stdout.push(JSON.stringify({ publicKey }, null, 2));
    });

  signingKey.command('forget').description('Forget all public catalog locations without deleting key material.')
    .requiredOption('--signing-key <public-key-or-label>', 'Ed25519 public key or bare hard/soft label.')
    .action((rawOptions: unknown) => {
      const { signingKey } = selectorOptionsSchema.parse(rawOptions);
      const publicKey = catalogPublicKey(signingKey);
      forgetSignerInventoryKeyLocation(publicKey, 'all');
      input.stdout.push(JSON.stringify({ publicKey }, null, 2));
    });

  const backend = signingKey.command('backend').description('Manage ordered signing backends.');
  backend.command('order').requiredOption('--backends <ids>')
    .requiredOption('--signing-key <public-key-or-label>', 'Ed25519 public key or bare hard/soft label.')
    .action((rawOptions: unknown) => {
      const options = backendOrderOptionsSchema.parse(rawOptions);
      reorderSignerInventoryKeyBackends({ publicKey: catalogPublicKey(options.signingKey), backends: commaList(options.backends) });
    });
  const locations = signingKey.command('locations').description('Manage ordered public custody locations.');
  locations.command('order').requiredOption('--backend <backend>').requiredOption('--locations <json>')
    .requiredOption('--signing-key <public-key-or-label>', 'Ed25519 public key or bare hard/soft label.')
    .action((rawOptions: unknown) => {
      const options = locationOptionsSchema.extend({ locations: z.string() }).parse(rawOptions);
      const publicKey = catalogPublicKey(options.signingKey);
      if (options.backend === 'software-signer') {
        reorderSignerInventoryKeyLocations({ publicKey, signingModule: options.backend,
          locations: locationList(options.locations).map(parseSoftwareLocation) });
      } else {
        reorderSignerInventoryKeyLocations({ publicKey, signingModule: options.backend,
          locations: locationList(options.locations).map(parsePivLocation) });
      }
    });
  locations.command('forget').requiredOption('--backend <backend>').requiredOption('--location <json>')
    .requiredOption('--signing-key <public-key-or-label>', 'Ed25519 public key or bare hard/soft label.')
    .action((rawOptions: unknown) => {
      const options = locationOptionsSchema.extend({ location: z.string() }).parse(rawOptions);
      const publicKey = catalogPublicKey(options.signingKey);
      if (options.backend === 'software-signer') {
        forgetSignerInventoryKeyLocation(publicKey, { backend: options.backend,
          location: parseSoftwareLocation(locationObject(options.location)) });
      } else {
        forgetSignerInventoryKeyLocation(publicKey, { backend: options.backend,
          location: parsePivLocation(locationObject(options.location)) });
      }
    });
}

function catalogPublicKey(selector: z.infer<typeof signingKeySelectorSchema>): Ed25519PublicKeyHex {
  if (selector.kind === 'publicKey') return selector.publicKey;
  const match = findSignerInventoryKeyByLabel(selector.label);
  if (match === undefined) throw new Error('Signing key was not found.');
  return ed25519PublicKey.require(match[0].slice('ed25519:'.length));
}

function parseSoftwareLocation(raw: Record<string, unknown>): SoftwareSignerBackend {
  const parsed = parseSoftwareBackend(raw);
  if (parsed === undefined) throw new Error('Software signer location is invalid.');
  return { ...raw, ...parsed };
}

function parsePivLocation(raw: Record<string, unknown>): PivDeviceLocator {
  const devices = parseYubiKeyPivBackend({ devices: [raw] })?.devices;
  if (devices?.length !== 1) throw new Error('YubiKey PIV location is invalid.');
  return devices[0]!;
}

function commaList(value: string): string[] {
  const values = value.split(',').map(entry => entry.trim());
  if (values.some(entry => entry.length === 0)) throw new Error('Backend order must be a non-empty comma-separated list.');
  if (new Set(values).size !== values.length) throw new Error('Backend order cannot contain duplicates.');
  return values;
}
