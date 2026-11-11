import {
  AccountAddress,
  AttributesKeys,
  BlockItemKind,
  type CredentialSignature,
  type CredentialDeploymentInfo,
  type UnsignedCredentialDeploymentInformation,
} from '@concordium/web-sdk';
import * as ed25519 from '@concordium/web-sdk/shims/ed25519';
import { createHash } from 'node:crypto';

import { parseHexBytes } from './identity.js';
import { ed25519PublicKey, publicKeyScheme } from './keys.js';
import type { Ed25519PublicKeyHex } from './keys.js';

/** Finalized credential deployment block item assembled from signer handoff hex and flat signatures. */
export interface FinalizedCredentialDeploymentHex {
  /** Block item kind discriminator. */
  blockItemKind: 'credentialDeployment';
  /** Account-opening message expiry as a decimal string. */
  messageExpiry: string;
  /** Serialized signed credential deployment block item hex. */
  blockItemHex: string;
  /** Merged flat credential signatures keyed by credential key index. */
  signatures: CredentialSignature;
}

/** Input for building an account-opening credential deployment signing handoff. */
export interface BuildAccountOpeningCredentialDeploymentHandoffInput {
  /** Account-opening message expiry as a unix timestamp in seconds. */
  messageExpiry: string | number | bigint;
  /** ID App unsigned credential deployment information. */
  unsignedCdi: UnsignedCredentialDeploymentInformation;
}

/** Account-opening credential deployment bytes prepared for signer/finalizer handoff. */
export interface AccountOpeningCredentialDeploymentHandoff {
  /** Account-opening message expiry as a decimal string. */
  messageExpiry: string;
  /** Unsigned credential deployment bytes, without the leading target context. */
  unsignedCredentialDeploymentHex: string;
  /** Signer/finalizer handoff bytes: `00 || u64_be(messageExpiry) || unsignedCredentialDeployment`. */
  credDeploymentHex: string;
}

/** Review-oriented summary of the stable `CredentialDeploymentValues` fields in a credential deployment block item. */
export interface CredentialDeploymentValuesSummary {
  /** Supported credential deployment variant encoded in the block item. */
  deploymentType: 'normal';
  /** Credential public keys and threshold included in the credential deployment. */
  credentialPublicKeys: {
    /** Validated canonical Ed25519 public keys keyed by decimal credential key index. */
    keys: Record<string, Ed25519PublicKeyHex>;
    /** Credential signature threshold. */
    threshold: number;
  };
  /** Credential identifier as hex. */
  credentialId: string;
  /** Identity provider index. */
  identityProvider: number;
  /** Revocation threshold from the credential values. */
  revocationThreshold: number;
  /** Number of anonymity revoker entries. */
  anonymityRevokerCount: number;
  /** Policy valid-to month in `YYYYMM` form. */
  validTo: string;
  /** Policy valid-to month in display-friendly `YYYY-MM` form. */
  validToDate: string;
  /** Policy created-at month in `YYYYMM` form. */
  createdAt: string;
  /** Policy created-at month in display-friendly `YYYY-MM` form. */
  createdAtDate: string;
  /** Number of revealed policy attributes. */
  revealedAttributeCount: number;
  /** Revealed policy attributes keyed by SDK attribute name, preserving serialized tag order. */
  revealedAttributes: Record<string, string>;
}

/** Opaque ownership proof section summary for a credential deployment block item. */
export interface CredentialDeploymentProofsSummary {
  /** Serialized ownership proof byte length. */
  byteLength: number;
}

/** Review-oriented summary of a finalized credential deployment block item. */
export interface CredentialDeploymentBlockItemSummary {
  /** Normalized item kind. */
  kind: 'credentialDeployment';
  /** Credential deployment expiry as a unix timestamp in seconds. */
  expiry: string;
  /** Stable credential-value fields. */
  credential: CredentialDeploymentValuesSummary;
  /** Opaque ownership proof metadata. */
  proofs: CredentialDeploymentProofsSummary;
}

/** Review-oriented summary of a credential deployment signing handoff. */
export interface CredentialDeploymentSigningHandoffSummary {
  /** Normalized item kind. */
  kind: 'credentialDeploymentSigning';
  /** Account-opening expiry or existing account targeted by the credential. */
  target: { type: 'new_account'; messageExpiry: string } | { type: 'existing_account'; accountAddress: string };
  /** Strictly decoded credential values. */
  credential: CredentialDeploymentValuesSummary;
  /** Opaque ownership proof metadata. */
  proofs: CredentialDeploymentProofsSummary;
}

const CREDENTIAL_COUNTER_LESS_THAN_MAX_ACCOUNTS_PROOF_LENGTH_BYTES = 740;
// The signed deployment retains proofRegId (160 bytes) and the account-counter proof (740 bytes)
// from the unsigned ID-ownership proof encoding; the target-bound key signatures sit between them.
const SIGNED_CREDENTIAL_UNSIGNED_PROOF_SUFFIX_LENGTH_BYTES = 900;
/** Serializes ID App account-opening credentials; requires distinct byte-sized key indexes and a valid key threshold. */
export function buildAccountOpeningCredentialDeploymentHandoff(
  input: BuildAccountOpeningCredentialDeploymentHandoffInput,
): AccountOpeningCredentialDeploymentHandoff {
  const messageExpiry = normalizeUint64(input.messageExpiry, 'messageExpiry');
  const targetContext = Buffer.alloc(9);
  targetContext.writeUInt8(0, 0);
  targetContext.writeBigUInt64BE(messageExpiry, 1);
  const unsignedCredentialDeployment = Buffer.concat([
    serializeCredentialDeploymentValues(input.unsignedCdi),
    serializeIdOwnershipProofs(input.unsignedCdi.proofs),
  ]);

  return {
    messageExpiry: messageExpiry.toString(10),
    credDeploymentHex: Buffer.concat([targetContext, unsignedCredentialDeployment]).toString('hex'),
    unsignedCredentialDeploymentHex: unsignedCredentialDeployment.toString('hex'),
  };
}

/** Finalizes an account-opening credential deployment signer handoff into a node-submittable block item. */
export async function finalizeCredentialDeploymentHex(
  credDeploymentHex: string,
  signatures: CredentialSignature,
): Promise<FinalizedCredentialDeploymentHex> {
  const bytes = parseHexBytes(credDeploymentHex);
  if (bytes.length < 10 || bytes.readUInt8(0) !== 0) {
    throw new Error('credDeploymentHex is not an account-opening credential deployment handoff.');
  }
  const messageExpiry = bytes.readBigUInt64BE(1);
  const unsignedCredentialDeployment = bytes.subarray(9);
  const credentialValues = parseCredentialDeploymentValues(unsignedCredentialDeployment);
  const assembled = await assembleSignedCredentialDeployment(credDeploymentHex, signatures);
  const normalizedSignatures = normalizeCredentialDeploymentSignatures(signatures);
  const signedProofs = Buffer.from(assembled.proofs, 'hex');
  const proofLength = Buffer.alloc(4);
  proofLength.writeUInt32BE(signedProofs.length);
  const expiryBytes = Buffer.alloc(8);
  expiryBytes.writeBigUInt64BE(messageExpiry);

  return {
    blockItemHex: Buffer.concat([
      Buffer.from([BlockItemKind.CredentialDeploymentKind]),
      expiryBytes,
      Buffer.from([1]),
      unsignedCredentialDeployment.subarray(0, credentialValues.endOffset),
      proofLength,
      signedProofs,
    ]).toString('hex'),
    blockItemKind: 'credentialDeployment',
    messageExpiry: messageExpiry.toString(10),
    signatures: normalizedSignatures,
  };
}

/**
 * Verifies and assembles a signed credential deployment for a new- or existing-account target.
 * Credential values must round-trip to their exact canonical bytes, and signatures are checked
 * against the exact target-bound handoff digest before the SDK credential is returned.
 */
export async function assembleSignedCredentialDeployment(
  credDeploymentHex: string,
  signatures: CredentialSignature,
): Promise<CredentialDeploymentInfo> {
  const bytes = parseHexBytes(credDeploymentHex);
  ensureAvailable(bytes, 0, 1, 'credential deployment target');
  const targetLength = bytes.readUInt8(0) === 0 ? 9 : bytes.readUInt8(0) === 1 ? 33 : 0;
  if (targetLength === 0) throw new Error(`Unsupported credential deployment target: ${bytes.readUInt8(0)}`);
  ensureAvailable(bytes, 0, targetLength + 1, 'credential deployment payload');
  const targetContext = bytes.subarray(0, targetLength);
  const unsignedCredentialDeployment = bytes.subarray(targetLength);
  const parsed = parseCredentialDeploymentValues(unsignedCredentialDeployment);
  const encodedValues = unsignedCredentialDeployment.subarray(0, parsed.endOffset);
  if (!serializeCredentialDeploymentValues(parsed.credential).equals(encodedValues)) {
    throw new Error('Credential deployment values are not canonically encoded.');
  }
  const normalized = normalizeCredentialDeploymentSignatures(signatures);
  if (Object.keys(normalized).length < parsed.threshold) {
    throw new Error('Credential signature threshold is not met.');
  }
  const digest = createHash('sha256').update(unsignedCredentialDeployment).update(targetContext).digest();
  const proofs = buildSignedCredentialDeploymentProofs(
    unsignedCredentialDeployment.subarray(parsed.endOffset),
    normalized,
  ).toString('hex');
  for (const [keyIndex, signature] of Object.entries(normalized)) {
    const publicKey = parsed.summary.credentialPublicKeys.keys[keyIndex];
    if (publicKey === undefined) throw new Error(`Credential key ${keyIndex} is not present.`);
    if (!await ed25519.verifyAsync(Buffer.from(signature, 'hex'), digest, Buffer.from(publicKey, 'hex'))) {
      throw new Error(`Credential signature ${keyIndex} is invalid.`);
    }
  }
  return { ...parsed.credential, proofs };
}

/**
 * Summarizes a finalized credential deployment block item for review surfaces.
 *
 * The summary intentionally decodes only stable credential-value fields and proof sizes. It does not decode or verify
 * zero-knowledge proof internals.
 * @throws {Error} For initial or unknown credential variants, invalid keys/thresholds, or malformed bytes.
 */
export function summarizeCredentialDeploymentBlockItem(
  input: string | Uint8Array,
): CredentialDeploymentBlockItemSummary {
  const bytes = typeof input === 'string' ? parseHexBytes(input) : Buffer.from(input);
  let cursor = 0;
  ensureAvailable(bytes, cursor, 1, 'credential deployment block item kind');
  const kind = bytes.readUInt8(cursor);
  cursor += 1;
  if (kind !== BlockItemKind.CredentialDeploymentKind) {
    throw new Error('blockItemHex is not a credential deployment block item.');
  }

  ensureAvailable(bytes, cursor, 8, 'credential deployment expiry');
  const expiry = bytes.readBigUInt64BE(cursor).toString(10);
  cursor += 8;

  ensureAvailable(bytes, cursor, 1, 'credential deployment type');
  const deploymentType = normalizeCredentialDeploymentType(bytes.readUInt8(cursor));
  cursor += 1;

  const credentialValues = parseCredentialDeploymentValues(bytes.subarray(cursor));
  cursor += credentialValues.endOffset;

  ensureAvailable(bytes, cursor, 4, 'credential deployment proof length');
  const proofLength = bytes.readUInt32BE(cursor);
  cursor += 4;
  ensureAvailable(bytes, cursor, proofLength, 'credential deployment ownership proofs');
  if (cursor + proofLength !== bytes.length) {
    throw new Error('Credential deployment block item has trailing bytes.');
  }

  return {
    credential: {
      ...credentialValues.summary,
      deploymentType,
    },
    expiry,
    kind: 'credentialDeployment',
    proofs: { byteLength: proofLength },
  };
}

/**
 * Summarizes the exact target, credential values, and opaque proof size in a credential signing handoff.
 *
 * Credential policy attributes are decoded as unmodified UTF-8 strings. Ownership proofs remain opaque.
 * @throws {Error} For unknown or truncated targets, malformed credential values, or missing ownership proofs.
 */
export function summarizeCredentialDeploymentSigningHandoff(
  input: string | Uint8Array,
): CredentialDeploymentSigningHandoffSummary {
  const bytes = typeof input === 'string' ? parseHexBytes(input) : Buffer.from(input);
  ensureAvailable(bytes, 0, 1, 'credential deployment target');
  const targetTag = bytes.readUInt8(0);
  let cursor = 1;
  let target: CredentialDeploymentSigningHandoffSummary['target'];

  if (targetTag === 0) {
    ensureAvailable(bytes, cursor, 8, 'account-opening message expiry');
    target = { type: 'new_account', messageExpiry: bytes.readBigUInt64BE(cursor).toString(10) };
    cursor += 8;
  } else if (targetTag === 1) {
    ensureAvailable(bytes, cursor, 32, 'existing account address');
    const addressBytes = Uint8Array.from(bytes.subarray(cursor, cursor + 32));
    target = { type: 'existing_account', accountAddress: AccountAddress.fromBuffer(addressBytes.buffer).toString() };
    cursor += 32;
  } else {
    throw new Error(`Unsupported credential deployment target: ${targetTag}`);
  }

  const credentialValues = parseCredentialDeploymentValues(bytes.subarray(cursor));
  cursor += credentialValues.endOffset;

  return {
    kind: 'credentialDeploymentSigning',
    target,
    credential: { ...credentialValues.summary, deploymentType: 'normal' },
    proofs: { byteLength: bytes.length - cursor },
  };
}

function serializeCredentialDeploymentValues(
  credential: Omit<CredentialDeploymentInfo, 'proofs'>,
): Buffer {
  const buffers: Buffer[] = [];
  validateCredentialPublicKeys(credential.credentialPublicKeys.keys, credential.credentialPublicKeys.threshold);
  buffers.push(
    serializeMap(credential.credentialPublicKeys.keys, encodeWord8, encodeDecimalKeyWord8, (key) => {
      if (key === null) throw new Error('Cannot serialize unknown credential key variant.');
      return serializeVerifyKey(key);
    }),
  );
  buffers.push(encodeWord8(credential.credentialPublicKeys.threshold));
  buffers.push(parseFixedHex(credential.credId, 48, 'credId'));
  buffers.push(encodeWord32(credential.ipIdentity));
  buffers.push(encodeWord8(credential.revocationThreshold));
  buffers.push(
    serializeMap(
      credential.arData,
      encodeWord16,
      (key) => encodeWord32(Number.parseInt(key, 10)),
      (arData) => parseFixedHex(arData.encIdCredPubShare, 96, 'encIdCredPubShare'),
    ),
  );
  buffers.push(serializeYearMonth(credential.policy.validTo));
  buffers.push(serializeYearMonth(credential.policy.createdAt));
  const revealedAttributes = Object.entries(credential.policy.revealedAttributes ?? {})
    .map(([tagName, value]) => {
      const tag = (AttributesKeys as unknown as Record<string, number>)[tagName];
      if (tag === undefined) throw new Error(`Unsupported revealed attribute: ${tagName}`);
      return { tag, value };
    })
    .sort((left, right) => left.tag - right.tag);
  buffers.push(encodeWord16(revealedAttributes.length));
  for (const { tag, value } of revealedAttributes) {
    const valueBytes = Buffer.from(value, 'utf8');
    buffers.push(Buffer.concat([encodeWord8(tag), encodeWord8(valueBytes.length), valueBytes]));
  }
  return Buffer.concat(buffers);
}

function serializeIdOwnershipProofs(proofs: UnsignedCredentialDeploymentInformation['proofs']): Buffer {
  const proofIdCredPubEntries = Object.entries(proofs.proofIdCredPub).sort(
    ([left], [right]) => Number.parseInt(left, 10) - Number.parseInt(right, 10),
  );
  return Buffer.concat([
    parseHexBytes(proofs.sig),
    parseHexBytes(proofs.commitments),
    parseFixedHex(proofs.challenge, 32, 'challenge'),
    encodeWord32(proofIdCredPubEntries.length),
    ...proofIdCredPubEntries.map(([index, proof]) =>
      Buffer.concat([encodeWord32(Number.parseInt(index, 10)), parseHexBytes(proof)]),
    ),
    parseHexBytes(proofs.proofIpSig),
    parseHexBytes(proofs.proofRegId),
    parseHexBytes(proofs.credCounterLessThanMaxAccounts),
  ]);
}

function serializeVerifyKey(key: { schemeId: string; verifyKey: string }): Buffer {
  publicKeyScheme.require(key.schemeId);
  return Buffer.concat([encodeWord8(0), Buffer.from(ed25519PublicKey.require(key.verifyKey), 'hex')]);
}

function serializeMap<T>(
  map: Record<string | number, T>,
  encodeSize: (size: number) => Buffer,
  encodeKey: (key: string) => Buffer,
  encodeValue: (value: T) => Buffer,
): Buffer {
  const entries = Object.entries(map).sort(([left], [right]) => Number.parseInt(left, 10) - Number.parseInt(right, 10));
  return Buffer.concat([
    encodeSize(entries.length),
    ...entries.map(([key, value]) => Buffer.concat([encodeKey(key), encodeValue(value)])),
  ]);
}

function serializeYearMonth(value: string): Buffer {
  if (!/^\d{6}$/.test(value)) throw new Error(`Invalid year-month value: ${value}`);
  return Buffer.concat([
    encodeWord16(Number.parseInt(value.slice(0, 4), 10)),
    encodeWord8(Number.parseInt(value.slice(4), 10)),
  ]);
}

function normalizeUint64(value: string | number | bigint, name: string): bigint {
  const normalized = typeof value === 'bigint' ? value : BigInt(value);
  if (normalized < 0n || normalized > 0xffffffffffffffffn) throw new Error(`${name} must fit in u64.`);
  return normalized;
}

function parseFixedHex(hex: string, byteLength: number, name: string): Buffer {
  const bytes = parseHexBytes(hex);
  if (bytes.length !== byteLength) throw new Error(`${name} must be ${byteLength} bytes.`);
  return bytes;
}

function encodeDecimalKeyWord8(key: string): Buffer {
  return encodeWord8(parseDecimalMapKey(key));
}

function parseDecimalMapKey(key: string): number {
  if (!/^\d+$/.test(key)) throw new Error(`Invalid decimal map key: ${key}`);
  return Number.parseInt(key, 10);
}

function validateCredentialPublicKeys(
  keys: UnsignedCredentialDeploymentInformation['credentialPublicKeys']['keys'],
  threshold: number,
): void {
  const entries = Object.keys(keys);
  if (entries.length === 0) throw new Error('Credential deployment must include at least one public key.');

  const encodedIndexes = new Set<number>();
  for (const keyIndex of entries) {
    const encodedIndex = parseDecimalMapKey(keyIndex);
    encodeWord8(encodedIndex);
    if (encodedIndexes.has(encodedIndex)) throw new Error(`Duplicate credential public key index: ${encodedIndex}`);
    encodedIndexes.add(encodedIndex);
  }

  if (!Number.isInteger(threshold) || threshold < 1 || threshold > encodedIndexes.size) {
    throw new Error('Credential public key threshold must be between 1 and the number of distinct keys.');
  }
}

function encodeWord8(value: number): Buffer {
  if (!Number.isInteger(value) || value < 0 || value > 0xff) throw new Error(`Value does not fit in u8: ${value}`);
  return Buffer.from([value]);
}

function encodeWord16(value: number): Buffer {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) throw new Error(`Value does not fit in u16: ${value}`);
  const bytes = Buffer.alloc(2);
  bytes.writeUInt16BE(value);
  return bytes;
}

function encodeWord32(value: number): Buffer {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff)
    throw new Error(`Value does not fit in u32: ${value}`);
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(value);
  return bytes;
}

function parseCredentialDeploymentValues(bytes: Buffer): {
  endOffset: number;
  keyIndexes: Set<string>;
  threshold: number;
  summary: Omit<CredentialDeploymentValuesSummary, 'deploymentType'>;
  credential: Omit<CredentialDeploymentInfo, 'proofs'>;
} {
  let cursor = 0;
  if (bytes.length < 1) throw new Error('Credential deployment payload is missing credential public keys.');
  const keyCount = bytes.readUInt8(0);
  const keyIndexes = new Set<string>();
  const keys: Record<string, Ed25519PublicKeyHex> = {};
  cursor += 1;
  if (keyCount === 0) throw new Error('Credential deployment must include at least one public key.');
  for (let i = 0; i < keyCount; i += 1) {
    ensureAvailable(bytes, cursor, 34, 'credential public key entry');
    const keyIndex = String(bytes.readUInt8(cursor));
    const scheme = bytes.readUInt8(cursor + 1);
    if (scheme !== 0) throw new Error(`Unsupported credential public key scheme: ${scheme}`);
    if (keyIndexes.has(keyIndex)) throw new Error(`Duplicate credential public key index: ${keyIndex}`);
    keyIndexes.add(keyIndex);
    keys[keyIndex] = ed25519PublicKey.require(bytes.subarray(cursor + 2, cursor + 34).toString('hex'));
    cursor += 34;
  }
  ensureAvailable(bytes, cursor, 1, 'credential public key threshold');
  const threshold = bytes.readUInt8(cursor);
  cursor += 1;
  if (threshold < 1 || threshold > keyIndexes.size) {
    throw new Error('Credential public key threshold must be between 1 and the number of distinct keys.');
  }
  ensureAvailable(bytes, cursor, 48, 'credential ID');
  const credentialId = bytes.subarray(cursor, cursor + 48).toString('hex');
  cursor += 48;
  ensureAvailable(bytes, cursor, 4, 'identity provider index');
  const identityProvider = bytes.readUInt32BE(cursor);
  cursor += 4;
  ensureAvailable(bytes, cursor, 1, 'revocation threshold');
  const revocationThreshold = bytes.readUInt8(cursor);
  cursor += 1; // revocationThreshold
  ensureAvailable(bytes, cursor, 2, 'anonymity revoker count');
  const arDataCount = bytes.readUInt16BE(cursor);
  cursor += 2;
  ensureAvailable(bytes, cursor, arDataCount * (4 + 96), 'anonymity revoker data');
  const arData: CredentialDeploymentInfo['arData'] = {};
  for (let i = 0; i < arDataCount; i += 1) {
    const index = bytes.readUInt32BE(cursor);
    arData[String(index)] = { encIdCredPubShare: bytes.subarray(cursor + 4, cursor + 100).toString('hex') };
    cursor += 100;
  }
  ensureAvailable(bytes, cursor, 3, 'valid-to year-month');
  const validTo = readYearMonth(bytes, cursor);
  cursor += 3;
  ensureAvailable(bytes, cursor, 3, 'created-at year-month');
  const createdAt = readYearMonth(bytes, cursor);
  cursor += 3;
  ensureAvailable(bytes, cursor, 2, 'revealed attribute count');
  const revealedAttributeCount = bytes.readUInt16BE(cursor);
  cursor += 2;
  const revealedAttributes: Record<string, string> = {};
  const revealedAttributeTags = new Set<number>();
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  for (let i = 0; i < revealedAttributeCount; i += 1) {
    ensureAvailable(bytes, cursor, 2, 'revealed attribute header');
    const tag = bytes.readUInt8(cursor);
    const attributeName = (AttributesKeys as unknown as Record<number, unknown>)[tag];
    if (typeof attributeName !== 'string') throw new Error(`Unsupported revealed attribute tag: ${tag}`);
    if (revealedAttributeTags.has(tag)) throw new Error(`Duplicate revealed attribute tag: ${tag}`);
    revealedAttributeTags.add(tag);
    const valueLength = bytes.readUInt8(cursor + 1);
    ensureAvailable(bytes, cursor + 2, valueLength, 'revealed attribute value');
    revealedAttributes[attributeName] = decoder.decode(bytes.subarray(cursor + 2, cursor + 2 + valueLength));
    cursor += 2 + valueLength;
  }
  if (cursor >= bytes.length) throw new Error('Credential deployment payload is missing ownership proofs.');
  return {
    credential: {
      arData,
      credId: credentialId,
      credentialPublicKeys: {
        keys: Object.fromEntries(Object.entries(keys).map(([key, verifyKey]) => [key, { schemeId: 'Ed25519', verifyKey }])),
        threshold,
      },
      ipIdentity: identityProvider,
      policy: { createdAt, revealedAttributes, validTo },
      revocationThreshold,
    },
    endOffset: cursor,
    keyIndexes,
    summary: {
      anonymityRevokerCount: arDataCount,
      createdAt,
      createdAtDate: formatYearMonthDate(createdAt),
      credentialId,
      credentialPublicKeys: { keys, threshold },
      identityProvider,
      revealedAttributeCount,
      revealedAttributes,
      revocationThreshold,
      validTo,
      validToDate: formatYearMonthDate(validTo),
    },
    threshold,
  };
}

function normalizeCredentialDeploymentType(value: number): CredentialDeploymentValuesSummary['deploymentType'] {
  if (value === 1) return 'normal';
  if (value === 0) throw new Error('Initial credential deployment summaries are not supported.');
  throw new Error(`Unsupported credential deployment type: ${value}`);
}

function ensureAvailable(bytes: Buffer, offset: number, length: number, label: string): void {
  if (offset + length > bytes.length) throw new Error(`Credential deployment payload is missing ${label}.`);
}

function readYearMonth(bytes: Buffer, offset: number): string {
  const year = bytes.readUInt16BE(offset).toString(10).padStart(4, '0');
  const month = bytes
    .readUInt8(offset + 2)
    .toString(10)
    .padStart(2, '0');
  return `${year}${month}`;
}

function formatYearMonthDate(value: string): string {
  return `${value.slice(0, 4)}-${value.slice(4, 6)}`;
}

function normalizeCredentialDeploymentSignatures(signatures: CredentialSignature): CredentialSignature {
  const entries = Object.entries(signatures).sort(([left], [right]) => Number(left) - Number(right));
  return Object.fromEntries(
    entries.map(([keyIndex, signature]) => {
      if (!/^(0|[1-9]\d*)$/.test(keyIndex) || Number(keyIndex) > 255) {
        throw new Error(`Credential key index ${keyIndex} must be a canonical byte index.`);
      }
      if (!/^[0-9a-fA-F]{128}$/.test(signature)) {
        throw new Error(`Credential signature ${keyIndex} must be a 64-byte hex string.`);
      }
      return [keyIndex, signature.toLowerCase()];
    }),
  );
}

function buildSignedCredentialDeploymentProofs(unsignedProofs: Buffer, signatures: CredentialSignature): Buffer {
  if (unsignedProofs.length < SIGNED_CREDENTIAL_UNSIGNED_PROOF_SUFFIX_LENGTH_BYTES) {
    throw new Error('Credential deployment ownership proofs are too short.');
  }
  const retainedProofs = unsignedProofs.subarray(
    unsignedProofs.length - SIGNED_CREDENTIAL_UNSIGNED_PROOF_SUFFIX_LENGTH_BYTES,
  );
  const insertionOffset = retainedProofs.length - CREDENTIAL_COUNTER_LESS_THAN_MAX_ACCOUNTS_PROOF_LENGTH_BYTES;
  const signatureBytes = Buffer.concat([
    Buffer.from([Object.keys(signatures).length]),
    ...Object.entries(signatures).map(([keyIndex, signature]) =>
      Buffer.concat([Buffer.from([Number(keyIndex)]), Buffer.from(signature, 'hex')]),
    ),
  ]);
  return Buffer.concat([
    retainedProofs.subarray(0, insertionOffset),
    signatureBytes,
    retainedProofs.subarray(insertionOffset),
  ]);
}
