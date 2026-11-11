import { findAccountLabelForAddress, getAccountCredentialObservation, resolveNetwork } from '@ccd-agent-kit/config-utils';
import type { YubiKeyInteractionProvider, YubiKeyService } from '@ccd-agent-kit/piv-utils';
import { caip2Reference } from '../config/grpc.js';
import { AccountCredentialsSigningBackend, hasAvailableObservedCredentialKey } from './backends/accountCredentials.js';
import type { RoleSeparatedSignatures, SignatureRequirements, SignedTransactionResult, SigningRole } from './model.js';
import { parseUnsignedHexAccountTransaction } from '../parser/parseTransaction.js';
import { signParsedTransaction } from './signTransaction.js';

export type ManagedTransactionSigningErrorCode = 'missing_role_address' | 'account_not_managed';

export class ManagedTransactionSigningError extends Error {
  public constructor(
    public readonly code: ManagedTransactionSigningErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ManagedTransactionSigningError';
  }
}

export interface ManagedTransactionSigningOptions {
  transactionHex: string;
  role: SigningRole;
  signatures?: RoleSeparatedSignatures;
  keys?: string[];
  maxSignatures?: number;
  signatureRequirements?: SignatureRequirements;
  network?: string;
  yubiKeyInteraction?: Pick<YubiKeyInteractionProvider, 'promptPin'>;
  /** Optional process-shared YubiKey service. */
  yubiKeyService?: YubiKeyService;
}

export interface ManagedTransactionSigningResult extends SignedTransactionResult {
  [key: string]: unknown;
  address: string;
  network: string;
  networkCaip2Ref?: string;
  /** Public account label mapped to the signing address, when known. */
  label?: string;
  signingAddress?: string;
}

/** Signs an unsigned transaction using locally managed wallet-export keys. */
export async function signManagedTransaction(
  options: ManagedTransactionSigningOptions,
): Promise<ManagedTransactionSigningResult> {
  let unsigned: ReturnType<typeof parseUnsignedHexAccountTransaction>;
  try {
    unsigned = parseUnsignedHexAccountTransaction(options.transactionHex);
  } catch {
    throw new ManagedTransactionSigningError(
      'missing_role_address',
      `Could not extract ${options.role} address from transaction.`,
    );
  }
  const address = options.role === 'sender' ? unsigned.sender : unsigned.version === 1 ? unsigned.sponsor : undefined;

  if (!address) {
    throw new ManagedTransactionSigningError(
      'missing_role_address',
      `Could not extract ${options.role} address from transaction.`,
    );
  }

  const network = resolveNetwork(options.network);
  const caip2Ref = caip2Reference(network.config.caip2);
  const networkName = network.name;
  const observedCredentials = getAccountCredentialObservation(address, caip2Ref);

  if (!observedCredentials) {
    throw new ManagedTransactionSigningError(
      'account_not_managed',
      `Address ${address} is not managed for network '${networkName}'. Refresh finalized account credentials with ccd-config-manager account credentials refresh or the chain MCP refresh tool.`,
    );
  }

  if (!hasAvailableObservedCredentialKey(observedCredentials)) {
    throw new ManagedTransactionSigningError(
      'account_not_managed',
      `No enabled signer key matches finalized account credentials for ${address} on network '${networkName}'. Import a software account key with ccd-config-manager signing-key import --backend software.`,
    );
  }

  const label = findAccountLabelForAddress(address, caip2Ref);
  const backend = new AccountCredentialsSigningBackend(observedCredentials, options.yubiKeyService, options.yubiKeyInteraction);
  const result = await signParsedTransaction(options.transactionHex, unsigned, {
    backend,
    keys: options.keys,
    maxSignatures: options.maxSignatures,
    role: options.role,
    signatureRequirements: options.signatureRequirements,
    signatures: options.signatures,
  });

  const signingResult: ManagedTransactionSigningResult = {
    address,
    ...(label ? { label } : {}),
    network: networkName,
    ...result,
  };

  Object.defineProperty(signingResult, 'networkCaip2Ref', {
    enumerable: false,
    value: caip2Ref,
  });

  return signingResult;
}
