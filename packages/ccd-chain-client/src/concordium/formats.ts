import { CcdAmount, TokenAmount } from '@concordium/web-sdk';

export type MicroCcd = bigint | string;

/** Converts an unsigned 64-bit microCCD amount to a fixed-six-decimal CCD string (no unit suffix). */
export function microCcdToCcd(microCcd: MicroCcd): string {
  return CcdAmount.fromMicroCcd(BigInt(microCcd)).toString();
}

/** Converts microCCD to a human-readable CCD string, e.g. `123.450000 CCD`. */
export function formatCcd(microCcd: MicroCcd): string {
  return `${microCcdToCcd(microCcd)} CCD`;
}

/**
 * Converts a raw token amount (smallest unit) to a decimal string using the
 * token's decimals, e.g. `formatTokenAmount('1234567890', 6)` → `1234.567890`.
 * SDK validation requires an unsigned 64-bit amount and an integer decimal count from 0 through 255.
 */
export function formatTokenAmount(amount: bigint | string, decimals: number): string {
  return TokenAmount.create(BigInt(amount), decimals).toString();
}
