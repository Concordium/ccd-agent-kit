import type { ArInfo, CryptographicParameters, IpInfo } from '@concordium/web-sdk';

/** A JSON-safe snapshot of finalized public identity context for one network. */
export interface IdentityContextSnapshot {
  /** Snapshot schema version. */
  version: 1;
  /** Canonical network identity. */
  network: { caip2: string; genesisHash: string };
  /** Finalized block from which the context was read. */
  sourceBlock: { hash: string; height: string; time: string };
  /** Time at which the finalized context was observed. */
  observedAt: string;
  /** Chain cryptographic parameters in the web SDK JSON representation. */
  globalContext: CryptographicParameters;
  /** Identity providers in the web SDK JSON representation. */
  identityProviders: IpInfo[];
  /** Anonymity revokers in the web SDK JSON representation. */
  anonymityRevokers: ArInfo[];
}

type JsonRecord = Record<string, unknown>;

function record(value: unknown, keys: readonly string[], label: string): JsonRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`Invalid ${label}.`);
  const candidate = value as JsonRecord;
  const actual = Object.keys(candidate);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) throw new Error(`Invalid ${label}.`);
  return candidate;
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`Invalid ${label}.`);
  return value;
}

function hex(value: unknown, label: string, length?: number): string {
  const parsed = string(value, label);
  const pattern = length === undefined ? /^(?:[0-9a-f]{2})+$/ : new RegExp(`^[0-9a-f]{${length}}$`);
  if (!pattern.test(parsed)) throw new Error(`Invalid ${label}.`);
  return parsed;
}

function timestamp(value: unknown, label: string): string {
  const parsed = string(value, label);
  const date = new Date(parsed);
  if (!Number.isFinite(date.valueOf()) || date.toISOString() !== parsed) throw new Error(`Invalid ${label}.`);
  return parsed;
}

function identity(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 0x7fffffff) {
    throw new Error(`Invalid ${label}.`);
  }
  return value as number;
}

function arIdentity(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 0xffff_ffff) {
    throw new Error(`Invalid ${label}.`);
  }
  return value as number;
}

function description(value: unknown, label: string): { name: string; url: string; description: string } {
  const parsed = record(value, ['name', 'url', 'description'], label);
  const name = string(parsed.name, `${label} name`);
  const url = string(parsed.url, `${label} URL`);
  const text = string(parsed.description, `${label} description`);
  return { name, url, description: text };
}

function parseProviders(value: unknown): IpInfo[] {
  if (!Array.isArray(value)) throw new Error('Invalid identity providers.');
  const seen = new Set<number>();
  return value.map((entry) => {
    const parsed = record(entry, ['ipIdentity', 'ipDescription', 'ipVerifyKey', 'ipCdiVerifyKey'], 'identity provider');
    const ipIdentity = identity(parsed.ipIdentity, 'identity provider index');
    if (seen.has(ipIdentity)) throw new Error('Duplicate identity provider index.');
    seen.add(ipIdentity);
    return {
      ipIdentity,
      ipDescription: description(parsed.ipDescription, 'identity provider description'),
      ipVerifyKey: hex(parsed.ipVerifyKey, 'identity provider verify key'),
      ipCdiVerifyKey: hex(parsed.ipCdiVerifyKey, 'identity provider CDI verify key'),
    };
  });
}

function parseRevokers(value: unknown): ArInfo[] {
  if (!Array.isArray(value)) throw new Error('Invalid anonymity revokers.');
  const seen = new Set<number>();
  return value.map((entry) => {
    const parsed = record(entry, ['arIdentity', 'arDescription', 'arPublicKey'], 'anonymity revoker');
    const parsedIdentity = arIdentity(parsed.arIdentity, 'anonymity revoker index');
    if (seen.has(parsedIdentity)) throw new Error('Duplicate anonymity revoker index.');
    seen.add(parsedIdentity);
    return {
      arIdentity: parsedIdentity,
      arDescription: description(parsed.arDescription, 'anonymity revoker description'),
      arPublicKey: hex(parsed.arPublicKey, 'anonymity revoker public key'),
    };
  });
}

/**
 * Strictly validates and detaches a JSON-safe finalized identity-context snapshot.
 *
 * This validates the canonical serialized shape, not cryptographic point validity.
 */
export function parseIdentityContextSnapshot(value: unknown): IdentityContextSnapshot {
  const root = record(
    value,
    ['version', 'network', 'sourceBlock', 'observedAt', 'globalContext', 'identityProviders', 'anonymityRevokers'],
    'identity context snapshot',
  );
  if (root.version !== 1) throw new Error('Unsupported identity context snapshot version.');

  const network = record(root.network, ['caip2', 'genesisHash'], 'snapshot network');
  const caip2 = string(network.caip2, 'snapshot CAIP-2 identifier');
  const genesisHash = hex(network.genesisHash, 'snapshot genesis hash', 64);
  if (caip2 !== `ccd:${genesisHash.slice(0, 32)}`) throw new Error('Snapshot network identifiers do not match.');

  const source = record(root.sourceBlock, ['hash', 'height', 'time'], 'snapshot source block');
  const height = string(source.height, 'snapshot source block height');
  if (!/^(?:0|[1-9]\d*)$/.test(height)) throw new Error('Invalid snapshot source block height.');

  const context = record(
    root.globalContext,
    ['onChainCommitmentKey', 'bulletproofGenerators', 'genesisString'],
    'snapshot global context',
  );
  const genesisString = string(context.genesisString, 'snapshot genesis string');
  if (genesisString.length === 0) throw new Error('Invalid snapshot genesis string.');

  return {
    version: 1,
    network: { caip2, genesisHash },
    sourceBlock: {
      hash: hex(source.hash, 'snapshot source block hash', 64),
      height,
      time: timestamp(source.time, 'snapshot source block time'),
    },
    observedAt: timestamp(root.observedAt, 'snapshot observation time'),
    globalContext: {
      onChainCommitmentKey: hex(context.onChainCommitmentKey, 'on-chain commitment key'),
      bulletproofGenerators: hex(context.bulletproofGenerators, 'bulletproof generators'),
      genesisString,
    },
    identityProviders: parseProviders(root.identityProviders),
    anonymityRevokers: parseRevokers(root.anonymityRevokers),
  };
}
