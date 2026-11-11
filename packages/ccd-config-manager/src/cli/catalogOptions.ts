/** Parses one public custody location from a CLI JSON value. */
export function locationObject(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('Location must be a JSON object.');
  return parsed as Record<string, unknown>;
}

/** Parses an ordered location list, retaining the caller's diagnostic wording. */
export function locationList(value: string, message = 'Locations must be a JSON array of objects.'): Array<Record<string, unknown>> {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed) || parsed.some(entry => typeof entry !== 'object' || entry === null || Array.isArray(entry))) throw new Error(message);
  return parsed as Array<Record<string, unknown>>;
}
