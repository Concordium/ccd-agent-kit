import { hexString } from './keys.js';

/** Normalized message input accepted by CCD signing and verification workflows. */
export interface NormalizedMessageInput {
  /** Indicates whether the caller supplied plain text or hex-encoded bytes. */
  inputFormat: 'text' | 'hex';
  /** Exact message bytes to sign or verify. */
  messageBytes: Uint8Array;
  /** Exact message bytes encoded as lowercase hex. */
  messageHex: string;
  /** Original plain-text input when `inputFormat` is `text`. */
  messageText?: string;
}

/** Message input arguments. Exactly one field must be provided. */
export interface MessageInputArgs {
  /** Plain-text message to encode as UTF-8. */
  messageText?: string;
  /** Hex-encoded exact message bytes. */
  messageHex?: string;
}
/**
 * Normalizes mutually exclusive text or hex message input into exact bytes.
 * Hex input permits surrounding whitespace; text input is preserved verbatim.
 *
 * @param args - Message input arguments containing exactly one of `messageText` or `messageHex`.
 * @returns Normalized bytes and lowercase hex representation.
 * @throws {Error} If the input is ambiguous or invalid.
 */
export function normalizeMessageInput(args: MessageInputArgs): NormalizedMessageInput {
  const hasText = args.messageText !== undefined;
  const hasHex = args.messageHex !== undefined;

  if (hasText === hasHex) {
    throw new Error('Provide exactly one of messageText or messageHex.');
  }

  if (hasText) {
    const messageText = args.messageText!;
    const bytes = Buffer.from(messageText, 'utf8');
    return {
      inputFormat: 'text',
      messageBytes: Uint8Array.from(bytes),
      messageHex: bytes.toString('hex'),
      messageText,
    };
  }

  const messageHex = hexString.from(args.messageHex!);
  if (messageHex === undefined) {
    throw new Error('Message hex must be a valid even-length hex string.');
  }

  const messageBytes = Uint8Array.from(Buffer.from(messageHex, 'hex'));
  return {
    inputFormat: 'hex',
    messageBytes,
    messageHex,
  };
}
