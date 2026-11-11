import { jsonTextToolResult, type TextToolResultBigIntSafe } from '@ccd-agent-kit/mcp-utils';
import {
  findAccountLabelForAddress,
  getAccountCredentialObservation,
  resolveAccountLabel,
  resolveNetwork,
} from '@ccd-agent-kit/config-utils';
import type { AccountTransactionSignature } from '@concordium/web-sdk';
import { caip2Reference } from '../../core/config/grpc.js';
import { AccountCredentialsSigningBackend, hasAvailableObservedCredentialKey } from '../../core/sign/backends/accountCredentials.js';
import { signMessage } from '../../core/sign/signMessage.js';
import { messageFromUnknown, signerMcpErrorResult } from './toolErrors.js';
import type { YubiKeyService } from '@ccd-agent-kit/piv-utils';

/** Account selector and message bytes for detached account-signature creation. */
export interface SignMessageToolArguments {
  /** Account address or public account label to sign the message with. */
  account: string;
  /** Plain-text message to UTF-8 encode before signing. */
  messageText?: string;
  /** Hex-encoded message bytes to sign exactly as provided. */
  messageHex?: string;
  /** Return reflected input fields for debugging. Defaults to false. */
  returnInput?: boolean;
  /** Optional network name. When omitted, uses the default network. */
  network?: string;
}

/** Message signature result with resolved account-label context when available. */
export interface SignMessageToolStructuredContent {
  [key: string]: unknown;
  /** Managed account address used to sign the message. */
  account: string;
  /** Indicates whether the input was interpreted as text or raw hex bytes. */
  inputFormat: 'text' | 'hex';
  /** Exact message bytes that were signed, encoded as hex, when returnInput is true. */
  messageHex?: string;
  /** Original text input when returnInput is true and the message came from plain text. */
  messageText?: string;
  /** Detached Concordium account signature map. */
  signature: AccountTransactionSignature;
  /** Account label selected or mapped to the resolved account on the active network, when known. */
  label?: string;
  /** Network whose finalized credential observation is used to select signer-held keys. */
  network: string;
}

/** Stable MCP tool name for detached message signing. */
export const signMessageTool = {
  name: 'sign_message',
} as const;

/**
 * Executes the `concordium_sign_message` MCP tool.
 *
 * @param args - Tool arguments.
 * @param yubiKeyService - Optional process-shared YubiKey service.
 * @returns MCP result containing human-readable and structured output.
 */
export async function executeSignMessageTool(
  args: SignMessageToolArguments,
  yubiKeyService?: YubiKeyService,
): Promise<TextToolResultBigIntSafe & { structuredContent?: SignMessageToolStructuredContent }> {
  try {
    const network = resolveNetwork(args.network);
    const caip2Ref = caip2Reference(network.config.caip2);
    const networkName = network.name;
    const selected = resolveAccountLabel(args.account, caip2Ref);
    const address = selected?.address ?? args.account;
    const observation = getAccountCredentialObservation(address, caip2Ref);

    if (observation === undefined) {
      return signerMcpErrorResult({ account: args.account, kind: 'missing-account-credentials', network: networkName });
    }
    if (!hasAvailableObservedCredentialKey(observation)) {
      return signerMcpErrorResult({ account: args.account, kind: 'no-local-account-key', network: networkName });
    }

    const backend = new AccountCredentialsSigningBackend(observation, yubiKeyService);
    const result = await signMessage({
      account: address,
      backend,
      messageHex: args.messageHex,
      messageText: args.messageText,
    });

    const { messageHex, messageText, ...resultWithoutInput } = result;
    void messageHex;
    void messageText;
    const structuredContent: SignMessageToolStructuredContent = {
      ...resultWithoutInput,
      ...(args.returnInput === true ? { messageHex: result.messageHex } : {}),
      ...(args.returnInput === true && result.messageText !== undefined ? { messageText: result.messageText } : {}),
      label: selected?.label ?? findAccountLabelForAddress(address, caip2Ref),
      network: networkName,
    };

    return jsonTextToolResult(structuredContent) as TextToolResultBigIntSafe & {
      structuredContent: SignMessageToolStructuredContent;
    };
  } catch (error) {
    return signerMcpErrorResult({ kind: 'signing-failed', message: messageFromUnknown(error) });
  }
}
