import { z } from 'zod';
import {
  findAccountLabelForAddress,
  getAccountCredentialObservation,
  resolveAccountLabel,
  resolveNetwork,
} from '@ccd-agent-kit/config-utils';
import { validateCliOptions } from '@ccd-agent-kit/cli-utils';

import { caip2Reference } from '../core/config/grpc.js';
import { AccountCredentialsSigningBackend, hasAvailableObservedCredentialKey } from '../core/sign/backends/accountCredentials.js';
import { signMessage } from '../core/sign/signMessage.js';
import { CliUsageError } from './signCommand.js';
import { createCliYubiKeyInteraction } from './yubiKeyInteraction.js';
import { loadCliInputSource, resolveCliInputSource, type CliInputSource } from './inputLoader.js';

export { CliUsageError } from './signCommand.js';

/** Typed request accepted by the message-signing handler after Commander parsing. */
export interface SignMessageCommandRequest {
  /** Account address or public account label used to select signing credentials. */
  account: string;
  source: CliInputSource;
  format: 'text' | 'hex';
  network?: string;
}

/**
 * Runtime hooks used by the CLI message-signing command.
 */
export interface RunSignMessageCommandOptions {
  request: SignMessageCommandRequest;
  /** Optional stdin content for tests and non-process callers. */
  stdin?: string;
  /** Receives stdout lines. */
  stdout: string[];
  /** Receives stderr lines. */
  stderr: string[];
  /** Optional YubiKey PIN prompt for tests and alternate hosts. */
  promptPin?: () => Promise<string>;
}

/** Builds a sign-message request with an account address or public account-label selector. */
export function createSignMessageCommandRequest(options: { account: string; input?: string; inputFile?: string; stdin?: boolean; format: string; network?: string }): SignMessageCommandRequest {
  try {
    const normalized = validateCliOptions(z.object({ account: z.string(), format: z.enum(['text', 'hex']), network: z.string().optional() }), options);
    return {
      account: normalized.account,
      format: normalized.format,
      network: normalized.network,
      source: resolveCliInputSource(options, signMessageCommandMessages.singleInputSourceRequired),
    };
  } catch (error) {
    throw new CliUsageError(error instanceof Error ? error.message : String(error));
  }
}

/** Typed errors owned by the message signing CLI command. */
export type SignMessageCommandError =
  | { kind: 'single-input-source-required' }
  | { kind: 'missing-account-credentials'; account: string; network: string }
  | { kind: 'no-local-account-key'; account: string; network: string }
  | { kind: 'signing-failed'; message: string };

/** User-facing messages owned by the message signing CLI command. */
export const signMessageCommandMessages = {
  missingAccountCredentials: (account: string, network: string) =>
    `No finalized account credentials cached for '${account}' on network '${network}'. Refresh with ccd-config-manager account credentials refresh.`,
  noLocalAccountKey: (account: string, network: string) =>
    `No local signer key matches finalized account credentials for '${account}' on network '${network}'.`,
  signingFailed: (message: string) => `Signing failed: ${message}`,
  singleInputSourceRequired: 'A single input source must be provided via --input, --input-file, or --stdin.',
} as const;

/** Renders typed message signing command errors for the CLI boundary. */
export function renderSignMessageCommandError(error: SignMessageCommandError): string {
  switch (error.kind) {
    case 'missing-account-credentials':
      return signMessageCommandMessages.missingAccountCredentials(error.account, error.network);
    case 'no-local-account-key':
      return signMessageCommandMessages.noLocalAccountKey(error.account, error.network);
    case 'signing-failed':
      return signMessageCommandMessages.signingFailed(error.message);
    case 'single-input-source-required':
      return signMessageCommandMessages.singleInputSourceRequired;
  }
}

/**
 * Runs the `sign-message` CLI command.
 *
 * @param options - Runtime command options.
 * @returns Desired process exit code.
 */
export async function runSignMessageCommand(options: RunSignMessageCommandOptions): Promise<number> {
  try {
    const rawInput = await loadCliInputSource(options.request.source, options.stdin);

    const network = resolveNetwork(options.request.network);
    const caip2Ref = caip2Reference(network.config.caip2);
    const networkName = network.name;
    const selected = resolveAccountLabel(options.request.account, caip2Ref);
    const address = selected?.address ?? options.request.account;
    const observation = getAccountCredentialObservation(address, caip2Ref);

    if (observation === undefined) {
      options.stderr.push(renderSignMessageCommandError({ account: options.request.account, kind: 'missing-account-credentials', network: networkName }));
      return 1;
    }
    if (!hasAvailableObservedCredentialKey(observation)) {
      options.stderr.push(renderSignMessageCommandError({ account: options.request.account, kind: 'no-local-account-key', network: networkName }));
      return 1;
    }

    const backend = new AccountCredentialsSigningBackend(observation, undefined, createCliYubiKeyInteraction(options.promptPin));
    const result = await signMessage({
      account: address,
      backend,
      ...(options.request.format === 'text' ? { messageText: rawInput } : { messageHex: rawInput }),
    });
    const accountLabel = selected?.label ?? findAccountLabelForAddress(address, caip2Ref);

    options.stdout.push(
      JSON.stringify(
        {
          ...result,
          ...(accountLabel ? { label: accountLabel } : {}),
          network: networkName,
        },
        null,
        2,
      ),
    );
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    options.stderr.push(renderSignMessageCommandError({ kind: 'signing-failed', message }));
    return 1;
  }
}
