import {
  AccountAddress,
  SequenceNumber,
  Transaction,
  TransactionExpiry,
} from '@concordium/web-sdk';
import type { BuildTransactionResultDto } from '@ccd-agent-kit/mcp-utils';
import { serializeUnsignedAccountTransactionHex } from '@ccd-agent-kit/sdk-utils';
import type { AccountSigningRequirements } from '../../../concordium/client.js';
import { resolveAccountInput } from '../../accounts/accountLabels.js';
import type { ToolContext } from '../../toolPlumbing/toolTypes.js';
import { resolveTransactionMetadata } from './metadata.js';

/** Sponsorship-capable build arguments shared by every transaction builder. */
export type SponsorableArgs = {
  sender: string;
  sponsor: string | undefined;
  sequenceNumber: string | undefined;
  senderNumSignatures: string | undefined;
  sponsorNumSignatures: string | undefined;
  expiryMs: number | undefined;
};

type SignatureCounts = { sender: bigint; sponsor?: bigint; total: bigint };

/** Resolved sequence number, expiry, and sender/sponsor signature counts for one transaction build. */
export type ResolvedBuildMetadata = { sequenceNumber: string; expiry: number; signatureCounts: SignatureCounts };

type BuildContextArgs = {
  sender: string;
  sponsor?: string | undefined;
  network?: string | undefined;
} & Partial<Omit<SponsorableArgs, 'sender' | 'sponsor'>>;

/**
 * Pins the network client, resolves canonical sender/sponsor account labels, and assembles sponsorship metadata args.
 * The returned `sponsorshipArgs` carries only resolved accounts plus caller-provided sequence, expiry, and signature-count
 * overrides; guards such as `sponsorNumSignatures` requiring `sponsor` remain enforced during metadata resolution.
 */
export function resolveBuildContext(
  ctx: ToolContext,
  args: BuildContextArgs,
): { network: string; clientCtx: ToolContext; sender: string; sponsor: string | undefined; sponsorshipArgs: SponsorableArgs } {
  const { client, networkName: network } = ctx.clients.getClient(args.network);
  const sender = resolveAccountInput(args.sender, network);
  const sponsor = args.sponsor !== undefined ? resolveAccountInput(args.sponsor, network) : undefined;
  return {
    network,
    clientCtx: { ...ctx, clients: { getClient: () => ({ client, networkName: network }) } },
    sender,
    sponsor,
    sponsorshipArgs: {
      sender,
      sponsor,
      sequenceNumber: args.sequenceNumber,
      senderNumSignatures: args.senderNumSignatures,
      sponsorNumSignatures: args.sponsorNumSignatures,
      expiryMs: args.expiryMs,
    },
  };
}

/** Configures an SDK initial builder and serializes an unsigned transaction with signature-count metadata. */
export async function buildTransactionWithSponsorship(
  args: SponsorableArgs,
  builder: ReturnType<typeof Transaction.create>,
  resolvedMetadata: ResolvedBuildMetadata,
): Promise<Pick<BuildTransactionResultDto, 'transactionHex' | 'metadata'>> {
  const { sequenceNumber, expiry, signatureCounts } = resolvedMetadata;
  const configured = builder.addMetadata({
    sender: AccountAddress.fromBase58(args.sender),
    nonce: SequenceNumber.create(BigInt(sequenceNumber)),
    expiry: TransactionExpiry.fromEpochSeconds(expiry),
  });
  const multiSig = configured.addMultiSig(signatureCounts.sender);
  const signable =
    args.sponsor === undefined
      ? multiSig.build()
      : multiSig.addSponsor(AccountAddress.fromBase58(args.sponsor), signatureCounts.sponsor!).build();
  const unsigned = Transaction.preFinalized(signable);
  return {
    transactionHex: serializeUnsignedAccountTransactionHex(unsigned),
    metadata: {
      sender: args.sender,
      ...(args.sponsor !== undefined ? { sponsor: args.sponsor } : {}),
      sequenceNumber,
      expiry,
      energy: unsigned.header.energyAmount.toString(),
      senderNumSignatures: signatureCounts.sender.toString(),
      ...(signatureCounts.sponsor !== undefined ? { sponsorNumSignatures: signatureCounts.sponsor.toString() } : {}),
      totalSignatureCount: signatureCounts.total.toString(),
    },
  };
}

/** Resolves sequence number, expiry, and required signature counts for one transaction build. */
export async function resolveBuildMetadata(ctx: ToolContext, args: SponsorableArgs): Promise<ResolvedBuildMetadata> {
  const { sequenceNumber, expiry } = await resolveTransactionMetadata(ctx, args.sender, args.sequenceNumber, args.expiryMs);
  const signatureCounts = await resolveSignatureCounts(ctx, args);
  return { sequenceNumber, expiry, signatureCounts };
}

function minRequiredSignatureCount({ accountThreshold, credentialSignThresholds }: AccountSigningRequirements): bigint {
  const sorted = [...credentialSignThresholds].sort((a, b) => a - b);
  const requiredCredentials = sorted.slice(0, Math.max(accountThreshold, 0));
  const count = requiredCredentials.reduce((sum, threshold) => sum + threshold, 0);
  return BigInt(count);
}

async function resolveSignatureCounts(
  ctx: ToolContext,
  args: Pick<SponsorableArgs, 'sender' | 'sponsor' | 'senderNumSignatures' | 'sponsorNumSignatures'>,
): Promise<SignatureCounts> {
  if (args.sponsorNumSignatures !== undefined && args.sponsor === undefined) {
    throw {
      kind: 'invalid-argument',
      message: 'sponsorNumSignatures requires sponsor to be provided.',
    };
  }
  const client = ctx.clients.getClient().client;
  const sender =
    args.senderNumSignatures !== undefined
      ? BigInt(args.senderNumSignatures)
      : minRequiredSignatureCount(await client.getAccountSigningRequirements(args.sender));
  const sponsor =
    args.sponsor === undefined
      ? undefined
      : args.sponsorNumSignatures !== undefined
        ? BigInt(args.sponsorNumSignatures)
        : minRequiredSignatureCount(await client.getAccountSigningRequirements(args.sponsor));
  return { sender, ...(sponsor !== undefined && { sponsor }), total: sender + (sponsor ?? 0n) };
}
