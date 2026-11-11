import type { IdentityContextSnapshot } from '@ccd-agent-kit/sdk-utils';
import type { CatalogLabelMode } from '@ccd-agent-kit/config-utils';

/** Canonical CAIP-2 identity paired with its complete genesis hash. */
export interface CanonicalNetwork { caip2: string; genesisHash: string }

/** One node-derived, safe provider inventory entry. */
export interface ProviderInventoryEntry { index: number; name: string; description?: string }

/** Version-one node-derived provider inventory. */
export interface ProviderInventory {
  version: 1;
  genesisHash: string;
  refreshedAt: string;
  providers: ProviderInventoryEntry[];
  anonymityRevokers: number[];
}

/** Mutable settings for one numeric provider index. */
export interface ProviderConfiguration {
  /** Persisted hard label or `@`-prefixed soft label. */
  label?: string;
  issuanceUrl?: string;
  recoveryUrl?: string;
  /** Issuance transport; omission preserves the legacy GET flow. */
  issuanceMethod?: IdentityIssuanceMethod;
  /** Configured AR identities; omission selects all fresh network ARs at issuance. */
  anonymityRevokers?: number[];
  /** Configured AR threshold; omission resolves to the selected count minus one. */
  anonymityRevokerThreshold?: number;
  enabled: boolean;
}

/** Supported identity issuance HTTP methods. */
export type IdentityIssuanceMethod = 'GET' | 'POST';

/** Version-one network-scoped provider settings. */
export interface ProviderSettings {
  version: 1;
  genesisHash: string;
  providers: Record<string, ProviderConfiguration>;
  defaultIdentityProvider?: number | undefined;
  /** Network-wide identity reservation reconciliation timeout in whole seconds. */
  identityRequestTimeoutSeconds?: number | undefined;
}

/** One consistent local settings and optional inventory observation. */
export interface ProviderRegistrySnapshot { settings: ProviderSettings; inventory?: ProviderInventory }

/** Protected network-scoped provider persistence boundary. */
export interface IdentityProviderRegistry {
  read(network: CanonicalNetwork): Promise<ProviderRegistrySnapshot>;
  updateSettings(
    network: CanonicalNetwork,
    update: (snapshot: ProviderRegistrySnapshot) => ProviderSettings,
  ): Promise<ProviderRegistrySnapshot>;
}

/** One finalized, node-verified public identity-provider context. */
export interface FinalizedIdentityProviderContext extends IdentityContextSnapshot {
  /** SDK derivation namespace selected only from the verified full genesis hash. */
  sdkNetwork: 'Mainnet' | 'Testnet';
}

/** Safe provider row suitable for list and MCP resource projection. */
export interface IdentityProviderProjectionEntry extends ProviderInventoryEntry {
  /** Bare local label, when configured. */
  label?: string;
  enabled: boolean;
}

/** Safe local provider projection with no endpoints or cryptographic keys. */
export interface IdentityProviderProjection {
  network: string;
  refreshedAt?: string;
  providers: IdentityProviderProjectionEntry[];
}

/** CLI-only detailed provider inspection. */
export interface IdentityProviderInspection extends IdentityProviderProjectionEntry {
  issuanceUrl?: string;
  recoveryUrl?: string;
  /** Effective issuance transport, including the default GET method. */
  issuanceMethod: IdentityIssuanceMethod;
  /** Configured AR identities; absent when issuance uses all network ARs. */
  anonymityRevokers?: number[];
  /** Configured threshold; absent when issuance uses the selected count minus one. */
  anonymityRevokerThreshold?: number;
}

/** Explicit mutable fields accepted by provider configuration. */
export interface ProviderPatch {
  /** New bare local label; omission preserves existing spelling during mode conversion. */
  label?: string;
  /** Label protection mode; omission preserves an existing mode and defaults a new label to hard. */
  mode?: CatalogLabelMode;
  issuanceUrl?: string;
  recoveryUrl?: string;
  /** Issuance transport to persist. */
  issuanceMethod?: IdentityIssuanceMethod;
  /** AR identities to select, `null` to clear, or omission to preserve. */
  anonymityRevokers?: number[] | null;
  /** AR threshold to set, `null` to clear, or omission to preserve. */
  anonymityRevokerThreshold?: number | null;
}

/** Complete action configuration resolved from protected settings. */
export interface ResolvedIdentityProvider {
  index: number;
  issuanceUrl: string;
  recoveryUrl: string;
  /** Effective issuance transport, including the default GET method. */
  issuanceMethod: IdentityIssuanceMethod;
  /** Configured AR identities, without applying a fresh network policy. */
  anonymityRevokers?: number[];
  /** Configured AR threshold, without computing an effective default. */
  anonymityRevokerThreshold?: number;
}

/** Persisted network-wide identity request timeout configuration. */
export interface IdentityRequestTimeoutConfiguration {
  /** Canonical CAIP-2 network identifier. */
  network: string;
  /** Positive whole-second timeout stored in protected provider settings. */
  identityRequestTimeoutSeconds: number;
}

/** Identity-provider configuration and resolution operations. */
export interface IdentityProviderService {
  inventory(input: { network: CanonicalNetwork }): Promise<IdentityProviderProjection>;
  refresh(input: { network: CanonicalNetwork }): Promise<IdentityProviderProjection>;
  inspect(input: { network: CanonicalNetwork; selector: number | string }): Promise<IdentityProviderInspection>;
  /** Atomically update one provider and return its complete post-update inspection. */
  configure(input: { network: CanonicalNetwork; selector: number | string; patch: ProviderPatch }): Promise<IdentityProviderInspection>;
  setEnabled(input: { network: CanonicalNetwork; selector: number | string; enabled: boolean }): Promise<IdentityProviderProjection>;
  /** Resolve an explicitly selected provider; persisted historical defaults are never consulted. */
  resolve(input: { network: CanonicalNetwork; selector: number | string; requireEnabled: boolean }): Promise<ResolvedIdentityProvider>;
  /** Return the configured identity request timeout in milliseconds, or the inert 24-hour default. */
  getIdentityRequestTimeoutMs(input: { network: CanonicalNetwork }): Promise<number>;
  /** Atomically persist the network-wide identity request timeout without changing provider records. */
  configureIdentityRequestTimeout(input: {
    network: CanonicalNetwork;
    seconds: number;
  }): Promise<IdentityRequestTimeoutConfiguration>;
}
