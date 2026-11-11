/** Returns a deterministic JSON identity with object keys sorted recursively. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * Reorders stored values only when requested identities are an exact, duplicate-free permutation.
 * Returns `undefined` without changing either input when the permutation is invalid.
 */
export function reorderExact<T, R>(
  stored: readonly T[],
  requested: readonly R[],
  storedIdentity: (value: T) => string | undefined,
  requestedIdentity: (value: R) => string | undefined,
): T[] | undefined {
  const storedIds = stored.map(storedIdentity);
  const requestedIds = requested.map(requestedIdentity);
  if (storedIds.some((identity) => identity === undefined)
    || requestedIds.some((identity) => identity === undefined)
    || storedIds.length !== requestedIds.length
    || new Set(storedIds).size !== storedIds.length
    || new Set(requestedIds).size !== requestedIds.length) return undefined;
  const byIdentity = new Map(stored.map((value, index) => [storedIds[index]!, value]));
  if (requestedIds.some((identity) => !byIdentity.has(identity!))) return undefined;
  return requestedIds.map((identity) => byIdentity.get(identity!)!);
}

/** Merges incoming values into their first matching stored position and appends new identities. */
export function mergeStable<T>(
  stored: readonly T[],
  incoming: readonly T[],
  identity: (value: T) => string,
  merge: (stored: T, incoming: T) => T,
): T[] {
  const result = [...stored];
  for (const value of incoming) {
    const index = result.findIndex((candidate) => identity(candidate) === identity(value));
    if (index < 0) result.push(value);
    else result[index] = merge(result[index]!, value);
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
