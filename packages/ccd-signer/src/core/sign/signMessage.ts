import {
  AccountAddress,
  signMessage as sdkSignMessage,
  type AccountTransactionSignature,
  type AccountSigner,
} from '@concordium/web-sdk';
import { cloneSignatureMap, normalizeMessageInput } from '@ccd-agent-kit/sdk-utils';

import type { TransactionSigningBackend } from './transactionSigningBackend.js';
import { SigningError } from './signTransaction.js';

export { SigningError } from './signTransaction.js';

/**
 * Options for signing an arbitrary off-chain message.
 */
export interface SignMessageOptions {
  /** Managed account address used when constructing the Concordium message digest. */
  account: string;
  /** Backend used to produce the detached signature. */
  backend: TransactionSigningBackend;
  /** Plain-text message to UTF-8 encode before signing. */
  messageText?: string;
  /** Hex-encoded message bytes to sign exactly as provided. */
  messageHex?: string;
}

/**
 * Stable result returned after signing an arbitrary off-chain message.
 */
export interface SignedMessageResult {
  /** Managed account address used to sign the message. */
  account: string;
  /** Indicates whether the input was interpreted as text or raw hex bytes. */
  inputFormat: 'text' | 'hex';
  /** Exact message bytes that were signed, encoded as hex. */
  messageHex: string;
  /** Original text input when the message came from plain text. */
  messageText?: string;
  /** Detached Concordium account signature map owned by the result object. */
  signature: AccountTransactionSignature;
}

/**
 * Signs arbitrary off-chain message bytes for a managed Concordium account.
 *
 * @param options - Message-signing options.
 * @returns Stable message-signing result containing the exact signed bytes and an owned signature-map clone.
 * @throws {SigningError} If the input is invalid.
 */
export async function signMessage(options: SignMessageOptions): Promise<SignedMessageResult> {
  const normalizedInput = normalizeSigningMessageInput(options);
  const account = parseAccountAddress(options.account);
  const signer = createAccountSignerAdapter(options.backend);
  const signature = await sdkSignMessage(account, normalizedInput.messageBytes, signer);

  return {
    account: options.account,
    inputFormat: normalizedInput.inputFormat,
    messageHex: normalizedInput.messageHex,
    messageText: normalizedInput.messageText,
    signature: cloneSignatureMap(signature),
  };
}

function normalizeSigningMessageInput(options: SignMessageOptions) {
  try {
    return normalizeMessageInput({
      ...(options.messageText !== undefined ? { messageText: options.messageText } : {}),
      ...(options.messageHex !== undefined ? { messageHex: options.messageHex } : {}),
    });
  } catch (error) {
    throw new SigningError('invalid_input', error instanceof Error ? error.message : String(error));
  }
}

function parseAccountAddress(account: string): AccountAddress.Type {
  try {
    return AccountAddress.fromBase58(account);
  } catch {
    throw new SigningError('invalid_input', `Invalid account address: ${account}`);
  }
}

function createAccountSignerAdapter(backend: TransactionSigningBackend): AccountSigner {
  return {
    async sign(digest: ArrayBuffer): Promise<AccountTransactionSignature> {
      return backend.createSignature({
        digest: Uint8Array.from(Buffer.from(digest)),
        existingSignatures: {},
        maxSignatures: 1,
        missingSignatures: 1,
        role: 'sender',
      });
    },
    getSignatureCount(): bigint {
      return 1n;
    },
  };
}
