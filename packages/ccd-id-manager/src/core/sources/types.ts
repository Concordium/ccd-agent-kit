import type { PivPinPolicy, PivTouchPolicy } from '@ccd-agent-kit/piv-utils';
import type { IdentitySourceRecord, IdentitySourceRegistry } from '@ccd-agent-kit/config-utils';
import type { IdentityRootAgreement } from '../identityRoot.js';

/** Fresh, producer-validated backend-neutral observation used to project source availability. */
export type IdentitySourceBackendInspection =
  | {
    status: 'present';
    rootPublicKey: string;
    authorization: 'unlocked' | 'locked';
    pinPolicy?: PivPinPolicy;
    touchPolicy?: PivTouchPolicy;
  }
  | { status: 'unavailable'; reason: IdentitySourceUnavailableReason };

/** Stable sanitized reasons exposed only by source CLI inspection. */
export type IdentitySourceUnavailableReason =
  | 'DEVICE_MISSING' | 'DEVICE_BUSY' | 'ROOT_MISMATCH'
  | 'UNSUPPORTED_BACKEND' | 'UNSUPPORTED_METADATA' | 'UNREADABLE';

/** Backend adapter that owns observation parsing and explicit operation-bound agreement creation. */
export interface IdentitySourceBackend {
  backend: string;
  /** Refresh cached public-slot observations for exactly the referenced locations. */
  refresh?(locators: Record<string, unknown>[]): Promise<void>;
  /** Drop cached observations for locations no longer referenced by the catalog. */
  retain?(locators: Record<string, unknown>[]): Promise<void>;
  inspect(locator: Record<string, unknown>, binding?: {
    sourceId: string;
    expectedPublicKey: Uint8Array;
  }): Promise<IdentitySourceBackendInspection>;
  createAgreement(input: {
    sourceId: string;
    locator: Record<string, unknown>;
    expectedPublicKey: Uint8Array;
    promptPin?: () => Promise<string>;
  }): IdentityRootAgreement;
}

/** A trusted persisted identity source paired with its deterministic identifier. */
export type ResolvedIdentitySource = IdentitySourceRecord & { id: string };

/** Safe detailed source view returned by inspection. */
export interface IdentitySourceInspectionResult extends Omit<IdentitySourceRecord, 'label'> {
  id: string;
  /** Bare configured label; absent sources remain visibly unlabeled. */
  label?: string;
  isDefault: boolean;
  availability: 'unlocked' | 'locked' | 'unavailable';
  reason?: IdentitySourceUnavailableReason;
  pinPolicy?: PivPinPolicy;
  touchPolicy?: PivTouchPolicy;
}

/** Backend-neutral identity source operations. */
export interface IdentitySourceService {
  /** Explicitly reconcile configured sources with currently available hardware. */
  refresh(): Promise<void>;
  list(): Promise<Array<Pick<IdentitySourceInspectionResult, 'id' | 'label' | 'isDefault' | 'availability'>>>;
  /** Read cloned persisted source records without inspecting hardware or resolving a default. */
  records(): Promise<ResolvedIdentitySource[]>;
  inspect(source: string): Promise<IdentitySourceInspectionResult>;
  resolve(source?: string): Promise<ResolvedIdentitySource>;
  createAgreement(source: string, options?: { promptPin?: () => Promise<string> }): Promise<IdentityRootAgreement>;
  /** Release retained hardware connections owned by this service. */
  close?(): Promise<void>;
}

/** Construction options for backend-neutral identity-source operations. */
export interface IdentitySourceServiceOptions {
  registry: IdentitySourceRegistry;
  backends: IdentitySourceBackend[];
  /** Runtime policy gate, checked before backend inspection and agreement use. */
  isBackendEnabled?(backend: string): boolean;
  prepare?: () => Promise<void>;
  /** Reconcile source lifecycle state after an authenticated runtime notification. */
  refresh: () => Promise<void>;
  close?: () => Promise<void>;
}
