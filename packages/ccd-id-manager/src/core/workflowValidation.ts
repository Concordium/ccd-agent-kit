import type { IdentityObjectV1, IdObjectRequestV1, Versioned } from '@concordium/web-sdk';
import { ed25519PublicKey } from '@ccd-agent-kit/sdk-utils';
import { hexStringSchema } from '@ccd-agent-kit/mcp-utils';
import { z } from 'zod';
import { validateIdentityRootPublicKey } from './identityRoot.js';
import { catalogLabelSchema, deriveIdentitySourceId, IDENTITY_SOURCE_ID_PATTERN } from '@ccd-agent-kit/config-utils';
import { IdentityWorkflowError } from './workflowErrors.js';
import { isIdentityLabel } from './identityLabels.js';
import {
  DEFAULT_REVEALABLE_IDENTITY_ATTRIBUTES,
  type IdentitySelection,
  type StoredIdentity,
} from './workflowTypes.js';

const index = z.number().int().min(0).max(0x7fffffff);
const hex = hexStringSchema.max(1_048_576);
const noControlCharacters = (value: string): boolean => [...value].every(character => {
  const code = character.charCodeAt(0);
  return code > 0x1f && code !== 0x7f;
});

/** Check only the trusted IDP envelope and fields consumed locally; SDK identity/proof structures remain opaque and unchanged. */
export const identityObjectSchema = z.custom<Versioned<IdentityObjectV1>>(input => {
  const identity = input as Versioned<IdentityObjectV1> | undefined;
  return identity?.v === 0 && typeof identity.value?.preIdentityObject?.idCredPub === 'string'
    && typeof identity.value?.signature === 'string'
    && typeof identity.value?.attributeList?.validTo === 'string'
    && Number.isInteger(identity.value?.attributeList?.maxAccounts)
    && identity.value.attributeList.maxAccounts > 0;
});

/** HTTPS endpoints or explicit loopback HTTP only; no userinfo, fragment, or filesystem URLs. */
export function safeHttpUrl(value: string): URL {
  try {
    const url = new URL(value);
    const loopback = url.hostname === 'localhost' || url.hostname === '[::1]' || url.hostname === '127.0.0.1';
    if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) || url.username || url.password || url.hash) throw new Error();
    return url;
  } catch { throw new IdentityWorkflowError('INVALID_INPUT'); }
}

/** Internal persisted selector shape including the node-verified SDK namespace. */
export const identitySelectionSchema = z.object({
  network: z.string().min(1).max(128), sdkNetwork: z.enum(['Testnet','Mainnet']),
  device: z.string().regex(/^\d+$/).max(32).optional(), rootPublicKey: z.string().regex(/^04[a-f0-9]{128}$/),
  identityProviderIndex: index, identityIndex: index,
  walletProxyUrl: z.string().max(2048).refine(v => { try { safeHttpUrl(v); return true; } catch { return false; } }).optional(),
}).strict();

const network = z.string().min(1).max(128).optional();
const source = z.union([z.string().regex(IDENTITY_SOURCE_ID_PATTERN), catalogLabelSchema]).optional();
const gapLimit = z.number().int().positive().max(0x7fffffff).optional();

/** Opaque identities are deterministic 32-byte lower-case hexadecimal identifiers, never labels. */
export const identityIdSchema = z.string().regex(/^[0-9a-f]{64}$/);

/** Exact stored identity selector, with optional agent ownership marker and a 49-character body. */
export const identityLabelSchema = catalogLabelSchema;

/** Persisted hard/soft identity label schema. */
export const storedIdentityLabelSchema = z.string().refine(isIdentityLabel);

/** Public CLI/core selector; storage and cryptographic operations still require a canonical opaque identity ID. */
export const identitySelectorSchema = z.union([identityIdSchema, identityLabelSchema]);

/** Strict operator label input; the agent workflow separately requires an unprefixed label. */
export const identityLabelInputSchema = z.object({
  network, identityId: identitySelectorSchema, operation: z.enum(['set', 'remove']).optional(),
  label: identityLabelSchema.optional(), mode: z.enum(['hard', 'soft']).optional(),
}).strict();

/** Strict public identity-request schema. */
export const identityRequestInputSchema = z.object({
  network, source, identityProviderIndex: index, identityIndex: index.optional(),
  label: identityLabelSchema.optional(), mode: z.enum(['hard', 'soft']).optional(),
}).strict();

/** Strict public identity-recovery schema. */
export const identityRecoveryInputSchema = z.object({ network, source, identityProviderIndex: index, identityIndex: index }).strict();

/** Strict public identity-discovery schema. */
export const identityDiscoveryInputSchema = z.object({ network, source, identityProviderIndex: index.optional(), gapLimit,
  startIndex: index.optional(), endIndex: index.optional(),
}).strict().refine(value => value.startIndex === undefined || value.endIndex === undefined || value.startIndex <= value.endIndex);

/** Strict public credential-discovery schema. */
export const credentialDiscoveryInputSchema = z.object({
  network, identityId: identitySelectorSchema, gapLimit,
  startCredentialNumber: z.number().int().min(0).max(255).optional(),
  endCredentialNumber: z.number().int().min(0).max(255).optional(), full: z.boolean().optional(),
}).strict().refine(value => !(value.full === true && (value.startCredentialNumber !== undefined || value.endCredentialNumber !== undefined)))
  .refine(value => value.startCredentialNumber === undefined || value.endCredentialNumber === undefined || value.startCredentialNumber <= value.endCredentialNumber);

/** Strict CLI-only source-association schema. */
export const identitySourceAssociationInputSchema = z.object({ network, identityId: identitySelectorSchema, source }).strict();

/** Validate one persisted selector, including its canonical public-key pin. */
export function parseSelection(input: unknown): IdentitySelection {
  try {
    const selection = identitySelectionSchema.parse(input);
    validateIdentityRootPublicKey(Buffer.from(selection.rootPublicKey, 'hex'));
    return {
      network: selection.network, sdkNetwork: selection.sdkNetwork,
      ...(selection.device === undefined ? {} : { device: selection.device }),
      rootPublicKey: selection.rootPublicKey.toLowerCase(),
      identityProviderIndex: selection.identityProviderIndex, identityIndex: selection.identityIndex,
      ...(selection.walletProxyUrl === undefined ? {} : { walletProxyUrl: selection.walletProxyUrl }),
    };
  } catch { throw new IdentityWorkflowError('INVALID_INPUT'); }
}

/** Accept the trusted IDP's complete SDK object without reimplementing SDK protocol/proof validation. */
export function parseIdentityObject(input: unknown): Versioned<IdentityObjectV1> {
  const result = identityObjectSchema.safeParse(input);
  if (!result.success) throw new IdentityWorkflowError('IDENTITY_MISMATCH');
  return result.data;
}

/** Account-opening boundary schema; public-key validity follows the shared SDK-utils parser, not a separate regex. */
export const accountOpeningInputSchema = z.object({
  network:z.string().min(1).max(128).optional(),
  identityId:identitySelectorSchema, credentialNumber:z.number().int().min(0).max(255).optional(),
  publicKeys:z.record(
    z.string().regex(/^(0|[1-9]\d*)$/).refine(value => Number(value) <= 255, 'Expected a byte-sized key index.'),
    z.string().transform(value => value.trim().toLowerCase())
      .refine(value => ed25519PublicKey.from(value) !== undefined, 'Expected an Ed25519 public key.'),
  ).refine(value => Object.keys(value).length <= 255, 'At most 255 credential public keys are supported.'),
  credentialThreshold:z.number().int().positive().max(255),
  expirySeconds:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  revealAttributes:z.array(z.enum(DEFAULT_REVEALABLE_IDENTITY_ATTRIBUTES)).optional(),
}).strict().superRefine((value, context) => {
  const keyCount = Object.keys(value.publicKeys).length;
  if (keyCount === 0 || value.credentialThreshold > keyCount) {
    context.addIssue({ code: 'custom', message: 'Credential threshold must be between 1 and the key count.' });
  }
});

/** Check the SDK request envelope and binding identifier, not its proof internals. */
export const identityRequestSchema = z.custom<Versioned<IdObjectRequestV1>>(input => {
  const request = input as Versioned<IdObjectRequestV1> | undefined;
  return request?.v === 0 && hex.length(96).safeParse(request.value?.idCredPub).success;
});

const recordBaseSchema = z.object({
  version: z.literal(1), id: identityIdSchema, sourceId: z.string().regex(IDENTITY_SOURCE_ID_PATTERN).optional(), selection: identitySelectionSchema,
  label: storedIdentityLabelSchema.optional(),
  contextHash: hex.length(64), idCredPub: hex.length(96),
});

const lifecycleRecordSchema = recordBaseSchema.extend({
  status: z.enum(['awaiting_verification','pending','error','expired']),
  request: identityRequestSchema.optional(), retrievalUrl: z.string().min(1).max(8192).optional(), requestAttemptId: z.string().uuid().optional(),
  postIssuance: z.union([
    z.object({ status: z.literal('unconfirmed') }).strict(),
    z.object({
      status: z.literal('created'),
      url: z.string().max(2048).refine(value => { try { safeHttpUrl(value); return true; } catch { return false; } }),
      statusUrl: z.string().max(8192).refine(value => { try { safeHttpUrl(value); return true; } catch { return false; } }).optional(),
    }).strict(),
    z.object({
      status: z.literal('created'),
      ctxId: z.string().min(1).max(1_048_576).refine(value => value !== '.' && value !== '..' && noControlCharacters(value)),
      url: z.string().max(2048).refine(value => { try { safeHttpUrl(value); return true; } catch { return false; } }),
      network: z.enum(['Mainnet', 'Testnet']),
      statusUrl: z.string().max(8192).refine(value => { try { safeHttpUrl(value); return true; } catch { return false; } }).optional(),
      expiresAt: z.string().datetime({ offset: true }),
    }).strict(),
  ]).optional(),
  confirmedFailure: z.object({
    kind: z.literal('authenticated_key_failure'), requestAttemptId: z.string().uuid(),
  }).strict().optional(),
  authorizationUrl: z.string().refine(value => {
    try { safeHttpUrl(value); return true; } catch { return false; }
  }).optional(),
}).strict();

const issuedRecordSchema = recordBaseSchema.extend({
  status: z.literal('ready'),
  identity: identityObjectSchema.optional(),
}).strict();

const recordSchema = z.discriminatedUnion('status', [lifecycleRecordSchema, issuedRecordSchema]);

/** Validate protected local state before use; no seed, root, secret scalar, or commitment openings are legal fields. */
export function parseStoredIdentity(input: unknown): StoredIdentity {
  try {
    const record = recordSchema.parse(input);
    const selection = parseSelection(record.selection);
    if (record.sourceId !== undefined && record.sourceId !== deriveIdentitySourceId(selection.rootPublicKey, 1)) throw new Error();
    if (record.status === 'ready') {
      if (record.identity && record.identity.value.preIdentityObject.idCredPub !== record.idCredPub) throw new Error();
      const { identity, sourceId, label, ...required } = record;
      return {...required, selection, ...(sourceId === undefined ? {} : {sourceId}), ...(label === undefined ? {} : {label}),
        ...(identity === undefined ? {} : {identity})};
    }
    if (record.retrievalUrl !== undefined) safeHttpUrl(record.retrievalUrl);
    if (record.request && record.request.value.idCredPub !== record.idCredPub) throw new Error();
    if (record.confirmedFailure !== undefined && (record.status !== 'error' || record.requestAttemptId === undefined
      || record.confirmedFailure.requestAttemptId !== record.requestAttemptId)) throw new Error();
    const {request, retrievalUrl, requestAttemptId, confirmedFailure, authorizationUrl, postIssuance, sourceId, label, ...required} = record;
    return {...required, selection, ...(sourceId === undefined ? {} : {sourceId}), ...(label === undefined ? {} : {label}), ...(request === undefined ? {} : {request}), ...(retrievalUrl === undefined ? {} : {retrievalUrl}), ...(requestAttemptId === undefined ? {} : {requestAttemptId}), ...(confirmedFailure === undefined ? {} : {confirmedFailure}), ...(authorizationUrl === undefined ? {} : {authorizationUrl}), ...(postIssuance === undefined ? {} : {postIssuance})};
  } catch { throw new IdentityWorkflowError('STORAGE_FAILED'); }
}
