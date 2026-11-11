import { isDeepStrictEqual } from 'node:util';

import {
  AttributesKeys, BlockHash, CredentialRegistrationId, IDENTITY_SUBJECT_SCHEMA,
  VerifiablePresentationV1, VerificationRequestV1, canProveAtomicStatement,
  createIdentityCommitmentInput, verifyAtomicStatements,
  type AtomicStatementV2, type IdentityObjectV1, type Network, type Versioned,
} from '@concordium/web-sdk';

import { identityLabelValue } from './identityLabels.js';
import { deriveAttributeRandomness, deriveCredentialRegistrationId, type IdentityMaterial } from './identityMaterial.js';
import { IdentityWorkflowError } from './workflowErrors.js';
import { catalogLabelKey, findCatalogLabel, IdentitySourceError } from '@ccd-agent-kit/config-utils';
import type { IdentityContext, StoredIdentity } from './workflowTypes.js';

/** Stable proof-service failures safe for CLI and MCP adapters to classify. */
export type IdentityProofErrorCode =
  | 'INVALID_REQUEST'
  | 'INVALID_ANCHOR'
  | 'NETWORK_FAILED'
  | 'STORAGE_FAILED'
  | 'SUBJECT_NOT_FOUND'
  | 'SUBJECT_UNAVAILABLE'
  | 'SUBJECT_INELIGIBLE'
  | 'NO_PROVABLE_CLAIMS'
  | 'PROOF_FAILED';

const errorMessages: Record<IdentityProofErrorCode, string> = {
  INVALID_REQUEST: 'The proof request is malformed or unsupported.',
  INVALID_ANCHOR: 'The proof request anchor is invalid.',
  NETWORK_FAILED: 'The selected network is unavailable.',
  STORAGE_FAILED: 'Protected identity state could not be read.',
  SUBJECT_NOT_FOUND: 'The selected proof subject was not found.',
  SUBJECT_UNAVAILABLE: 'The selected proof subject is unavailable.',
  SUBJECT_INELIGIBLE: 'The selected subject cannot satisfy this proof request.',
  NO_PROVABLE_CLAIMS: 'The proof request contains no subject-bound claim.',
  PROOF_FAILED: 'Identity proof generation or verification failed.',
};

/** Sanitized proof error that never retains an SDK, node, storage, or hardware cause. */
export class IdentityProofError extends Error {
  /** Construct a proof error from a stable public classification. */
  constructor(public readonly code: IdentityProofErrorCode) {
    super(errorMessages[code]);
    this.name = 'IdentityProofError';
  }
}

/** Subject selector accepted by identity proof generation. */
export type IdentityProofSubject =
  | { type: 'identity'; identityId: string }
  | { type: 'account'; account: string; credentialIndex?: number };

/** Safe local selector for a subject known to satisfy a proof request. */
export type IdentityProofCandidate =
  | { subject: { type: 'identity'; identityId: string }; label?: string }
  | { subject: { type: 'account'; account: string; credentialIndex: number }; label?: string };

/** Structured finalized request-anchor validation result. */
export type IdentityProofAnchor =
  | { status: 'valid'; transactionHash: string; blockHash: string; account: string }
  | { status: 'invalid'; reason: string };

/** Safe proof-request operations shared by stdio MCP and other adapters. */
export interface IdentityProofService {
  /** Strictly parse a standard request, verify its finalized anchor, and optionally describe it. */
  validateRequest(input: {
    network?: string;
    request: Record<string, unknown>;
    describe?: boolean;
  }): Promise<Record<string, unknown>>;
  /** Find local same-subject candidates without issuance, discovery, submission, or state mutation. */
  findCandidates(input: {
    network?: string;
    request: Record<string, unknown>;
  }): Promise<{ network: string; candidates: IdentityProofCandidate[] }>;
  /** Generate and locally verify one unchanged standard SDK presentation. */
  createProof(input: {
    network?: string;
    request: Record<string, unknown>;
    subject: IdentityProofSubject;
  }): Promise<{ network: string; presentation: Record<string, unknown> }>;
}

/** Secret scope passed only to an in-process proof operation and cleared by its owner afterwards. */
interface IdentityProofMaterialScope {
  seed: Buffer;
  material: IdentityMaterial;
  storageKey: Buffer;
}

/** Finalized normal account credential data required for account-backed proof generation. */
interface FinalizedProofCredential {
  account: string;
  credentialIndex: number;
  credentialId: string;
  issuer: number;
  commitments: Partial<Record<string, string>>;
  policy: { createdAt: string; validTo: string; revealedAttributes: Partial<Record<string, string>> };
}

interface FinalizedProofAccountState {
  account: string;
  sourceBlock: { hash: string; time: string };
  credentials: FinalizedProofCredential[];
  currentCredentials: Array<{ credentialIndex: number; credentialId: string }>;
}

interface CachedProofCredential {
  account: string;
  credentialIndex: number;
  credentialId: string;
}

/** Internal default seams used to assemble the proof service without exporting private material APIs. */
interface IdentityProofDependencies {
  resolveNetwork(selector?: string): { caip2: string; sdkNetwork: Network };
  listRecords(network: string): Promise<StoredIdentity[]>;
  loadIdentity(record: StoredIdentity, storageKey: Uint8Array): Promise<Versioned<IdentityObjectV1>>;
  loadLocalContext(record: StoredIdentity): Promise<IdentityProofContext | undefined>;
  loadGenerationContext(selection: StoredIdentity['selection'], blockHash: string): Promise<GenerationProofContext>;
  verifyAnchor(network: string, request: VerificationRequestV1.Type): Promise<IdentityProofAnchor>;
  loadFinalizedCredentials(network: string, account: string, blockHash: string): Promise<FinalizedProofAccountState>;
  loadCredentialRegistry(network: string): Promise<import('./workflowTypes.js').CredentialRegistry>;
  listCachedCredentials(network: string): Promise<CachedProofCredential[]>;
  withMaterial<T>(record: StoredIdentity, callback: (scope: IdentityProofMaterialScope) => Promise<T>): Promise<T>;
  createPresentation?: typeof VerifiablePresentationV1.create;
  verifyPresentation?: typeof VerifiablePresentationV1.verify;
}

type IdentityProofContext = Pick<IdentityContext,
  'network' | 'sdkNetwork' | 'genesisHash' | 'ipInfo' | 'arsInfos' | 'globalContext'>;

type GenerationProofContext = IdentityProofContext & {
  sourceBlock: { hash: string; time: string };
};

type ParsedRequest = VerificationRequestV1.Type;

const exactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const actual = Object.keys(value).sort();
  return isDeepStrictEqual(actual, [...keys].sort());
};

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function strictRequest(value: Record<string, unknown>): ParsedRequest {
  try {
    if (Buffer.byteLength(JSON.stringify(value), 'utf8') > 1_048_576) throw new Error();
    if (!exactKeys(value, ['type', 'context', 'subjectClaims', 'transactionRef'])
      || value.type !== 'ConcordiumVerificationRequestV1' || typeof value.transactionRef !== 'string'
      || !/^[0-9a-fA-F]{64}$/.test(value.transactionRef)) throw new Error();
    const context = object(value.context);
    if (!context || !exactKeys(context, ['type', 'given', 'requested'])
      || context.type !== 'ConcordiumUnfilledContextInformationV1'
      || !Array.isArray(context.given) || !Array.isArray(context.requested)) throw new Error();
    const labels = new Set(['ContextString', 'ResourceID', 'BlockHash', 'ConnectionID', 'Nonce']);
    const givenLabels = new Set<string>();
    for (const entryValue of context.given) {
      const entry = object(entryValue);
      if (!entry || !exactKeys(entry, ['label', 'context']) || typeof entry.label !== 'string'
        || !labels.has(entry.label)) throw new Error();
      if (givenLabels.has(entry.label)) throw new Error();
      givenLabels.add(entry.label);
      if (entry.label === 'Nonce') {
        if (typeof entry.context !== 'string' || !/^(?:[0-9a-fA-F]{2})+$/.test(entry.context)) throw new Error();
      } else if (typeof entry.context !== 'string') throw new Error();
    }
    if (context.requested.length > 1 || context.requested.some(label => label !== 'BlockHash'
      || givenLabels.has(label))) throw new Error();
    if (!Array.isArray(value.subjectClaims) || value.subjectClaims.length > 64) throw new Error();
    let statementCount = 0;
    for (const groupValue of value.subjectClaims) {
      const group = object(groupValue);
      if (!group || !exactKeys(group, ['type', 'source', 'statements', 'issuers']) || group.type !== 'identity'
        || !Array.isArray(group.source) || group.source.length === 0
        || group.source.some(source => source !== 'identityCredential' && source !== 'accountCredential')
        || !Array.isArray(group.statements) || !Array.isArray(group.issuers) || group.issuers.length === 0) throw new Error();
      statementCount += group.statements.length;
      if (statementCount > 256) throw new Error();
      for (const issuer of group.issuers) {
        if (typeof issuer !== 'string' || !/^did:ccd:(?:mainnet|testnet):idp:(?:0|[1-9]\d*)$/.test(issuer)) throw new Error();
        if (Number(issuer.slice(issuer.lastIndexOf(':') + 1)) > 0xffffffff) throw new Error();
      }
      for (const statementValue of group.statements) {
        const statement = object(statementValue);
        if (!statement) throw new Error();
        const fields = statement.type === 'RevealAttribute' ? ['type', 'attributeTag']
          : statement.type === 'AttributeInSet' || statement.type === 'AttributeNotInSet' ? ['type', 'attributeTag', 'set']
            : statement.type === 'AttributeInRange' ? ['type', 'attributeTag', 'lower', 'upper'] : undefined;
        if (!fields || !exactKeys(statement, fields)) throw new Error();
        if (statement.type === 'RevealAttribute' && (statement.attributeTag === 'dob'
          || statement.attributeTag === 'idDocNo' || statement.attributeTag === 'nationalIdNo'
          || statement.attributeTag === 'taxIdNo')) throw new Error();
      }
      if (group.statements.length > 0) verifyAtomicStatements(group.statements as AtomicStatementV2[], IDENTITY_SUBJECT_SCHEMA);
    }
    return VerificationRequestV1.fromJSON(value as never);
  } catch {
    throw new IdentityProofError('INVALID_REQUEST');
  }
}

function issuerAccepted(request: ParsedRequest, record: StoredIdentity, source: 'identityCredential' | 'accountCredential'): boolean {
  return request.subjectClaims.every(group => group.source.includes(source)
    && group.issuers.some(issuer => issuer.network === record.selection.sdkNetwork
      && issuer.index === record.selection.identityProviderIndex));
}

function attributes(identity: Versioned<IdentityObjectV1>): Record<string, string> {
  return identity.value.attributeList.chosenAttributes as Record<string, string>;
}

function satisfies(request: ParsedRequest, record: StoredIdentity, identity: Versioned<IdentityObjectV1>,
  source: 'identityCredential' | 'accountCredential'): boolean {
  if (!issuerAccepted(request, record, source)) return false;
  return request.subjectClaims.every(group => group.statements.every(statement =>
    canProveAtomicStatement(statement, attributes(identity))));
}

function describe(request: ParsedRequest): Record<string, unknown> {
  const contexts = request.context.given.map(entry => {
    if (entry.label === 'Nonce') return { label: entry.label, context: Buffer.from(entry.context).toString('hex') };
    if (entry.label === 'BlockHash') return { label: entry.label, context: BlockHash.toHexString(entry.context) };
    return { label: entry.label, context: entry.context };
  });
  return {
    context: contexts.filter(entry => entry.label === 'ContextString'),
    resource: contexts.filter(entry => entry.label === 'ResourceID'),
    session: contexts.filter(entry => entry.label === 'ConnectionID' || entry.label === 'Nonce'),
    requestedContext: [...request.context.requested],
    claims: request.subjectClaims.map(group => ({
      type: group.type, sources: [...group.source], issuers: group.issuers.map(issuer => issuer.toJSON()),
      statements: structuredClone(group.statements),
    })),
  };
}

function requestedContext(request: ParsedRequest, blockHash: string) {
  return request.context.requested.map(() => ({ label: 'BlockHash' as const, context: BlockHash.fromHexString(blockHash) }));
}

function comparableContext(context: { type: string; given: readonly unknown[]; requested: readonly unknown[] }) {
  const comparable = (entryValue: unknown) => {
    const entry = entryValue as { label: string; context: unknown };
    if (entry.label === 'BlockHash') return { label: entry.label,
      context: typeof entry.context === 'string' ? entry.context : BlockHash.toHexString(entry.context as never) };
    if (entry.label === 'Nonce' || entry.label === 'PaymentHash') return { label: entry.label,
      context: typeof entry.context === 'string' ? entry.context : Buffer.from(entry.context as Uint8Array).toString('hex') };
    return entry;
  };
  return { type: context.type, given: context.given.map(comparable), requested: context.requested.map(comparable) };
}

function sameClaims(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function requestedAttributeNames(request: ParsedRequest): string[] {
  // strictRequest has already checked every tag against the SDK identity schema.
  return [...new Set(request.subjectClaims.flatMap(group => group.statements.map(statement => statement.attributeTag)))];
}

function identityValidAt(identity: Versioned<IdentityObjectV1>, time: string): boolean {
  const date = new Date(time);
  if (!Number.isFinite(date.valueOf()) || date.toISOString() !== time) return false;
  const month = date.toISOString().slice(0, 7).replace('-', '');
  return /^\d{6}$/.test(identity.value.attributeList.createdAt)
    && /^\d{6}$/.test(identity.value.attributeList.validTo)
    && month >= identity.value.attributeList.createdAt && month <= identity.value.attributeList.validTo;
}

function isUnavailable(error: unknown): boolean {
  return error instanceof IdentityProofError
      && (error.code === 'SUBJECT_UNAVAILABLE' || error.code === 'SUBJECT_INELIGIBLE')
    || error instanceof IdentitySourceError
    || error instanceof IdentityWorkflowError
      && (error.code === 'AUTHORIZATION_REQUIRED' || error.code === 'SOURCE_NOT_ASSOCIATED'
        || error.code === 'CRYPTO_FAILED');
}

/** Create the core proof service around explicit storage, material, node, and SDK boundaries. */
export function createIdentityProofService(deps: IdentityProofDependencies): IdentityProofService {
  const createPresentation = deps.createPresentation ?? VerifiablePresentationV1.create;
  const verifyPresentation = deps.verifyPresentation ?? VerifiablePresentationV1.verify;
  const parse = (input: { network?: string; request: Record<string, unknown> }) => {
    const request = strictRequest(input.request);
    try { return { network: deps.resolveNetwork(input.network), request }; }
    catch { throw new IdentityProofError('NETWORK_FAILED'); }
  };
  const validateAnchor = async (network: string, request: ParsedRequest): Promise<IdentityProofAnchor> => {
    try { return await deps.verifyAnchor(network, request); }
    catch { throw new IdentityProofError('NETWORK_FAILED'); }
  };
  const loadRecords = async (network: string): Promise<StoredIdentity[]> => {
    try { return await deps.listRecords(network); }
    catch { throw new IdentityProofError('STORAGE_FAILED'); }
  };
  const inspectIdentity = async <T, Context extends IdentityProofContext>(
    record: StoredIdentity, context: Context, callback: (
    identity: Versioned<IdentityObjectV1>, context: Context,
    scope: IdentityProofMaterialScope,
  ) => Promise<T>): Promise<T> => {
    let domainError: IdentityProofError | undefined;
    const result = await deps.withMaterial(record, async scope => {
    try {
    const identity = await deps.loadIdentity(record, scope.storageKey);
    if (record.status !== 'ready' || context.network !== record.selection.network
      || context.sdkNetwork !== record.selection.sdkNetwork
      || context.ipInfo.ipIdentity !== record.selection.identityProviderIndex
      || identity.value.preIdentityObject.idCredPub !== record.idCredPub) {
      throw new IdentityProofError('SUBJECT_INELIGIBLE');
    }
    return callback(identity, context, scope);
    } catch (error) {
      if (error instanceof IdentityProofError) {
        domainError = error;
        return undefined as T;
      }
      throw error;
    }
  });
    if (domainError !== undefined) throw domainError;
    return result;
  };
  const inspectLocalIdentity = async <T>(record: StoredIdentity, callback: (
    identity: Versioned<IdentityObjectV1>, context: IdentityProofContext,
    scope: IdentityProofMaterialScope,
  ) => Promise<T>): Promise<T> => {
    const context = await deps.loadLocalContext(record);
    if (context === undefined) throw new IdentityProofError('SUBJECT_UNAVAILABLE');
    return inspectIdentity(record, context, callback);
  };
  const inspectGenerationIdentity = async <T>(record: StoredIdentity, blockHash: string, callback: (
    identity: Versioned<IdentityObjectV1>, context: GenerationProofContext,
    scope: IdentityProofMaterialScope,
  ) => Promise<T>): Promise<T> => {
    let context: GenerationProofContext;
    try { context = await deps.loadGenerationContext(record.selection, blockHash); }
    catch (error) {
      if (error instanceof IdentityProofError) throw error;
      throw new IdentityProofError('NETWORK_FAILED');
    }
    if (context.sourceBlock.hash !== blockHash) throw new IdentityProofError('NETWORK_FAILED');
    return inspectIdentity(record, context, callback);
  };

  return {
    async validateRequest(input) {
      const { network, request } = parse(input);
      const anchor = await validateAnchor(network.caip2, request);
      return {
        network: network.caip2, anchor,
        domainBinding: { status: 'not_checked' },
        ...(input.describe === true ? { description: describe(request) } : {}),
      };
    },
    async findCandidates(input) {
      const { network, request } = parse(input);
      if (request.subjectClaims.length === 0) return { network: network.caip2, candidates: [] };
      const candidates: IdentityProofCandidate[] = [];
      const records = await loadRecords(network.caip2);
      for (const record of records) {
        if (record.selection.network !== network.caip2 || record.status !== 'ready' || record.sourceId === undefined) continue;
        try {
          const eligible = await inspectLocalIdentity(record,
            async identity => satisfies(request, record, identity, 'identityCredential'));
          if (eligible) candidates.push({ subject: { type: 'identity', identityId: record.id },
            ...(record.label === undefined ? {} : { label: identityLabelValue(record.label) }) });
        } catch (error) {
          if (isUnavailable(error)) continue;
          throw new IdentityProofError('STORAGE_FAILED');
        }
      }
      if (request.subjectClaims.some(group => group.statements.length > 0)) {
        let cached: CachedProofCredential[];
        let registry: Awaited<ReturnType<IdentityProofDependencies['loadCredentialRegistry']>>;
        try {
          [cached, registry] = await Promise.all([
            deps.listCachedCredentials(network.caip2), deps.loadCredentialRegistry(network.caip2),
          ]);
        } catch { throw new IdentityProofError('STORAGE_FAILED'); }
        const credentialIdCounts = new Map<string, number>();
        for (const credential of cached) {
          credentialIdCounts.set(credential.credentialId, (credentialIdCounts.get(credential.credentialId) ?? 0) + 1);
        }
        for (const credential of cached) {
          if (credentialIdCounts.get(credential.credentialId) !== 1) continue;
          const allocation = registry.credentials[credential.credentialId];
          if (allocation === undefined || allocation.status !== 'confirmed') continue;
          const record = records.find(candidate => candidate.id === allocation.identityId);
          if (!record || record.status !== 'ready' || record.sourceId === undefined) continue;
          try {
            const eligible = await inspectLocalIdentity(record, async (identity, context, scope) => {
              if (!satisfies(request, record, identity, 'accountCredential')) return false;
              return deriveCredentialRegistrationId({
                seed: scope.seed, network: record.selection.sdkNetwork,
                identityProviderIndex: record.selection.identityProviderIndex,
                identityIndex: record.selection.identityIndex, credentialIndex: allocation.credentialNumber,
                onChainCommitmentKey: context.globalContext.onChainCommitmentKey,
              }) === credential.credentialId;
            });
            if (eligible) candidates.push({
              subject: { type: 'account', account: credential.account, credentialIndex: credential.credentialIndex },
            });
          } catch (error) {
            if (isUnavailable(error)) continue;
            throw new IdentityProofError('STORAGE_FAILED');
          }
        }
      }
      return { network: network.caip2, candidates };
    },
    async createProof(input) {
      const { network, request } = parse(input);
      if (request.subjectClaims.length === 0) throw new IdentityProofError('NO_PROVABLE_CLAIMS');
      const anchor = await validateAnchor(network.caip2, request);
      if (anchor.status === 'invalid') throw new IdentityProofError('INVALID_ANCHOR');
      if (input.subject.type === 'account') {
        if (request.subjectClaims.every(group => group.statements.length === 0)) {
          throw new IdentityProofError('NO_PROVABLE_CLAIMS');
        }
        let state: FinalizedProofAccountState;
        try { state = await deps.loadFinalizedCredentials(network.caip2, input.subject.account, anchor.blockHash); }
        catch { throw new IdentityProofError('NETWORK_FAILED'); }
        if (state.sourceBlock.hash !== anchor.blockHash) throw new IdentityProofError('NETWORK_FAILED');
        let registry: Awaited<ReturnType<IdentityProofDependencies['loadCredentialRegistry']>>;
        try { registry = await deps.loadCredentialRegistry(network.caip2); }
        catch { throw new IdentityProofError('STORAGE_FAILED'); }
        const selected = state.credentials
          .filter(credential => input.subject.type === 'account'
            && (input.subject.credentialIndex === undefined || credential.credentialIndex === input.subject.credentialIndex))
          .sort((left, right) => left.credentialIndex - right.credentialIndex);
        const records = await loadRecords(network.caip2);
        for (const credential of selected) {
          const allocation = registry.credentials[credential.credentialId];
          const record = allocation === undefined ? undefined : records.find(candidate => candidate.id === allocation.identityId);
          if (allocation === undefined || !record || allocation.status !== 'confirmed') continue;
          try {
            return await inspectGenerationIdentity(record, anchor.blockHash, async (identity, context, scope) => {
              if (context.sourceBlock.time !== state.sourceBlock.time) throw new IdentityProofError('NETWORK_FAILED');
              if (!satisfies(request, record, identity, 'accountCredential')
                || credential.issuer !== record.selection.identityProviderIndex) throw new IdentityProofError('SUBJECT_INELIGIBLE');
              if (!identityValidAt(identity, state.sourceBlock.time)) throw new IdentityProofError('SUBJECT_INELIGIBLE');
              if (!state.currentCredentials.some(current => current.credentialIndex === credential.credentialIndex
                && current.credentialId === credential.credentialId)) throw new IdentityProofError('SUBJECT_INELIGIBLE');
              const blockDate = new Date(state.sourceBlock.time);
              if (!Number.isFinite(blockDate.valueOf()) || blockDate.toISOString() !== state.sourceBlock.time
                || !/^\d{6}$/.test(credential.policy.createdAt) || !/^\d{6}$/.test(credential.policy.validTo)) {
                throw new IdentityProofError('SUBJECT_INELIGIBLE');
              }
              const blockMonth = blockDate.toISOString().slice(0, 7).replace('-', '');
              if (credential.policy.createdAt !== identity.value.attributeList.createdAt
                || credential.policy.validTo !== identity.value.attributeList.validTo
                || blockMonth < credential.policy.createdAt || blockMonth > credential.policy.validTo
                || Object.entries(credential.policy.revealedAttributes).some(([name, value]) =>
                  attributes(identity)[name] !== value)) throw new IdentityProofError('SUBJECT_INELIGIBLE');
              const expectedId = deriveCredentialRegistrationId({
                seed: scope.seed, network: record.selection.sdkNetwork,
                identityProviderIndex: record.selection.identityProviderIndex,
                identityIndex: record.selection.identityIndex, credentialIndex: allocation.credentialNumber,
                onChainCommitmentKey: context.globalContext.onChainCommitmentKey,
              });
              if (expectedId !== credential.credentialId) throw new IdentityProofError('SUBJECT_INELIGIBLE');
              const names = requestedAttributeNames(request);
              if (names.some(name => typeof credential.commitments[name as keyof typeof credential.commitments] !== 'string')) {
                throw new IdentityProofError('SUBJECT_INELIGIBLE');
              }
              const openings: Buffer[] = [];
              try {
                const randomness: Record<string, string> = {};
                for (const name of names) {
                  const attribute = AttributesKeys[name as keyof typeof AttributesKeys];
                  const opening = deriveAttributeRandomness({
                    seed: scope.seed, network: record.selection.sdkNetwork,
                    identityProviderIndex: record.selection.identityProviderIndex,
                    identityIndex: record.selection.identityIndex, credentialIndex: allocation.credentialNumber, attribute,
                  });
                  openings.push(opening);
                  randomness[name] = opening.toString('hex');
                }
                const claims = request.subjectClaims.map(group => VerifiablePresentationV1.createAccountClaims(
                  record.selection.sdkNetwork, CredentialRegistrationId.fromHexString(credential.credentialId), credential.issuer,
                  VerifiablePresentationV1.revealRequestedStatements(group.statements, attributes(identity)),
                ));
                const proofContext = VerifiablePresentationV1.createContext(request.context,
                  requestedContext(request, anchor.blockHash));
                const commitment = {
                  type: 'account', issuer: credential.issuer, values: attributes(identity), randomness,
                } as const;
                const publicMaterial = {
                  type: 'account', issuer: credential.issuer, commitments: credential.commitments,
                } as const;
                const presentation = createPresentation({ context: proofContext, subjectClaims: claims },
                  claims.map(() => commitment), context.globalContext);
                const verified = verifyPresentation(presentation, context.globalContext,
                  claims.map(() => publicMaterial));
                if (verified.type !== 'success'
                  || !sameClaims(comparableContext(verified.result.context), comparableContext(proofContext))
                  || !sameClaims(verified.result.subjectClaims, claims)) throw new IdentityProofError('PROOF_FAILED');
                return { network: network.caip2,
                  presentation: presentation.toJSON() as unknown as Record<string, unknown> };
              } finally { for (const opening of openings) opening.fill(0); }
            });
          } catch (error) {
            if (error instanceof IdentityProofError && error.code === 'SUBJECT_INELIGIBLE') continue;
            if (error instanceof IdentityProofError) throw error;
            throw new IdentityProofError('PROOF_FAILED');
          }
        }
        throw new IdentityProofError('SUBJECT_INELIGIBLE');
      }
      const identityId = input.subject.identityId;
      if (!/^[0-9a-f]{64}$/.test(identityId)) {
        try { catalogLabelKey(identityId); }
        catch { throw new IdentityProofError('INVALID_REQUEST'); }
      }
      const records = await loadRecords(network.caip2);
      const record = records.find(candidate => candidate.id === identityId)
        ?? (/^[0-9a-f]{64}$/.test(identityId)
          ? undefined : findCatalogLabel(records, identityId, candidate => candidate.label));
      if (!record) throw new IdentityProofError('SUBJECT_NOT_FOUND');
      try {
        return await inspectGenerationIdentity(record, anchor.blockHash, async (identity, context, scope) => {
          if (!satisfies(request, record, identity, 'identityCredential')) throw new IdentityProofError('SUBJECT_INELIGIBLE');
          if (!identityValidAt(identity, context.sourceBlock.time)) throw new IdentityProofError('SUBJECT_INELIGIBLE');
          const claims = request.subjectClaims.map(group => VerifiablePresentationV1.createIdentityClaims(
            record.selection.sdkNetwork, record.selection.identityProviderIndex,
            VerifiablePresentationV1.revealRequestedStatements(group.statements, attributes(identity)),
          ));
          const proofContext = VerifiablePresentationV1.createContext(request.context, requestedContext(request, anchor.blockHash));
          const commitment = createIdentityCommitmentInput({ ipInfo: context.ipInfo, arsInfos: context.arsInfos }, identity.value, {
            aci: { credentialHolderInformation: { idCredSecret: scope.material.idCredSec.toString('hex') },
              prfKey: scope.material.prfKey.toString('hex') },
            randomness: scope.material.signatureBlindingRandomness.toString('hex'),
          });
          const publicMaterial = {
            type: 'identity', ipInfo: context.ipInfo, arsInfos: context.arsInfos,
          } as const;
          const presentation = createPresentation({ context: proofContext, subjectClaims: claims },
            claims.map(() => commitment), context.globalContext);
          const verified = verifyPresentation(presentation, context.globalContext, claims.map(() => publicMaterial));
          if (verified.type !== 'success'
            || !sameClaims(comparableContext(verified.result.context), comparableContext(proofContext))
            || !sameClaims(verified.result.subjectClaims, claims)) throw new IdentityProofError('PROOF_FAILED');
          return { network: network.caip2, presentation: presentation.toJSON() as unknown as Record<string, unknown> };
        });
      } catch (error) {
        if (error instanceof IdentityProofError) throw error;
        throw new IdentityProofError('PROOF_FAILED');
      }
    },
  };
}
