import { createHash, createPrivateKey, createPublicKey } from 'node:crypto';
import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { readHiddenLine } from '@ccd-agent-kit/cli-utils';
import {
  assertIdentitySourceLabelAvailable,
  ENCRYPTED_FILE_STORAGE_MODULE_ID,
  createIdentitySourceRegistry,
  deriveIdentitySourceId,
  loadSignerInventory,
  loadYubiKeyConfig,
  loadYubiKeyRegistrations,
  registerYubiKey,
  forgetYubiKeyInventoryLocators,
  forgetYubiKeyPivSignerLocator,
  renameYubiKeyRegistrationBySelector,
  resetYubiKeyGenerationDefaults,
  resolveYubiKeyGenerationDefaults,
  setYubiKeyGenerationDefaults,
  unregisterYubiKey,
  upsertSignerInventoryKey,
  normalizeCatalogLabel,
  prepareCatalogLabelMutation,
  type IdentitySourceRegistry,
} from '@ccd-agent-kit/config-utils';
import {
  createIdentityYubiKeyService,
  createNativePivYubiKeyService,
  createPivTransport,
  deriveP256PublicKey,
  parseAllowedYubiKeySigningSlot,
  type IdentityYubiKeyService,
  validateP256PrivateScalarHex,
  type YubiKeyInteractionProvider,
  type YubiKeyService,
} from '@ccd-agent-kit/piv-utils';
import { ed25519PrivateKey, ed25519PublicKey } from '@ccd-agent-kit/sdk-utils';
import { CommanderError, type Command } from 'commander';
import { z } from 'zod';
import { catalogAfterHardwareMutation, catalogIdentityRoot } from './catalogMutation.js';
import { resolveYubiKeySelector } from './yubikeySelector.js';
import { runKeyCommand } from './keyCommand.js';

const inspectOptionsSchema = z.object({ device: z.string().optional() });
const signingKeyAdoptOptionsSchema = z.object({
  backend: z.enum(['software', 'yubikey-piv']),
  device: z.string().optional(), storage: z.string().optional(), label: z.string().optional(),
  publicKey: z.string().transform(value => ed25519PublicKey.from(value)
    ?? usageError('Invalid Ed25519 public key.')).optional(),
  slot: z.string().transform(value => parseAllowedYubiKeySigningSlot(value)
    ?? usageError('Invalid YubiKey signing slot.')).optional(),
});

/** Registers YubiKey-backed operations on the public object-first command tree. */
export function registerYubiKeyCliCommand(input: {
  program: Command; stderr: string[]; stdout: string[];
  runNested(result: Promise<number> | number): Promise<void>;
  /** Optional signing service factory used by tests and embedded command hosts. */
  serviceFactory?: () => YubiKeyService;
  /** Optional identity-root service factory used by tests and embedded command hosts. */
  identityServiceFactory?: () => IdentityYubiKeyService;
  /** Optional identity-root catalog factory used by tests and embedded command hosts. */
  identityRegistryFactory?: () => IdentitySourceRegistry;
  /** Optional trusted interaction factory used by tests and embedded command hosts. */
  interactionFactory?: () => YubiKeyInteractionProvider;
}): void {
  const device = input.program.command('device').description('Manage YubiKey PIV devices.');
  const signingFactory = input.serviceFactory ?? (() => createNativePivYubiKeyService());
  const identityFactory = input.identityServiceFactory
    ?? (() => createIdentityYubiKeyService(createPivTransport()));
  const registryFactory = input.identityRegistryFactory ?? (() => createIdentitySourceRegistry());
  const interactionFactory = input.interactionFactory ?? createYubiKeyInteraction;
  const json = (value: unknown) => input.stdout.push(JSON.stringify(value, null, 2));

  device.command('list').description('List connected PIV devices and friendly names.').action(async () => {
    const hardware = signingFactory();
    try { json({ devices: await hardware.listDevices(), registrations: loadYubiKeyRegistrations() }); }
    finally { await hardware.close?.(); }
  });
  device.command('inspect').description('Inspect signing-key and identity-root use on a connected device.')
    .option('--device <device>')
    .action(async (options: unknown) => {
      const serial = resolveYubiKeySelector(inspectOptionsSchema.parse(options).device);
      const signing = signingFactory();
      try {
        const identity = identityFactory();
        try {
          if (serial !== undefined) json({ signingKeys: await signing.inspectDevice(serial), identityRoot: await identity.inspectRoot(serial) });
          else {
            const devices = await signing.listDevices();
            json({ devices: await Promise.all(devices.filter((device): device is typeof device & { serial: string } => device.serial !== undefined).map(async (device) => ({
              signingKeys: await signing.inspectDevice(device.serial), identityRoot: await identity.inspectRoot(device.serial),
            }))) });
          }
        } finally { await identity.close?.(); }
      } finally { await signing.close?.(); }
    });

  registerSigningKeyCommands(input.program, signingFactory, interactionFactory, json, input);
  registerIdentityRootCommands(input.program, identityFactory, registryFactory, interactionFactory, json);
  registerDefaultsCommands(device, json);

  device.command('integrity').description('Compare connected hardware with both public catalogs.')
    .option('--fix', 'Remove only confirmed stale locations for one selected device', false)
    .option('--device <device>')
    .action(async (options: { fix: boolean; device?: string }) => {
      if (options.fix && options.device === undefined) throw new Error('--device is required with --fix.');
      const serial = resolveYubiKeySelector(options.device);
      const signing = signingFactory(); const identity = identityFactory(); const registry = registryFactory();
      try {
        const signingScan = await inspectSigningIntegrity(signing, serial);
        const identityScan = await inspectIdentityRootIntegrity(identity, registry, serial);
        const signingResult = { issues: signingScan.issues, removedPublicKeys: [] as string[] };
        const identityResult = { issues: identityScan.issues, removedIdentityRoots: [] as string[] };
        if (options.fix && (signingScan.stale.size > 0 || identityScan.stale.length > 0)) {
          if (!await interactionFactory().confirm(`REPAIR YUBIKEY CATALOG ${serial}`)) throw new Error('YubiKey catalog repair cancelled.');
          let changed = false;
          try {
            signingResult.removedPublicKeys = applySigningRepair(signingScan.stale); changed ||= signingResult.removedPublicKeys.length > 0;
            for (const location of identityScan.stale) {
              const forgotten = await registry.forgetLocation(location.id, { backend: 'yubikey-piv', location: { serial: location.serial } });
              if (!('backends' in forgotten)) identityResult.removedIdentityRoots.push(location.id);
              changed = true;
            }
          } catch (error) {
            throw new Error(changed
              ? 'YubiKey catalog repair was partially applied; inspect both catalogs before retrying.'
              : 'YubiKey catalog repair failed before any catalog changes were applied.', { cause: error });
          }
        }
        json({ signingKeys: signingResult, identityRoots: identityResult });
      } finally { await Promise.all([signing.close?.(), identity.close?.()]); }
    });

  registerDeviceCommands(device, signingFactory, interactionFactory, json);
}

function registerSigningKeyCommands(
  parent: Command,
  serviceFactory: () => YubiKeyService,
  interactionFactory: () => YubiKeyInteractionProvider,
  json: (value: unknown) => void,
  io: Pick<Parameters<typeof registerYubiKeyCliCommand>[0], 'stderr' | 'stdout' | 'runNested'>,
): void {
  const key = parent.commands.find(command => command.name() === 'signing-key')
    ?? parent.command('signing-key').description('Provision and catalog Ed25519 signing keys.');
  provisionMutation(key, 'generate', true).action(async (options: MutationOptions) => {
    if (options.backend === 'software') {
      rejectHardwareOptions(options);
      return io.runNested(runKeyCommand({ request: { action: 'generate', label: options.label, storage: options.storage }, stderr: io.stderr, stdout: io.stdout }));
    }
    requireYubiKeyBackend(options.backend);
    requireDevice(options.device);
    rejectSoftwareOptions(options);
    const label = preflightSigningLabel(options.label);
    const request = signingRequest(options);
    const hardware = serviceFactory();
    try {
      const generated = await hardware.generateEd25519Key({ ...request, interaction: interactionFactory() });
      await catalogSigningResult(generated, label); json(generated);
    } finally { await hardware.close?.(); }
  });
  provisionMutation(key, 'import', true).action(async (options: MutationOptions) => {
    if (options.backend === 'software') {
      rejectHardwareOptions(options);
      return io.runNested(runKeyCommand({ request: { action: 'import', file: options.file, label: options.label, storage: options.storage }, stderr: io.stderr, stdout: io.stdout }));
    }
    requireYubiKeyBackend(options.backend);
    requireDevice(options.device);
    rejectSoftwareOptions(options);
    let hardware: YubiKeyService | undefined; let bytes: Buffer | undefined;
    try {
      const request = signingRequest(options);
      const privateKeyHex = ed25519PrivateKey.require(await readHiddenLine(
        stdin, stdout, 'Private key: ', 'YubiKey key import requires an interactive terminal.',
      ));
      bytes = Buffer.from(privateKeyHex, 'hex');
      const publicKey = deriveEd25519PublicKey(bytes);
      const label = preflightSigningLabel(options.label, publicKey);
      hardware = serviceFactory();
      const imported = await hardware.importEd25519Key({
        ...request, privateKeyHex, publicKey, interaction: interactionFactory(),
      });
      await catalogSigningResult(imported, label); json(imported);
    } finally { bytes?.fill(0); await hardware?.close?.(); }
  });
  key.command('adopt').description('Catalog an existing key without rewriting its private material.')
    .requiredOption('--backend <backend>', 'software or yubikey-piv.')
    .option('--device <device>', 'Required for yubikey-piv; device serial or registered name.')
    .option('--slot <slot>', 'PIV signing slot; defaults to the configured slot.')
    .option('--storage <storage>', 'Required for software; encrypted-file only.')
    .option('--public-key <hex>', 'Required for software; identifies the managed encrypted key file.')
    .option('--label <label>', 'Optional catalog label.')
    .action(async (rawOptions: unknown) => {
      const parsed = signingKeyAdoptOptionsSchema.safeParse(rawOptions);
      if (!parsed.success) usageError(parsed.error.message);
      const options = parsed.data;
      if (options.backend === 'software') {
        rejectHardwareOptions(options);
        if (options.storage === undefined) usageError('--storage is required for backend software.');
        if (options.storage !== ENCRYPTED_FILE_STORAGE_MODULE_ID) usageError('Software adoption requires --storage encrypted-file.');
        if (options.publicKey === undefined) usageError('--public-key is required for backend software.');
        return io.runNested(runKeyCommand({
          request: { action: 'adopt', publicKey: options.publicKey, ...(options.label === undefined ? {} : { label: options.label }) },
          stderr: io.stderr, stdout: io.stdout,
        }));
      }
      requireDevice(options.device);
      rejectSoftwareOptions(options);
      const serial = resolveYubiKeySelector(options.device)!; const hardware = serviceFactory();
      try {
        const slotName = resolveYubiKeyGenerationDefaults({ serial, overrides: options.slot === undefined ? {} : { slot: options.slot } }).slot;
        const observed = (await hardware.inspectDevice(serial)).slots.find((candidate) => candidate.slot === slotName);
        if (observed?.status !== 'occupied' || observed.publicKey === undefined || observed.algorithm?.toLowerCase() !== 'ed25519') {
          throw new Error('The selected slot is not an occupied Ed25519 signing slot with a readable public key.');
        }
        const label = preflightSigningLabel(options.label, observed.publicKey);
        const fingerprint = createHash('sha256').update(Buffer.from(observed.publicKey, 'hex')).digest('hex');
        if (!await interactionFactory().confirm(`TRUST ${fingerprint}`)) throw new Error('Signing-key adoption cancelled.');
        upsertSignerInventoryKey({
          publicKey: ed25519PublicKey.require(observed.publicKey), scheme: 'Ed25519', signingModule: 'yubikey-piv',
          backend: { devices: [{ kind: 'yubikey', serial, slot: slotName,
            ...(observed.pinPolicy === undefined ? {} : { pinPolicy: observed.pinPolicy }),
            ...(observed.touchPolicy === undefined ? {} : { touchPolicy: observed.touchPolicy }) }] },
          ...(label === undefined ? {} : { label }),
        });
        json({ publicKey: observed.publicKey, fingerprint, serial, slot: slotName });
      } finally { await hardware.close?.(); }
    });
}

interface MutationOptions {
  backend: string; device?: string; slot?: string; pinPolicy?: string; touchPolicy?: string; label?: string;
  force: boolean; storage?: string; file?: string;
}

function signingRequest(options: MutationOptions) {
  const serial = resolveYubiKeySelector(options.device)!;
  const defaults = resolveYubiKeyGenerationDefaults({ serial, overrides: {
    ...(options.slot === undefined ? {} : { slot: options.slot as never }),
    ...(options.pinPolicy === undefined ? {} : { pinPolicy: options.pinPolicy as never }),
    ...(options.touchPolicy === undefined ? {} : { touchPolicy: options.touchPolicy as never }),
  } });
  return { serial, ...defaults, force: options.force };
}

function preflightSigningLabel(label?: string, publicKey?: string): string | undefined {
  if (label === undefined) return undefined;
  const normalized = normalizeCatalogLabel(label);
  const ownRef = publicKey === undefined ? undefined : `ed25519:${publicKey}`;
  const inventory = loadSignerInventory();
  const current = ownRef === undefined ? undefined
    : Object.entries(inventory.keys).find(([reference]) => reference === ownRef)?.[1].label;
  prepareCatalogLabelMutation({
    ...(current === undefined ? {} : { current }), operation: 'set', label: normalized,
    otherLabels: Object.entries(inventory.keys)
      .filter(([reference]) => reference !== ownRef)
      .map(([, entry]) => entry.label),
  });
  return normalized;
}

async function catalogSigningResult(result: {
  publicKey: string; serial: string; slot: string; pinPolicy?: string; touchPolicy?: string; replacedPublicKey?: string;
}, label?: string): Promise<void> {
  await catalogAfterHardwareMutation(() => {
    upsertSignerInventoryKey({
      publicKey: ed25519PublicKey.require(result.publicKey), scheme: 'Ed25519', signingModule: 'yubikey-piv',
      backend: { devices: [{ kind: 'yubikey', serial: result.serial, slot: result.slot as never,
        ...(result.pinPolicy === undefined ? {} : { pinPolicy: result.pinPolicy as never }),
        ...(result.touchPolicy === undefined ? {} : { touchPolicy: result.touchPolicy as never }) }] },
      ...(label === undefined ? {} : { label }),
    });
    if (result.replacedPublicKey !== undefined) forgetYubiKeyPivSignerLocator({
      publicKey: ed25519PublicKey.require(result.replacedPublicKey), serial: result.serial, slot: result.slot,
    });
  }, 'YubiKey hardware key changed, but the signing-key catalog could not be fully updated and may be partially updated. Inspect the device and reconcile the catalog before retrying.');
}

function registerIdentityRootCommands(
  parent: Command,
  serviceFactory: () => IdentityYubiKeyService,
  registryFactory: () => IdentitySourceRegistry,
  interactionFactory: () => YubiKeyInteractionProvider,
  json: (value: unknown) => void,
): void {
  const root = parent.commands.find(command => command.name() === 'identity-root')
    ?? parent.command('identity-root').description('Provision and catalog fixed-slot P-256 identity roots.');
  provisionMutation(root, 'generate', false).action(async (options: MutationOptions) => {
    requireYubiKeyBackend(options.backend);
    requireDevice(options.device);
    rejectIdentityOptions(options);
    const label = normalizeOptionalLabel(options.label); const request = identityRequest(options); const registry = registryFactory();
    await preflightIdentityMutation(registry, request.serial, options.force, label);
    const hardware = serviceFactory();
    try {
      const generated = await hardware.generateRoot({ ...request, interaction: interactionFactory() });
      json(await catalogIdentityRoot(() => registry.enroll(
        identityRootRecord(generated.publicKey, generated.serial, label), { replaceLocations: true },
      )));
    } finally { await hardware.close?.(); }
  });
  provisionMutation(root, 'import', false).action(async (options: MutationOptions) => {
    requireYubiKeyBackend(options.backend);
    requireDevice(options.device);
    rejectIdentityOptions(options);
    const label = normalizeOptionalLabel(options.label);
    const request = identityRequest(options);
    const registry = registryFactory(); let hardware: IdentityYubiKeyService | undefined; let bytes: Buffer | undefined;
    try {
      const privateKeyHex = await readHiddenLine(stdin, stdout, 'Private key: ', 'Identity-root import requires an interactive terminal.');
      bytes = validateP256PrivateScalarHex(privateKeyHex);
      const publicKey = deriveP256PublicKey(bytes).toString('hex');
      await preflightIdentityMutation(registry, request.serial, options.force, label, publicKey);
      hardware = serviceFactory();
      const imported = await hardware.importRoot({
        ...request, privateKeyHex, interaction: interactionFactory(),
      });
      json(await catalogIdentityRoot(() => registry.enroll(
        identityRootRecord(imported.publicKey, imported.serial, label), { replaceLocations: true },
      )));
    } finally { bytes?.fill(0); await hardware?.close?.(); }
  });
  root.command('adopt').requiredOption('--backend <backend>').requiredOption('--device <device>').option('--label <label>')
    .action(async (options: { backend: string; device: string; label?: string }) => {
      requireYubiKeyBackend(options.backend);
      const label = normalizeOptionalLabel(options.label); const registry = registryFactory(); const hardware = serviceFactory();
      try {
        const serial = resolveYubiKeySelector(options.device)!; const observed = await hardware.inspectRoot(serial);
        if (observed.status !== 'occupied' || observed.publicKey === undefined) throw new Error('A valid P-256 root is unavailable.');
        await preflightIdentityMutation(registry, serial, false, label, observed.publicKey);
        const fingerprint = fingerprintOf(observed.publicKey);
        if (!await interactionFactory().confirm(`TRUST ${fingerprint}`)) throw new Error('Identity-root adoption cancelled.');
        json(await registry.enroll(identityRootRecord(observed.publicKey, serial, label)));
      } finally { await hardware.close?.(); }
    });
}

function provisionMutation(parent: Command, name: 'generate' | 'import', signingSlot: boolean): Command {
  const command = parent.command(name).requiredOption('--backend <backend>')
    .option('--device <device>').option('--storage <storage>');
  if (name === 'import') command.option('--file <path>');
  if (signingSlot) command.option('--slot <slot>');
  return command.option('--pin-policy <policy>').option('--touch-policy <policy>')
    .option('--label <label>').option('--force', 'Replace an occupied key after confirmation', false);
}

function identityRequest(options: MutationOptions) {
  const serial = resolveYubiKeySelector(options.device)!;
  const defaults = resolveYubiKeyGenerationDefaults({ serial, overrides: {
    ...(options.pinPolicy === undefined ? {} : { pinPolicy: options.pinPolicy as never }),
    ...(options.touchPolicy === undefined ? {} : { touchPolicy: options.touchPolicy as never }),
  } });
  return { serial, pinPolicy: defaults.pinPolicy, touchPolicy: defaults.touchPolicy, force: options.force };
}

async function preflightIdentityMutation(
  registry: IdentitySourceRegistry, serial: string, force: boolean, label?: string, publicKey?: string,
): Promise<void> {
  const document = await registry.read();
  const own = publicKey === undefined ? undefined
    : deriveIdentitySourceId(publicKey, 1);
  if (label !== undefined) {
    try { assertIdentitySourceLabelAvailable(document, label, own); }
    catch (error) { throw new Error(`Identity-root label '${label}' is unavailable.`, { cause: error }); }
  }
  const claimed = Object.entries(document.sources).find(([id, source]) => id !== own
    && source.backends.some((backend) => backend.backend === 'yubikey-piv'
      && backend.locations.some((location) => location.serial === serial)));
  if (claimed !== undefined && !force) throw new Error(`YubiKey serial ${serial} is already claimed by another identity root.`);
}

function normalizeOptionalLabel(label?: string): string | undefined {
  return label === undefined ? undefined : normalizeCatalogLabel(label);
}

function identityRootRecord(publicKey: string, serial: string, label?: string) {
  return {
    ...(label === undefined ? {} : { label }),
    backends: [{ backend: 'yubikey-piv', locations: [{ serial }] }], rootPublicKey: publicKey,
    rootPublicKeyFingerprint: fingerprintOf(publicKey), recipeVersion: 1 as const,
  };
}

function registerDefaultsCommands(parent: Command, json: (value: unknown) => void): void {
  const defaults = parent.command('defaults').description('Manage shared provisioning defaults.');
  defaults.command('show').option('--device <device>').action((options: { device?: string }) => json({
    config: loadYubiKeyConfig(), resolved: resolveYubiKeyGenerationDefaults({ serial: resolveYubiKeySelector(options.device) }),
  }));
  defaults.command('set').option('--device <device>').option('--slot <slot>')
    .option('--pin-policy <policy>').option('--touch-policy <policy>')
    .action((options: { device?: string; slot?: string; pinPolicy?: string; touchPolicy?: string }) => {
      const specified = {
        ...(options.slot === undefined ? {} : { slot: options.slot as never }),
        ...(options.pinPolicy === undefined ? {} : { pinPolicy: options.pinPolicy as never }),
        ...(options.touchPolicy === undefined ? {} : { touchPolicy: options.touchPolicy as never }),
      };
      if (Object.keys(specified).length === 0) throw new Error('Specify at least one generation default.');
      resolveYubiKeyGenerationDefaults({ config: {}, overrides: specified });
      json(setYubiKeyGenerationDefaults({ defaults: specified, serial: resolveYubiKeySelector(options.device) }));
    });
  defaults.command('reset').option('--device <device>')
    .action((options: { device?: string }) => json(resetYubiKeyGenerationDefaults(resolveYubiKeySelector(options.device))));
}

function registerDeviceCommands(
  parent: Command, serviceFactory: () => YubiKeyService,
  interactionFactory: () => YubiKeyInteractionProvider, json: (value: unknown) => void,
): void {
  const device = parent;
  device.command('pin-status').option('--device <device>').action(async (options: { device?: string }) => {
    const hardware = serviceFactory(); try { const result = await hardware.inspectDevice(resolveYubiKeySelector(options.device)); json({ serial: result.serial, pinStatus: result.pinStatus }); }
    finally { await hardware.close?.(); }
  });
  device.command('unlock').requiredOption('--device <device>').action(async (options: { device: string }) => {
    const hardware = serviceFactory(); try { json(await hardware.unlockDevice({ serial: resolveYubiKeySelector(options.device), interaction: interactionFactory() })); }
    finally { await hardware.close?.(); }
  });
  device.command('lock').requiredOption('--device <device>').action(async (options: { device: string }) => {
    const hardware = serviceFactory(); try {
      if (hardware.lockDevice === undefined) throw new Error('This YubiKey backend does not support locking.');
      json(await hardware.lockDevice({ serial: resolveYubiKeySelector(options.device) }));
    } finally { await hardware.close?.(); }
  });
  device.command('register').requiredOption('--name <name>').requiredOption('--serial <serial>')
    .action((options: { name: string; serial: string }) => json(registerYubiKey(options)));
  device.command('rename').requiredOption('--device <device>').requiredOption('--name <name>')
    .action((options: { device: string; name: string }) => json(renameYubiKeyRegistrationBySelector({ currentSelector: options.device, nextName: options.name })));
  device.command('unregister').requiredOption('--device <device>')
    .action((options: { device: string }) => json(unregisterYubiKey({ selector: options.device })));
}

function requireYubiKeyBackend(backend: string): void {
  if (backend !== 'yubikey-piv') usageError(`Unsupported provisioning backend '${backend}'.`);
}

function rejectHardwareOptions(options: {
  device?: string; slot?: string; pinPolicy?: string; touchPolicy?: string; force?: boolean;
}): void {
  if (options.device !== undefined || options.slot !== undefined || options.pinPolicy !== undefined
    || options.touchPolicy !== undefined || options.force) {
    usageError('YubiKey-only options cannot be used with backend software.');
  }
}

function rejectSoftwareOptions(options: { storage?: string; file?: string; publicKey?: string }): void {
  if (options.storage !== undefined || options.file !== undefined || options.publicKey !== undefined) {
    usageError('--storage, --file, and --public-key are only valid with backend software.');
  }
}

function rejectIdentityOptions(options: MutationOptions): void {
  if (options.storage !== undefined || options.slot !== undefined || options.file !== undefined) {
    usageError('Signing-key-only options cannot be used for identity roots.');
  }
}

function requireDevice(device: string | undefined): asserts device is string {
  if (device === undefined) usageError('--device is required for backend yubikey-piv.');
}

function usageError(message: string): never {
  throw new CommanderError(2, 'commander.invalidArgument', message);
}

function deriveEd25519PublicKey(privateKey: Buffer) {
  const pkcs8 = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), privateKey]);
  try { return ed25519PublicKey.require(createPublicKey(createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' })).export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex')); }
  finally { pkcs8.fill(0); }
}

function fingerprintOf(publicKey: string): string {
  return createHash('sha256').update(Buffer.from(publicKey, 'hex')).digest('hex');
}

/** Creates transient terminal callbacks for config-owned PIV mutations. */
export function createYubiKeyInteraction(): YubiKeyInteractionProvider {
  return {
    promptPin: () => readHiddenLine(stdin, stdout, 'PIN: ', 'YubiKey PIN entry requires an interactive terminal.'),
    promptManagementKey: () => readHiddenLine(stdin, stdout, 'Management key: ', 'YubiKey management requires an interactive terminal.'),
    async confirm(message) {
      if (!stdin.isTTY) return false;
      const prompt = createInterface({ input: stdin, output: stdout });
      try { return await prompt.question(`Type exactly "${message}" to continue: `) === message; }
      finally { prompt.close(); }
    },
  };
}

async function inspectSigningIntegrity(hardware: YubiKeyService, selectedSerial?: string) {
  const catalogLocations = Object.entries(loadSignerInventory().keys).flatMap(([reference, entry]) => entry.backends.flatMap((backend) => {
    const devices = backend.signingModule === 'yubikey-piv' && typeof backend.backend === 'object' && backend.backend !== null
      ? (backend.backend as { devices?: unknown }).devices : undefined;
    return Array.isArray(devices) ? devices.flatMap((device) => typeof device === 'object' && device !== null
      && (device as { kind?: unknown }).kind === 'yubikey' && typeof (device as { serial?: unknown }).serial === 'string'
      && typeof (device as { slot?: unknown }).slot === 'string'
      ? [{ publicKey: reference.slice(8), serial: (device as { serial: string }).serial, slot: (device as { slot: string }).slot }] : []) : [];
  }));
  const observed = await hardware.listAndInspectDeviceKeys();
  const inspections = observed.inspections.filter((inspection) => selectedSerial === undefined || inspection.serial === selectedSerial);
  const issues: Array<Record<string, unknown>> = []; const stale = new Set<string>();
  for (const inspection of inspections) {
    if (inspection.serial === undefined) continue;
    for (const location of catalogLocations.filter((candidate) => candidate.serial === inspection.serial)) {
      const slot = inspection.slots.find((candidate) => candidate.slot === location.slot);
      if (slot?.status === 'empty' || slot?.status === 'occupied' && slot.publicKey !== undefined && slot.publicKey !== location.publicKey) {
        issues.push({ kind: slot.status === 'empty' ? 'empty-slot' : 'changed-key', ...location,
          ...(slot.publicKey === undefined ? {} : { observedPublicKey: slot.publicKey }) });
        stale.add(`${location.publicKey}\0${location.serial}\0${location.slot}`);
      }
    }
    for (const slot of inspection.slots) if (slot.status === 'occupied' && slot.publicKey !== undefined
      && slot.algorithm?.toLowerCase() === 'ed25519'
      && !catalogLocations.some((location) => location.serial === inspection.serial && location.slot === slot.slot)) {
      issues.push({ kind: 'uncataloged-slot', publicKey: slot.publicKey, serial: inspection.serial, slot: slot.slot });
    }
  }
  return { issues, stale };
}

async function inspectIdentityRootIntegrity(
  hardware: IdentityYubiKeyService, registry: IdentitySourceRegistry, selectedSerial?: string,
) {
  const document = await registry.read();
  const locations = Object.entries(document.sources).flatMap(([id, record]) => record.backends.flatMap((backend) =>
    backend.backend === 'yubikey-piv' ? backend.locations.flatMap((location) => typeof location.serial === 'string'
      ? [{ id, publicKey: record.rootPublicKey, serial: location.serial }] : []) : []));
  const serials = selectedSerial === undefined
    ? [...new Set((await hardware.listDevices()).flatMap((device) => device.serial === undefined ? [] : [device.serial]))]
    : [selectedSerial];
  const issues: Array<Record<string, unknown>> = []; const stale: typeof locations = [];
  for (const serial of serials) {
    const observed = await hardware.inspectRoot(serial);
    const cataloged = locations.filter((candidate) => candidate.serial === serial);
    for (const location of cataloged) {
      if (observed.status === 'empty' || observed.status === 'occupied' && observed.publicKey !== undefined && observed.publicKey !== location.publicKey) {
        issues.push({ kind: observed.status === 'empty' ? 'empty-root-slot' : 'changed-root', ...location,
          ...(observed.publicKey === undefined ? {} : { observedPublicKey: observed.publicKey }) }); stale.push(location);
      }
    }
    if (observed.status === 'occupied' && observed.publicKey !== undefined && cataloged.length === 0) {
      issues.push({ kind: 'uncataloged-root', publicKey: observed.publicKey, serial, slot: '9d' });
    }
  }
  return { issues, stale };
}

function applySigningRepair(stale: Set<string>): string[] {
  return forgetYubiKeyInventoryLocators(({ publicKey, device }) => device.kind === 'yubikey'
    && stale.has(`${publicKey}\0${device.serial}\0${device.slot}`)).removedPublicKeys;
}
