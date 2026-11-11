/** Safely converts bigint values in a JSON-like tree to decimal strings. */
export function stringifyBigInt(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString(10);
  if (typeof value === 'number' || typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(stringifyBigInt);
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) result[key] = stringifyBigInt(val);
    return result;
  }
  return value;
}

/** Throws if a value contains a bigint anywhere in a JSON-like tree. */
export function assertNoBigInt(value: unknown): void {
  if (typeof value === 'bigint') {
    throw new Error('bigint value found in MCP DTO; use stringifyBigInt to convert to decimal string first.');
  }
  if (typeof value === 'number' || typeof value === 'string') return;
  if (Array.isArray(value)) {
    for (const element of value) assertNoBigInt(element);
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const val of Object.values(value)) assertNoBigInt(val);
  }
}

/** Converts a value to JSON-safe structured data by stringifying bigint values. */
export function toJsonSafe(value: unknown): unknown {
  return JSON.parse(JSON.stringify(stringifyBigInt(value)));
}

/** Pretty-prints JSON-safe MCP output. */
export function stringifyJsonSafe(value: unknown): string {
  return JSON.stringify(stringifyBigInt(value), null, 2);
}

/**
 * Serializes one JSON file document with two-space indentation and one trailing newline.
 * @throws {TypeError} If the root cannot be serialized, or native JSON serialization fails.
 */
export function serializeJsonFile(value: unknown): string {
  const serialized = JSON.stringify(value, null, 2);
  if (serialized === undefined) throw new TypeError('Value cannot be serialized as a JSON document.');
  return `${serialized}\n`;
}
