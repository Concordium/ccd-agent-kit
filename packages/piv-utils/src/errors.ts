/** Missing-device selection failure, preserving the transport's existing public messages. */
export class PivDeviceNotFoundError extends Error {
  /** Construct a missing-device error for an optional decimal serial selector. */
  constructor(serial?: string) {
    super(serial ? `YubiKey ${serial} not found.` : 'No YubiKey found.');
    this.name = 'PivDeviceNotFoundError';
  }
}

/** Recognize existing native PC/SC sharing-violation representations without retaining diagnostics. */
export function isPivSharingViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const fields = error as { code?: unknown; status?: unknown; errno?: unknown };
  return [fields.code, fields.status, fields.errno].some((value) => value === 'SCARD_E_SHARING_VIOLATION' || typeof value === 'number' && (value >>> 0) === 0x8010000b)
    || error instanceof Error && /\(0x8010000b\)/i.test(error.message);
}
