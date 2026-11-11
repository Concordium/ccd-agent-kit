import {
  CredentialRegistrationId,
  Energy,
  Payload,
  Transaction,
  UpdateCredentialKeysHandler,
} from '@concordium/web-sdk';
import {
  resolveNetwork,
  setAccountCredentialObservation,
  setAccountCredentialRefreshError,
  type AccountCredentialRefreshError,
} from '@ccd-agent-kit/config-utils';
import type { BuildTransactionResultDto } from '@ccd-agent-kit/mcp-utils';
import { caip2Reference } from '@ccd-agent-kit/sdk-utils';
import type { ToolContext } from '../../toolPlumbing/toolTypes.js';
import type { BuildUpdateCredentialKeysArgs } from './schemas.js';
import {
  buildTransactionWithSponsorship,
  resolveBuildContext,
  resolveBuildMetadata,
} from './buildContext.js';

/** Builds an unsigned `UpdateCredentialKeys` transaction after refreshing the sender's finalized credential observations. */
export async function buildUpdateCredentialKeys(
  ctx: ToolContext,
  args: BuildUpdateCredentialKeysArgs,
): Promise<BuildTransactionResultDto> {
  const { clientCtx, sender, network, sponsorshipArgs } = resolveBuildContext(ctx, args);
  const client = clientCtx.clients.getClient().client;
  const caip2Ref = caip2Reference(resolveNetwork(network).config.caip2);
  let refreshed: Awaited<ReturnType<typeof client.getFinalizedAccountCredentials>>;
  try {
    refreshed = await client.getFinalizedAccountCredentials(sender);
  } catch (error) {
    setAccountCredentialRefreshError(sender, refreshErrorFromUnknown(error), caip2Ref);
    throw error;
  }
  setAccountCredentialObservation(refreshed.canonicalAddress, refreshed.observation, caip2Ref);

  const credential = resolveCredentialTarget(refreshed.observation.credentials, args);
  const keys = Object.fromEntries(
    Object.entries(args.keys).map(([keyIndex, key]) => [
      Number(keyIndex),
      { schemeId: key.scheme, verifyKey: key.publicKey.toLowerCase() },
    ]),
  );
  const metadata = await resolveBuildMetadata(clientCtx, sponsorshipArgs);
  const transaction = await buildTransactionWithSponsorship(
    sponsorshipArgs,
    updateCredentialKeysBuilder(
      credential.credentialId,
      { keys, threshold: args.threshold },
      BigInt(Object.keys(refreshed.observation.credentials).length),
    ),
    metadata,
  );
  return {
    transactionType: 'updateCredentialKeys',
    payload: {
      credentialIndex: credential.index,
      credentialId: credential.credentialId,
      before: {
        ...(credential.entry.threshold !== undefined ? { threshold: credential.entry.threshold } : {}),
        keys: credential.entry.keys,
      },
      after: {
        threshold: args.threshold.toString(),
        keys: args.keys,
      },
      sourceBlock: { ...refreshed.observation.sourceBlock },
      nextSteps: [
        "Sign this transaction with the account's current keys.",
        'Finalize and submit the signed block item.',
        'After finalization succeeds, call refresh_account_credentials for the sender. Old replaced keys may no longer be valid for this credential.',
      ],
    },
    ...transaction,
  };
}

function updateCredentialKeysBuilder(
  credentialId: string,
  keys: { keys: Record<number, { schemeId: 'Ed25519'; verifyKey: string }>; threshold: number },
  currentNumberOfCredentials: bigint,
): Transaction.Builder {
  const payload = {
    credId: CredentialRegistrationId.fromHexString(credentialId),
    keys,
  };
  const handler = new UpdateCredentialKeysHandler();
  return new Transaction.Builder(
    { executionEnergyAmount: Energy.create(handler.getBaseEnergyCost({ ...payload, currentNumberOfCredentials })) },
    Payload.updateCredentialKeys(payload),
  );
}

/** Resolves a schema-validated credential selector against one finalized account observation. */
export function resolveCredentialTarget(
  credentials: Record<
    string,
    { credentialId?: string; threshold?: string; keys: Record<string, { scheme: 'Ed25519'; publicKey: string }> }
  >,
  args: BuildUpdateCredentialKeysArgs,
): {
  index: string;
  credentialId: string;
  entry: { credentialId?: string; threshold?: string; keys: Record<string, { scheme: 'Ed25519'; publicKey: string }> };
} {
  if (args.credentialId !== undefined) {
    const credentialId = args.credentialId.toLowerCase();
    const found = Object.entries(credentials).find(
      ([, credential]) => credential.credentialId?.toLowerCase() === credentialId,
    );
    if (found === undefined) {
      throw { kind: 'invalid-argument', message: 'Credential ID is not present on the sender account.' };
    }
    return { index: found[0], credentialId: found[1].credentialId ?? credentialId, entry: found[1] };
  }
  const index = args.credentialIndex as string;
  const entry = credentials[index];
  if (entry === undefined) {
    throw { kind: 'invalid-argument', message: `Credential index ${index} is not present on the sender account.` };
  }
  if (entry.credentialId === undefined) {
    throw { kind: 'invalid-argument', message: `Credential index ${index} has no observed credential ID.` };
  }
  return { index, credentialId: entry.credentialId, entry };
}

function refreshErrorFromUnknown(error: unknown): AccountCredentialRefreshError {
  const candidate = error as { kind?: unknown; message?: unknown } | undefined;
  const kind =
    candidate?.kind === 'invalid-argument'
      ? 'not_found'
      : candidate?.kind === 'node' || candidate?.kind === 'not_found' || candidate?.kind === 'network'
        ? candidate.kind
        : 'unknown';
  return {
    attempted: new Date().toISOString(),
    kind,
    message: typeof candidate?.message === 'string' ? candidate.message : String(error),
  };
}
