import { jsonTextToolResult, type TextToolResultBigIntSafe } from '@ccd-agent-kit/mcp-utils';
import type { AccountTransactionSignature } from '@concordium/web-sdk';
import type { RoleSeparatedSignatures, SignatureRequirements } from '../../core/sign/model.js';
import { parseTransaction } from '../../core/parser/parseTransaction.js';
import { finalizeTransaction } from '../../core/sign/finalizeTransaction.js';
import { ManagedTransactionSigningError, signManagedTransaction } from '../../core/sign/managedTransactionSigning.js';
import { annotateParsedTransactionAccounts } from '../annotateParsedTransaction.js';
import { messageFromUnknown, signerMcpErrorResult } from './toolErrors.js';
import type { YubiKeyService } from '@ccd-agent-kit/piv-utils';

/** Unsigned transaction plus controls for selecting which signer-held credential keys may sign. */
export interface SignTransactionToolArguments {
  /** The unsigned transaction hex to sign. */
  transactionHex: string;
  /** The signing role. */
  role: 'sender' | 'sponsor';
  /** Existing detached signatures to merge before signing. */
  signatures?: RoleSeparatedSignatures | RoleSeparatedSignatures[];
  /** Exact credential/key pairs to sign, such as `0:0`. */
  keys?: string[];
  /** Maximum number of automatically selected keys to sign when keys are omitted. */
  maxSignatures?: number;
  /** Optional builder-compatible signature requirements. */
  signatureRequirements?: SignatureRequirements;
  /** Include parsed transaction review output. Defaults to false. */
  describe?: boolean;
  /** Create blockItemHex when possible. Defaults to true; false means do not create blockItemHex. */
  finalize?: boolean;
  /** Return reflected input fields for debugging. Defaults to false. */
  returnInput?: boolean;
  /** Optional network name. When omitted, uses the default network. */
  network?: string;
}

/** Stable MCP tool name for producing detached transaction signatures. */
export const signTransactionTool = {
  name: 'sign_transaction',
} as const;

/**
 * Signs only when finalized credentials identify matching signer-held keys for the requested role.
 *
 * @param args - Tool arguments.
 * @param yubiKeyService - Optional process-shared YubiKey service.
 */
export async function executeSignTransactionTool(
  args: SignTransactionToolArguments,
  yubiKeyService?: YubiKeyService,
): Promise<TextToolResultBigIntSafe & { structuredContent?: Record<string, unknown> }> {
  try {
    const result = await signManagedTransaction({
      transactionHex: args.transactionHex,
      keys: args.keys,
      maxSignatures: args.maxSignatures,
      network: args.network,
      role: args.role,
      signatureRequirements: args.signatureRequirements,
      signatures: normalizeSignatureSets(args.signatures),
      yubiKeyService,
    });
    const { transaction, ...resultWithoutInput } = result;
    void transaction;
    const structuredContent = {
      ...resultWithoutInput,
      ...(args.returnInput === true ? { transaction: args.transactionHex } : {}),
      ...(result.isFullySigned && args.finalize !== false && args.signatureRequirements !== undefined
        ? finalizeTransaction({
            transactionHex: args.transactionHex,
            signatureRequirements: args.signatureRequirements,
            signatures: result.signatures,
          })
        : {}),
      ...(args.describe === true
        ? {
            parsedTransaction: annotateParsedTransactionAccounts(
              parseTransaction(args.transactionHex, { format: 'hex' }),
              { caip2Ref: result.networkCaip2Ref as string },
            ),
          }
        : {}),
    };

    return jsonTextToolResult(structuredContent) as TextToolResultBigIntSafe & { structuredContent: Record<string, unknown> };
  } catch (error) {
    if (error instanceof ManagedTransactionSigningError) {
      return signerMcpErrorResult({ kind: 'managed-signing-error', message: error.message });
    }
    return signerMcpErrorResult({ kind: 'signing-failed', message: messageFromUnknown(error) });
  }
}

function normalizeSignatureSets(signatures: RoleSeparatedSignatures | RoleSeparatedSignatures[] | undefined): RoleSeparatedSignatures {
  const merged = { sender: {}, sponsor: {} } as RoleSeparatedSignatures;
  for (const signatureSet of Array.isArray(signatures) ? signatures : signatures === undefined ? [] : [signatures]) {
    mergeRole(merged.sender, signatureSet.sender);
    mergeRole(merged.sponsor, signatureSet.sponsor);
  }
  return merged;
}

function mergeRole(target: AccountTransactionSignature, source: AccountTransactionSignature): void {
  for (const [credentialIndex, keys] of Object.entries(source)) {
    Object.assign((target[Number(credentialIndex)] ??= {}), keys);
  }
}
