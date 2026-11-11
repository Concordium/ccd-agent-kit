const HEX_PATTERN = /^(?:0x)?[0-9a-fA-F]+$/i;

/**
 * Detects whether a raw transaction input looks like supported hex.
 *
 * @param input - The raw transaction input.
 * @returns The detected input format, or `undefined` when the format is unsupported.
 */
export function detectTransactionFormat(input: string): 'hex' | undefined {
  const trimmed = input.trim();

  if (trimmed.length === 0) {
    return undefined;
  }

  if (HEX_PATTERN.test(trimmed) && normalizeHex(trimmed).length % 2 === 0) {
    return 'hex';
  }

  return undefined;
}

function normalizeHex(input: string): string {
  const trimmed = input.trim();

  return trimmed.slice(0, 2).toLowerCase() === '0x' ? trimmed.slice(2) : trimmed;
}
