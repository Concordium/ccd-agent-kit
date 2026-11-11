import { IdentityWorkflowError } from './workflowErrors.js';

/** Largest identity index accepted by the SDK derivation recipe. */
export const MAX_IDENTITY_INDEX = 0x7fffffff;

/** Inputs shared by identity and credential discovery stopping decisions. */
export type DiscoveryStopInput = { index: number; upperBound: number; endIndex?: number; highWater: number; misses: number; gapLimit: number };

/** Apply inclusive range, SDK bound, and post-high-water gap stopping precedence. */
export function getDiscoveryStopReason(input: DiscoveryStopInput): 'gap' | 'range' | 'limit' | undefined {
  if (input.endIndex !== undefined && input.index >= input.endIndex) return 'range';
  if (input.index >= input.upperBound) return 'limit';
  if (input.endIndex === undefined && input.index >= input.highWater && input.misses >= input.gapLimit) return 'gap';
  return undefined;
}

/** Select one past the greatest occupied identity index, rejecting namespace exhaustion. */
export function getNextIdentityIndex(occupied: readonly number[]): number {
  let highest = -1;
  for (const index of occupied) highest = Math.max(highest, index);
  if (highest >= MAX_IDENTITY_INDEX) throw new IdentityWorkflowError('INDEX_UNAVAILABLE');
  return highest + 1;
}
