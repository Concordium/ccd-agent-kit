import { AccountAddress } from '@concordium/web-sdk';

import { hexString } from './keys.js';

/** Canonical deployed smart-contract instance address. */
export interface ContractInstanceAddress {
  /** Contract instance index. */
  index: string;
  /** Contract instance subindex. */
  subindex: string;
}

const CONTRACT_INSTANCE_PATTERN = /^(\d+)[,.](\d+)$/;

/** Parser and formatter for deployed smart-contract instance identifiers. */
export const contractInstance = {
  from(value: unknown): ContractInstanceAddress | undefined {
    if (typeof value === 'string') {
      const match = CONTRACT_INSTANCE_PATTERN.exec(value.trim());
      if (match === null) return undefined;
      return normalizeContractInstanceAddress(match[1]!, match[2]!);
    }
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      const candidate = value as { index?: unknown; subindex?: unknown };
      if (typeof candidate.index !== 'string' || typeof candidate.subindex !== 'string') return undefined;
      return normalizeContractInstanceAddress(candidate.index, candidate.subindex);
    }
    return undefined;
  },
  require(value: unknown): ContractInstanceAddress {
    const parsed = contractInstance.from(value);
    if (parsed === undefined) throw new Error(`Invalid contract instance identifier: ${String(value)}`);
    return parsed;
  },
  format(address: ContractInstanceAddress): string {
    return `${address.index},${address.subindex}`;
  },
} as const;

function normalizeContractInstanceAddress(index: string, subindex: string): ContractInstanceAddress | undefined {
  if (!/^\d+$/.test(index) || !/^\d+$/.test(subindex)) return undefined;
  return { index: BigInt(index).toString(), subindex: BigInt(subindex).toString() };
}
/** Returns true for non-empty, even-length hex strings. */
export function isEvenHex(value: string): boolean {
  return hexString.from(value) !== undefined;
}

/** Parses non-empty even-length hex into bytes after trimming surrounding whitespace. */
export function parseHexBytes(hex: string): Buffer {
  const normalized = hexString.from(hex);
  if (normalized === undefined) throw new Error('Expected even-length hex string.');
  return Buffer.from(normalized, 'hex');
}

/**
 * Derives the CCD CAIP-2 identifier from a full genesis block hash.
 *
 * @param genesisHash - Full 64-character hex-encoded genesis block hash.
 * @returns CAIP-2 identifier in the form `ccd:<32 hex chars>`.
 * @throws {Error} If `genesisHash` is not exactly 64 hex characters.
 */
export function caip2FromGenesis(genesisHash: string): string {
  if (!/^[0-9a-fA-F]{64}$/.test(genesisHash)) {
    throw new Error(`Invalid genesis hash: expected 64 hex characters, got ${genesisHash.length}`);
  }

  return `ccd:${genesisHash.slice(0, 32)}`;
}

/**
 * Extracts the CCD CAIP-2 reference from a CAIP-2 identifier.
 *
 * @param caip2 - CAIP-2 identifier in the form `ccd:<32 hex chars>`.
 * @returns The 32-character hex reference without the `ccd:` prefix.
 * @throws {Error} If `caip2` is not a valid CCD CAIP-2 identifier.
 */
export function caip2Reference(caip2: string): string {
  const match = /^ccd:([0-9a-fA-F]{32})$/.exec(caip2);
  if (!match) {
    throw new Error(`Invalid CAIP-2 identifier: expected "ccd:<32 hex chars>", got "${caip2}"`);
  }

  return match[1]!;
}

/**
 * Checks whether two account-address strings identify the same Concordium account.
 *
 * Exact equality succeeds before parsing, so opaque identical values compare true.
 * Invalid different values return false instead of throwing.
 */
export function sameAccount(left: string, right: string): boolean {
  if (left === right) {
    return true;
  }

  try {
    return AccountAddress.isAlias(AccountAddress.fromBase58(left), AccountAddress.fromBase58(right));
  } catch {
    return false;
  }
}
