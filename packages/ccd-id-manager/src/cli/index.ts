import { Command, CommanderError, InvalidArgumentError, Option } from 'commander';
import { z } from 'zod';
import { commanderExitCode, disableHelpCommands } from '@ccd-agent-kit/cli-utils';
import type { IdentitySourceService } from '../core/sources/types.js';
import { IdentityWorkflowError } from '../core/workflowErrors.js';
import type {
  IdentityRecoveryInput, IdentityRequestInput, IdentityWorkflow, PrepareAccountInput,
} from '../core/workflowTypes.js';
import { IdentityProviderError } from '../core/providers/error.js';
import type {
  CanonicalNetwork,
  IdentityProviderService,
  ProviderPatch,
} from '../core/providers/types.js';
import { safeHttpUrl } from '../core/workflowValidation.js';
import { IDENTITY_SOURCE_ID_PATTERN, normalizeCatalogLabel, type CatalogLabelMode } from '@ccd-agent-kit/config-utils';

const issuanceMethodSchema = z.string().toUpperCase().pipe(z.enum(['GET', 'POST']));

/** Trusted CLI injection boundary; services and interaction callbacks are never CLI arguments. */
export interface IdentityCliDependencies {
  /** JSON/help output; defaults to process stdout. */
  stdout?: (text: string) => void;
  /** Sanitized errors and terminal prompts; defaults to process stderr. */
  stderr?: (text: string) => void;
  /** Optional workflow injection; default construction remains lazy so help does not load native bindings. */
  workflow?: IdentityWorkflow;
  /** Optional source service injection; runtime construction is lazy. */
  sourceService?: IdentitySourceService;
  /** Optional provider service injection; default construction is lazy. */
  providerService?: IdentityProviderService;
  /** Optional canonical resolver shared by all network-scoped CLI commands. */
  resolveProviderNetwork?: (selector?: string) => CanonicalNetwork;
}

/**
 * Run the thin identity CLI adapter; help stays lazy and errors never echo secret arguments.
 * The global network selector is resolved only by network-scoped commands.
 *
 * @param argv - Process arguments without the executable paths.
 * @param deps - Trusted service and output-boundary overrides.
 * @returns Zero for successful commands and help, two for usage failures, one for
 * domain failures, or a custom status carried by a CCD command failure.
 */
export async function runCli(argv: string[], deps: IdentityCliDependencies = {}): Promise<number> {
  const stdout = deps.stdout ?? ((text: string) => { process.stdout.write(text); });
  const stderr = deps.stderr ?? ((text: string) => { process.stderr.write(text); });
  let defaultProviderService: Promise<IdentityProviderService> | undefined;
  const getProviderService = async () => {
    if (deps.providerService) return deps.providerService;
    defaultProviderService ??= import('../core/providers/serviceFactory.js')
      .then(({ createDefaultIdentityProviderService }) => createDefaultIdentityProviderService());
    return defaultProviderService;
  };
  const getProviderNetwork = async (command: Command) => {
    const selector = command.optsWithGlobals<{ network?: string }>().network;
    const network = deps.resolveProviderNetwork
      ? deps.resolveProviderNetwork(selector)
      : (await import('../core/providers/serviceFactory.js')).resolveProviderNetwork(selector);
    stderr(`Network: ${network.caip2}\n`);
    return network;
  };
  let defaultSourceService: Promise<IdentitySourceService> | undefined;
  const getSourceService = async () => {
    if (deps.sourceService) return deps.sourceService;
    defaultSourceService ??= import('../core/sources/runtime.js')
      .then(({ createDefaultIdentitySourceService }) => createDefaultIdentitySourceService());
    return defaultSourceService;
  };
  let defaultWorkflow: Promise<IdentityWorkflow> | undefined;
  const getWorkflow = async () => {
    if (deps.workflow) return deps.workflow;
    defaultWorkflow ??= Promise.all([
      import('../core/workflowInfrastructure.js'), getProviderService(), getSourceService(),
    ]).then(([{ createDefaultIdentityWorkflow }, providers, sources]) =>
      createDefaultIdentityWorkflow({
        providerPolicy: 'cli', providers, sources,
      }));
    return defaultWorkflow;
  };
  const json = (value: unknown) => stdout(`${JSON.stringify(value, null, 2)}\n`);
  const sourceSelector = (value: string): string => {
    if (IDENTITY_SOURCE_ID_PATTERN.test(value)) return value;
    try { return normalizeCatalogLabel(value); }
    catch { throw new InvalidArgumentError('A valid source label or ID is required.'); }
  };
  const program = new Command('ccd-id-manager').description('Concordium identity workflows')
    .option('--network <network>', 'Explicit selector; otherwise CCD_NETWORK, then the configured default');
  program.configureHelp({ showGlobalOptions: true });
  program.exitOverride().showHelpAfterError().configureOutput({ writeOut: stdout, writeErr: stderr });
  const integer = (value: string): number => {
    if (!/^\d+$/.test(value)) throw new InvalidArgumentError('A non-negative integer is required.');
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed)) throw new InvalidArgumentError('A safe integer is required.');
    return parsed;
  };
  const boundedInteger = (minimum: number, maximum: number, description: string) => (value: string): number => {
    const parsed = integer(value);
    if (parsed < minimum || parsed > maximum) {
      throw new InvalidArgumentError(`${description} must be between ${minimum} and ${maximum}.`);
    }
    return parsed;
  };
  const positiveInteger = boundedInteger(1, Number.MAX_SAFE_INTEGER, 'The value');
  const identityIndex = boundedInteger(0, 0x7fffffff, 'Identity index');
  const credentialNumber = boundedInteger(0, 255, 'Credential number');
  const credentialThreshold = boundedInteger(1, 255, 'Credential threshold');
  const publicKeys = (value: string): Record<string, string> => {
    try {
      const parsed: unknown = JSON.parse(value);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error();
      return parsed as Record<string, string>;
    } catch { throw new InvalidArgumentError('Public keys must be a JSON object keyed by credential key index.'); }
  };
  const requestTimeoutHours = (value: string): number => {
    const hours = Number(value);
    const seconds = hours * 3_600;
    if (!Number.isFinite(hours) || hours <= 0 || !Number.isSafeInteger(seconds)
      || !Number.isSafeInteger(seconds * 1_000)) {
      throw new InvalidArgumentError('Hours must produce a positive whole-second safe timeout.');
    }
    return seconds;
  };
  const providerSelector = (value: string): number | string => {
    if (/^\d+$/.test(value)) return integer(value);
    try { return normalizeCatalogLabel(value); }
    catch { throw new InvalidArgumentError('A valid provider index or label is required.'); }
  };
  const providerLabel = (value: string): string => {
    try { return normalizeCatalogLabel(value); }
    catch { throw new InvalidArgumentError('A valid provider label is required.'); }
  };
  const identityLabel = (value: string): string => {
    try { return normalizeCatalogLabel(value); }
    catch { throw new InvalidArgumentError('A valid identity label is required.'); }
  };
  const labelMode = (value: string): CatalogLabelMode => {
    if (value !== 'hard' && value !== 'soft') throw new InvalidArgumentError('Label mode must be hard or soft.');
    return value;
  };
  const httpUrl = (command: Command, flag: string) => (value: string): string => {
    try { safeHttpUrl(value); return value; }
    catch { command.error(`${flag} has an invalid HTTP endpoint.`); }
  };
  const issuanceMethod = (value: string): 'GET' | 'POST' => {
    const result = issuanceMethodSchema.safeParse(value);
    if (!result.success) throw new InvalidArgumentError('Issuance method must be GET or POST.');
    return result.data;
  };
  const arIdentityList = (value: string): number[] => {
    const tokens = value.split(',');
    if (tokens.length === 0 || tokens.some(token => !/^[1-9]\d*$/.test(token))) {
      throw new InvalidArgumentError('AR identities must be comma-separated positive decimal integers.');
    }
    const identities = tokens.map(Number);
    if (identities.some(identity => identity > 0xffff_ffff) || new Set(identities).size !== identities.length) {
      throw new InvalidArgumentError('AR identities must be unique positive uint32 values.');
    }
    return identities;
  };
  const arThreshold = (value: string): number => {
    if (!/^[1-9]\d*$/.test(value)) throw new InvalidArgumentError('AR threshold must be a positive integer.');
    const threshold = Number(value);
    if (threshold > 255) throw new InvalidArgumentError('AR threshold must not exceed 255.');
    return threshold;
  };
  const withProvider = (command: Command) => command.requiredOption(
    '--idp <index-or-label>', 'Identity provider index or label', providerSelector,
  );
  const idp = program.command('idp').description('Configure network-scoped identity providers');
  idp.command('discover').description('Discover provider inventory from a finalized block')
    .action(async (_options, command) => {
      const network = await getProviderNetwork(command);
      json(await (await getProviderService()).refresh({ network }));
    });
  idp.command('list').description('List safe local provider inventory')
    .action(async (_options, command) => {
      const network = await getProviderNetwork(command);
      json(await (await getProviderService()).inventory({ network }));
    });
  withProvider(idp.command('inspect').description('Inspect one provider configuration'))
    .action(async (options: { idp: number | string }, command: Command) => {
      const network = await getProviderNetwork(command);
      json(await (await getProviderService()).inspect({
        network, selector: options.idp,
      }));
    });
  const configure = withProvider(idp.command('configure').description('Configure one provider'));
  configure
    .option('--label <name>', 'Local provider label', providerLabel)
    .option('--mode <mode>', 'Label protection mode (hard or soft)', labelMode)
    .option('--issuance <url>', 'Identity issuance endpoint', httpUrl(configure, '--issuance'))
    .option('--recovery <url>', 'Identity recovery endpoint', httpUrl(configure, '--recovery'))
    .option('--issuance-method <method>', 'Identity issuance method (GET or POST)', issuanceMethod)
    .option('--ars <csv>', 'Comma-separated anonymity revoker identities', arIdentityList)
    .option('--ar-threshold <number>', 'Anonymity revoker threshold', arThreshold)
    .option('--clear-ars', 'Clear configured anonymity revoker identities')
    .option('--clear-ar-threshold', 'Clear configured anonymity revoker threshold')
    .action(async (options: {
      idp: number | string; label?: string; mode?: CatalogLabelMode; issuance?: string; recovery?: string;
      issuanceMethod?: 'GET' | 'POST'; ars?: number[]; arThreshold?: number;
      clearArs?: boolean; clearArThreshold?: boolean;
    }, command: Command) => {
      if (options.ars !== undefined && options.clearArs) command.error('--ars conflicts with --clear-ars.');
      if (options.arThreshold !== undefined && options.clearArThreshold) {
        command.error('--ar-threshold conflicts with --clear-ar-threshold.');
      }
      const patch: ProviderPatch = {
        ...(options.label === undefined ? {} : { label: options.label }),
        ...(options.mode === undefined ? {} : { mode: options.mode }),
        ...(options.issuance === undefined ? {} : { issuanceUrl: options.issuance }),
        ...(options.recovery === undefined ? {} : { recoveryUrl: options.recovery }),
        ...(options.issuanceMethod === undefined ? {} : { issuanceMethod: options.issuanceMethod }),
        ...(options.clearArs ? { anonymityRevokers: null }
          : options.ars === undefined ? {} : { anonymityRevokers: options.ars }),
        ...(options.clearArThreshold ? { anonymityRevokerThreshold: null }
          : options.arThreshold === undefined ? {} : { anonymityRevokerThreshold: options.arThreshold }),
      };
      if (Object.keys(patch).length === 0) command.error('Specify at least one provider setting.');
      const network = await getProviderNetwork(command);
      json(await (await getProviderService()).configure({
        network, selector: options.idp, patch,
      }));
    });
  for (const [operation, enabled] of [['enable', true], ['disable', false]] as const) {
    withProvider(idp.command(operation).description(`${operation} one provider`))
      .action(async (options: { idp: number | string }, command: Command) => {
        const network = await getProviderNetwork(command);
        json(await (await getProviderService()).setEnabled({
          network, selector: options.idp, enabled,
        }));
      });
  }
  const identity = program.command('identity').description('Network-scoped identity workflows');
  identity.command('request').description('Request an identity')
    .option('--source <source>', 'Source label or ID', sourceSelector)
    .option('--label <label>', 'Initial operator or agent identity label', identityLabel)
    .option('--mode <mode>', 'Initial label protection mode (hard or soft)', labelMode)
    .requiredOption('--idp <index-or-label>', 'Identity provider index or label', providerSelector)
    .option('--identity-index <number>', 'Identity index (default: discover and allocate)', identityIndex)
    .action(async (options: { source?: string; label?: string; mode?: CatalogLabelMode; idp: number | string; identityIndex?: number }, command: Command) => {
      if (options.mode !== undefined && options.label === undefined) command.error('--mode requires --label.');
      const network = await getProviderNetwork(command);
      const selected = await (await getProviderService()).resolve({
        network, selector: options.idp, requireEnabled: false,
      });
      const input: IdentityRequestInput = {
        network: network.caip2, identityProviderIndex: selected.index,
        ...(options.source === undefined ? {} : { source: options.source }),
        ...(options.label === undefined ? {} : { label: options.label }),
        ...(options.mode === undefined ? {} : { mode: options.mode }),
        ...(options.identityIndex === undefined ? {} : { identityIndex: options.identityIndex }),
      };
      json(await (await getWorkflow()).request(input));
    });
  const identityLabelCommand = identity.command('label').description('Set or remove an operator identity label');
  identityLabelCommand.command('set').description('Set or convert an operator identity label')
    .requiredOption('--identity <id-or-label>', 'Opaque identity identifier or bare label')
    .option('--label <label>', 'Bare identity label', identityLabel)
    .option('--mode <mode>', 'Label protection mode (hard or soft)', labelMode)
    .action(async (options: { identity: string; label?: string; mode?: CatalogLabelMode }, command: Command) => {
      if (options.label === undefined && options.mode === undefined) command.error('Specify --label or --mode.');
      const network = await getProviderNetwork(command);
      json(await (await getWorkflow()).setOperatorIdentityLabel({
        network: network.caip2, identityId: options.identity, operation: 'set',
        ...(options.label === undefined ? {} : { label: options.label }),
        ...(options.mode === undefined ? {} : { mode: options.mode }),
      }));
    });
  identityLabelCommand.command('remove').description('Remove an operator identity label')
    .requiredOption('--identity <id-or-label>', 'Opaque identity identifier or bare label')
    .action(async (options: { identity: string }, command: Command) => {
      const network = await getProviderNetwork(command);
      json(await (await getWorkflow()).setOperatorIdentityLabel({
        network: network.caip2, identityId: options.identity, operation: 'remove',
      }));
    });
  identity.command('recover').description('Recover an identity')
    .option('--source <source>', 'Source label or ID', sourceSelector)
    .requiredOption('--idp <index-or-label>', 'Identity provider index or label', providerSelector)
    .requiredOption('--identity-index <number>', 'Identity index', identityIndex)
    .action(async (options: { source?: string; idp: number | string; identityIndex: number }, command: Command) => {
      const network = await getProviderNetwork(command);
      const selected = await (await getProviderService()).resolve({
        network, selector: options.idp, requireEnabled: false,
      });
      const input: IdentityRecoveryInput = {
        network: network.caip2, identityProviderIndex: selected.index, identityIndex: options.identityIndex,
        ...(options.source === undefined ? {} : { source: options.source }),
      };
      json(await (await getWorkflow()).recover(input));
    });
  identity.command('discover').description('Discover identities')
    .option('--source <source>', 'Source label or ID', sourceSelector)
    .option('--idp <index-or-label>', 'Identity provider index or label', providerSelector)
    .option('--gap-limit <number>', 'Consecutive definitive misses (default: 3)', positiveInteger)
    .option('--start-index <number>', 'Inclusive identity index', identityIndex)
    .option('--end-index <number>', 'Inclusive identity index', identityIndex)
    .action(async (options: {
      source?: string; idp?: number | string; gapLimit?: number; startIndex?: number; endIndex?: number;
    }, command: Command) => {
      if (options.startIndex !== undefined && options.endIndex !== undefined
        && options.startIndex > options.endIndex) {
        command.error('--start-index must not exceed --end-index.');
      }
      const network = await getProviderNetwork(command);
      const selected = options.idp === undefined ? undefined : await (await getProviderService()).resolve({
        network, selector: options.idp, requireEnabled: true,
      });
      json(await (await getWorkflow()).discoverIdentities({
        network: network.caip2,
        ...(options.source === undefined ? {} : { source: options.source }),
        ...(selected === undefined ? {} : { identityProviderIndex: selected.index }),
        ...(options.gapLimit === undefined ? {} : { gapLimit: options.gapLimit }),
        ...(options.startIndex === undefined ? {} : { startIndex: options.startIndex }),
        ...(options.endIndex === undefined ? {} : { endIndex: options.endIndex }),
      }));
    });
  identity.command('associate').description('Associate an identity with its source')
    .requiredOption('--identity <id>', 'Opaque identity identifier')
    .option('--source <source>', 'Source label or ID', sourceSelector)
    .action(async (options: { identity: string; source?: string }, command: Command) => {
      const network = await getProviderNetwork(command);
      json(await (await getWorkflow()).associateIdentitySource({
        network: network.caip2, identityId: options.identity,
        ...(options.source === undefined ? {} : { source: options.source }),
      }));
    });
  identity.command('status').description('Get identity workflow status')
    .requiredOption('--identity <id>', 'Opaque identity identifier')
    .option('--callback-url <url>', 'Provider callback URL')
    .action(async (options: { identity: string; callbackUrl?: string }, command: Command) => {
      const network = await getProviderNetwork(command);
      const workflow = await getWorkflow();
      json(await workflow.status({
        network: network.caip2, identityId: options.identity,
        ...(options.callbackUrl === undefined ? {} : { callbackUrl: options.callbackUrl }),
      }));
    });
  identity.command('list').description('List safe identity summaries')
    .action(async (_options, command) => {
      const network = await getProviderNetwork(command);
      json(await (await getWorkflow()).list({ network: network.caip2 }));
    });
  identity.command('configure').description('Configure network-scoped identity workflow settings')
    .requiredOption(
      '--request-timeout-hours <hours>',
      'Reservation timeout before a required provider recheck',
      requestTimeoutHours,
    )
    .action(async (options: { requestTimeoutHours: number }, command: Command) => {
      const network = await getProviderNetwork(command);
      json(await (await getProviderService()).configureIdentityRequestTimeout({
        network, seconds: options.requestTimeoutHours,
      }));
    });
  const account = program.command('account').description('Network-scoped account-opening handoffs');
  account.command('discover').description('Discover account credentials')
    .requiredOption('--identity <id>', 'Opaque identity identifier')
    .option('--gap-limit <number>', 'Consecutive definitive misses (default: 3)', positiveInteger)
    .addOption(new Option('--start-credential-number <number>', 'Inclusive credential number')
      .argParser(credentialNumber).conflicts('full'))
    .addOption(new Option('--end-credential-number <number>', 'Inclusive credential number')
      .argParser(credentialNumber).conflicts('full'))
    .addOption(new Option('--full', 'Scan the complete bounded credential range')
      .conflicts(['startCredentialNumber', 'endCredentialNumber']))
    .action(async (options: {
      identity: string; gapLimit?: number; startCredentialNumber?: number;
      endCredentialNumber?: number; full?: boolean;
    }, command: Command) => {
      if (options.startCredentialNumber !== undefined && options.endCredentialNumber !== undefined
        && options.startCredentialNumber > options.endCredentialNumber) {
        command.error('--start-credential-number must not exceed --end-credential-number.');
      }
      const network = await getProviderNetwork(command);
      json(await (await getWorkflow()).discoverAccountCredentials({
        network: network.caip2, identityId: options.identity,
        ...(options.gapLimit === undefined ? {} : { gapLimit: options.gapLimit }),
        ...(options.startCredentialNumber === undefined ? {} : { startCredentialNumber: options.startCredentialNumber }),
        ...(options.endCredentialNumber === undefined ? {} : { endCredentialNumber: options.endCredentialNumber }),
        ...(options.full === true ? { full: true } : {}),
      }));
    });
  account.command('prepare')
    .description('Prepare an unsigned account-opening signer handoff')
    .requiredOption('--identity <id>', 'Opaque identity identifier')
    .option('--credential-number <number>', 'Credential number (default: discover unused)', integer)
    .requiredOption('--public-keys <json>', 'Indexed externally held Ed25519 public keys as JSON', publicKeys)
    .requiredOption('--credential-threshold <number>', 'Credential signature threshold', credentialThreshold)
    .requiredOption('--expiry-seconds <number>', 'Expiry in Unix seconds', integer)
    .option('--reveal-attribute <name...>', 'Identity attributes to make public on-chain')
    .action(async (options: { identity: string; credentialNumber?: number; publicKeys: Record<string, string>; credentialThreshold: number; expirySeconds: number; revealAttribute?: string[] }, command: Command) => {
      const network = await getProviderNetwork(command);
      const input: PrepareAccountInput = {
        network: network.caip2,
        identityId: options.identity,
        ...(options.credentialNumber === undefined ? {} : { credentialNumber: options.credentialNumber }),
        ...(options.revealAttribute === undefined ? {} : { revealAttributes: options.revealAttribute }),
        publicKeys: options.publicKeys, credentialThreshold: options.credentialThreshold,
        expirySeconds: options.expirySeconds,
      } as PrepareAccountInput;
      json(await (await getWorkflow()).prepareAccount(input));
    });
  account.command('reconcile').description('Reconcile a pending account opening at one finalized block')
    .requiredOption('--identity <id>', 'Opaque identity identifier')
    .action(async (options: { identity: string }, command: Command) => {
      const network = await getProviderNetwork(command);
      json(await (await getWorkflow()).reconcileAccountOpening({
        network: network.caip2, identityId: options.identity,
      }));
    });
  disableHelpCommands(program);
  try {
    await program.parseAsync(argv.length ? argv : ['--help'], { from: 'user' });
    return 0;
  } catch (error) {
    if (error instanceof CommanderError) {
      return commanderExitCode(error);
    }
    const message = error instanceof IdentityProviderError || error instanceof IdentityWorkflowError
      ? error.message
      : 'Identity operation failed.';
    stderr(`${message}\n`);
    return 1;
  }
}
