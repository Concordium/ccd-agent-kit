import {
  CatalogLabelError, findCatalogLabel, parseCatalogLabel, prepareCatalogLabelMutation,
} from '@ccd-agent-kit/config-utils';
import { safeHttpUrl } from '../workflowValidation.js';
import { IdentityProviderError } from './error.js';
import { providerInventory } from './inventory.js';
import { resolveAnonymityRevocationPolicy, validateStoredAnonymityRevocationPolicy } from './anonymityRevocation.js';
import type {
  CanonicalNetwork,
  FinalizedIdentityProviderContext,
  IdentityProviderInspection,
  IdentityProviderProjection,
  IdentityProviderRegistry,
  IdentityProviderService,
  ProviderConfiguration,
  ProviderPatch,
  ProviderRegistrySnapshot,
  ProviderSettings,
} from './types.js';

const MAX_ID = 0x7fffffff;
const DEFAULT_IDENTITY_REQUEST_TIMEOUT_SECONDS = 86_400;

function error(code: ConstructorParameters<typeof IdentityProviderError>[0]): never {
  throw new IdentityProviderError(code);
}
function validId(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_ID;
}
function validUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try { safeHttpUrl(value); return true; } catch { return false; }
}
function complete(
  configuration: ProviderConfiguration | undefined,
): configuration is ProviderConfiguration & { issuanceUrl: string; recoveryUrl: string } {
  return configuration?.issuanceUrl !== undefined && configuration.recoveryUrl !== undefined;
}
function providerExists(snapshot: ProviderRegistrySnapshot, index: number): boolean {
  return snapshot.inventory?.providers.some((provider) => provider.index === index) ?? false;
}
function effectivelyEnabled(snapshot: ProviderRegistrySnapshot, index: number): boolean {
  const configuration = snapshot.settings.providers[String(index)];
  return configuration?.enabled === true && complete(configuration) && providerExists(snapshot, index);
}

function selectorIndex(snapshot: ProviderRegistrySnapshot, selector: number | string): number {
  if (selector === undefined || selector === null) error('INVALID_SELECTOR');
  if (typeof selector === 'number') {
    if (!validId(selector)) error('INVALID_SELECTOR');
    return selector;
  }
  if (/^\d+$/.test(selector)) {
    const parsed = Number(selector);
    if (!validId(parsed)) error('INVALID_SELECTOR');
    return parsed;
  }
  let found: [string, ProviderConfiguration] | undefined;
  try {
    found = findCatalogLabel(Object.entries(snapshot.settings.providers), selector, ([, configuration]) => configuration.label);
  } catch { error('INVALID_SELECTOR'); }
  if (!found) error('PROVIDER_NOT_FOUND');
  return Number(found[0]);
}

function requireKnown(snapshot: ProviderRegistrySnapshot, selector: number | string): number {
  const index = selectorIndex(snapshot, selector);
  if (!providerExists(snapshot, index)) error('PROVIDER_NOT_FOUND');
  return index;
}

function projection(network: CanonicalNetwork, snapshot: ProviderRegistrySnapshot): IdentityProviderProjection {
  const providers = [...(snapshot.inventory?.providers ?? [])]
    .sort((left, right) => left.index - right.index)
    .map((provider) => {
      const configuration = snapshot.settings.providers[String(provider.index)];
      return {
        ...provider,
        ...(configuration?.label === undefined ? {} : { label: parseCatalogLabel(configuration.label).label }),
        enabled: effectivelyEnabled(snapshot, provider.index),
      };
    });
  return {
    network: network.caip2,
    ...(snapshot.inventory === undefined ? {} : { refreshedAt: snapshot.inventory.refreshedAt }),
    providers,
  };
}

function inspection(snapshot: ProviderRegistrySnapshot, selector: number | string): IdentityProviderInspection {
  const index = requireKnown(snapshot, selector);
  const provider = snapshot.inventory!.providers.find((item) => item.index === index)!;
  const configuration = snapshot.settings.providers[String(index)];
  return {
    ...provider,
    ...(configuration?.label === undefined ? {} : { label: parseCatalogLabel(configuration.label).label }),
    enabled: effectivelyEnabled(snapshot, index),
    ...(configuration?.issuanceUrl === undefined ? {} : { issuanceUrl: configuration.issuanceUrl }),
    ...(configuration?.recoveryUrl === undefined ? {} : { recoveryUrl: configuration.recoveryUrl }),
    issuanceMethod: configuration?.issuanceMethod ?? 'GET',
    ...(configuration?.anonymityRevokers === undefined ? {} : {
      anonymityRevokers: [...configuration.anonymityRevokers],
    }),
    ...(configuration?.anonymityRevokerThreshold === undefined ? {} : {
      anonymityRevokerThreshold: configuration.anonymityRevokerThreshold,
    }),
  };
}

function clonedSettings(settings: ProviderSettings): ProviderSettings { return structuredClone(settings); }

function validatePatch(patch: ProviderPatch): void {
  const keys = Object.keys(patch);
  if (keys.length === 0 || !keys.every((key) => [
    'label', 'mode', 'issuanceUrl', 'recoveryUrl', 'issuanceMethod',
    'anonymityRevokers', 'anonymityRevokerThreshold',
  ].includes(key))) {
    error('INVALID_CONFIGURATION');
  }
  if (patch.label !== undefined) {
    try { prepareCatalogLabelMutation({
      operation: 'set', label: patch.label, ...(patch.mode === undefined ? {} : { mode: patch.mode }),
    }); }
    catch { error('INVALID_LABEL'); }
  }
  if (patch.mode !== undefined && patch.mode !== 'hard' && patch.mode !== 'soft') error('INVALID_LABEL');
  if (patch.issuanceUrl !== undefined && !validUrl(patch.issuanceUrl)) error('INVALID_CONFIGURATION');
  if (patch.recoveryUrl !== undefined && !validUrl(patch.recoveryUrl)) error('INVALID_CONFIGURATION');
  if (patch.issuanceMethod !== undefined && patch.issuanceMethod !== 'GET' && patch.issuanceMethod !== 'POST') {
    error('INVALID_CONFIGURATION');
  }
  if (patch.anonymityRevokers !== undefined && patch.anonymityRevokers !== null) {
    // Validate the partial list without applying a default before merging the stored threshold.
    validateStoredAnonymityRevocationPolicy({
      anonymityRevokers: patch.anonymityRevokers, anonymityRevokerThreshold: 1,
    });
  }
  if (patch.anonymityRevokerThreshold !== undefined && patch.anonymityRevokerThreshold !== null) {
    validateStoredAnonymityRevocationPolicy({ anonymityRevokerThreshold: patch.anonymityRevokerThreshold });
  }
}

function requireComplete(configuration: ProviderConfiguration | undefined): asserts configuration is ProviderConfiguration & {
  issuanceUrl: string; recoveryUrl: string;
} {
  const issuance = configuration?.issuanceUrl !== undefined;
  const recovery = configuration?.recoveryUrl !== undefined;
  if (!issuance && !recovery) error('PROVIDER_NOT_CONFIGURED');
  if (!issuance) error('ISSUANCE_NOT_CONFIGURED');
  if (!recovery) error('RECOVERY_NOT_CONFIGURED');
}

function contextMatches(network: CanonicalNetwork, context: FinalizedIdentityProviderContext): boolean {
  return context.network.caip2 === network.caip2 && context.network.genesisHash === network.genesisHash;
}

/** Create the provider policy service from typed persistence and node-boundary collaborators. */
export function createIdentityProviderService(deps: {
  registry: IdentityProviderRegistry;
  readNodeContext(network: CanonicalNetwork): Promise<FinalizedIdentityProviderContext>;
}): IdentityProviderService {
  const resolveFrom = (snapshot: ProviderRegistrySnapshot, selector: number | string, requireEnabled: boolean) => {
    const index = requireKnown(snapshot, selector);
    const configuration = snapshot.settings.providers[String(index)];
    requireComplete(configuration);
    if (requireEnabled && !effectivelyEnabled(snapshot, index)) error('PROVIDER_DISABLED');
    return {
      index,
      issuanceUrl: configuration.issuanceUrl,
      recoveryUrl: configuration.recoveryUrl,
      issuanceMethod: configuration.issuanceMethod ?? 'GET',
      ...(configuration.anonymityRevokers === undefined ? {} : {
        anonymityRevokers: [...configuration.anonymityRevokers],
      }),
      ...(configuration.anonymityRevokerThreshold === undefined ? {} : {
        anonymityRevokerThreshold: configuration.anonymityRevokerThreshold,
      }),
    };
  };
  return {
    async inventory({ network }) { return projection(network, await deps.registry.read(network)); },
    async refresh({ network }) {
      let context: FinalizedIdentityProviderContext;
      try { context = await deps.readNodeContext(network); }
      catch (failure) {
        if (failure instanceof IdentityProviderError) throw failure;
        throw new IdentityProviderError('NODE_FAILED');
      }
      if (!contextMatches(network, context)) error('CONTEXT_MISMATCH');
      const latest = await deps.registry.read(network);
      return projection(network, { ...latest, inventory: providerInventory(context) });
    },
    async inspect({ network, selector }) {
      const snapshot = await deps.registry.read(network);
      return inspection(snapshot, selector);
    },
    async configure({ network, selector, patch }) {
      validatePatch(patch);
      let configuredIndex: number | undefined;
      const updated = await deps.registry.updateSettings(network, (snapshot) => {
        const index = requireKnown(snapshot, selector);
        configuredIndex = index;
        const current = snapshot.settings.providers[String(index)] ?? { enabled: false };
        let label = current.label;
        if (patch.label !== undefined || patch.mode !== undefined) {
          try {
            label = prepareCatalogLabelMutation({
              ...(current.label === undefined ? {} : { current: current.label }), operation: 'set',
              ...(patch.label === undefined ? {} : { label: patch.label }),
              ...(patch.mode === undefined ? {} : { mode: patch.mode }),
              otherLabels: Object.entries(snapshot.settings.providers)
                .filter(([key]) => Number(key) !== index).map(([, provider]) => provider.label),
            });
          } catch (failure) {
            if (failure instanceof CatalogLabelError && failure.code === 'DUPLICATE_LABEL') error('DUPLICATE_LABEL');
            error('INVALID_LABEL');
          }
        }
        const next: ProviderConfiguration = {
          ...current,
          ...(label === undefined ? {} : { label }),
          ...(patch.issuanceUrl === undefined ? {} : { issuanceUrl: patch.issuanceUrl }),
          ...(patch.recoveryUrl === undefined ? {} : { recoveryUrl: patch.recoveryUrl }),
          ...(patch.issuanceMethod === undefined ? {} : { issuanceMethod: patch.issuanceMethod }),
        };
        if (patch.anonymityRevokers === null) delete next.anonymityRevokers;
        else if (patch.anonymityRevokers !== undefined) next.anonymityRevokers = [...patch.anonymityRevokers];
        if (patch.anonymityRevokerThreshold === null) delete next.anonymityRevokerThreshold;
        else if (patch.anonymityRevokerThreshold !== undefined) {
          next.anonymityRevokerThreshold = patch.anonymityRevokerThreshold;
        }
        const available = Object.fromEntries((snapshot.inventory?.anonymityRevokers ?? []).map((arIdentity) => [
          String(arIdentity), { arIdentity },
        ]));
        resolveAnonymityRevocationPolicy(next, available);
        const settings = clonedSettings(snapshot.settings);
        settings.providers[String(index)] = next;
        return settings;
      });
      return inspection(updated, configuredIndex!);
    },
    async setEnabled({ network, selector, enabled }) {
      const updated = await deps.registry.updateSettings(network, (snapshot) => {
        const index = requireKnown(snapshot, selector);
        const current = snapshot.settings.providers[String(index)] ?? { enabled: false };
        if (enabled) requireComplete(current);
        const settings = clonedSettings(snapshot.settings);
        settings.providers[String(index)] = { ...current, enabled };
        return settings;
      });
      return projection(network, updated);
    },
    async resolve({ network, selector, requireEnabled }) {
      return resolveFrom(await deps.registry.read(network), selector, requireEnabled);
    },
    async getIdentityRequestTimeoutMs({ network }) {
      const snapshot = await deps.registry.read(network);
      return (snapshot.settings.identityRequestTimeoutSeconds ?? DEFAULT_IDENTITY_REQUEST_TIMEOUT_SECONDS) * 1_000;
    },
    async configureIdentityRequestTimeout({ network, seconds }) {
      if (!Number.isSafeInteger(seconds) || seconds <= 0 || !Number.isSafeInteger(seconds * 1_000)) {
        error('INVALID_CONFIGURATION');
      }
      await deps.registry.updateSettings(network, snapshot => ({
        ...clonedSettings(snapshot.settings),
        identityRequestTimeoutSeconds: seconds,
      }));
      return { network: network.caip2, identityRequestTimeoutSeconds: seconds };
    },
  };
}
