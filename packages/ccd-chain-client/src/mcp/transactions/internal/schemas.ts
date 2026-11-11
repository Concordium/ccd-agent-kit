import { z } from 'zod';
import { mcpJsonValueSchema, type McpJsonValue } from '@ccd-agent-kit/mcp-utils';
import { ed25519PublicKey, publicKeyScheme } from '@ccd-agent-kit/sdk-utils';
import {
  accountAddressSchema,
  contractAddressSchema,
  networkNameSchema,
  u64StringSchema,
} from '../../toolPlumbing/toolSchemas.js';

/** Common optional header fields for all transaction builder schemas. */
export const commonBuildArgs = {
  sponsor: accountAddressSchema.optional(),
  sequenceNumber: u64StringSchema.describe('Optional sender account sequence number.').optional(),
  senderNumSignatures: u64StringSchema.describe('Optional override for the sender signature count.').optional(),
  sponsorNumSignatures: u64StringSchema.describe('Optional override for the sponsor signature count.').optional(),
  expiryMs: z.number().int().positive().describe('Transaction expiry offset in milliseconds.').optional(),
  network: networkNameSchema,
};

type RefinableArgs = Partial<Record<string, unknown>>;

function addMutuallyExclusiveFieldsIssue(args: RefinableArgs, ctx: z.RefinementCtx, left: string, right: string): void {
  if (args[left] !== undefined && args[right] !== undefined) {
    ctx.addIssue({
      code: 'custom',
      message: `Provide at most one of ${left} or ${right}.`,
      path: [left],
    });
  }
}

function addExactlyOneFieldIssue(args: RefinableArgs, ctx: z.RefinementCtx, left: string, right: string): void {
  if ((args[left] === undefined) === (args[right] === undefined)) {
    ctx.addIssue({
      code: 'custom',
      message: `Provide exactly one of ${left} or ${right}.`,
      path: [left],
    });
  }
}

function addDependentFieldIssue(args: RefinableArgs, ctx: z.RefinementCtx, dependent: string, required: string): void {
  if (args[dependent] !== undefined && args[required] === undefined) {
    ctx.addIssue({
      code: 'custom',
      message: `${dependent} requires ${required} to be provided.`,
      path: [dependent],
    });
  }
}

function addSponsorshipIssue(args: RefinableArgs, ctx: z.RefinementCtx): void {
  addDependentFieldIssue(args, ctx, 'sponsorNumSignatures', 'sponsor');
}

export const buildTransferArgsSchema = z
  .object({
    sender: accountAddressSchema,
    toAddress: accountAddressSchema,
    amountMicroCcd: u64StringSchema,
    memoText: z.string().describe('Optional plain-text memo bytes (UTF-8 encoded).').optional(),
    memoJson: mcpJsonValueSchema.describe('Optional JSON value to UTF-8 encode as the memo.').optional(),
    ...commonBuildArgs,
  })
  .superRefine((args, ctx) => {
    addMutuallyExclusiveFieldsIssue(args, ctx, 'memoText', 'memoJson');
    addSponsorshipIssue(args, ctx);
  });
export type BuildTransferArgs = z.infer<typeof buildTransferArgsSchema>;

export const buildRegisterDataArgsSchema = z
  .object({
    sender: accountAddressSchema,
    dataHex: z
      .string()
      .regex(/^(?:[0-9a-fA-F]{2})*$/, 'Expected even-length hex bytes.')
      .max(512, 'Registered data is limited to 256 bytes.')
      .describe('Hex-encoded data to register on chain.'),
    ...commonBuildArgs,
  })
  .superRefine(addSponsorshipIssue);
export type BuildRegisterDataArgs = z.infer<typeof buildRegisterDataArgsSchema>;

export const buildConfigureDelegationArgsSchema = z
  .object({
    sender: accountAddressSchema,
    delegationTarget: z.enum(['passive', 'pool']),
    poolId: u64StringSchema.describe('Validator pool ID when delegationTarget is `pool`.').optional(),
    amountMicroCcd: u64StringSchema.optional(),
    restakeEarnings: z.boolean().optional(),
    ...commonBuildArgs,
  })
  .superRefine((args, ctx) => {
    addSponsorshipIssue(args, ctx);
    if (args.delegationTarget === 'pool' && args.poolId === undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'poolId is required when delegationTarget is `pool`.',
        path: ['poolId'],
      });
    }
    if (args.delegationTarget === 'passive' && args.poolId !== undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'poolId must be omitted when delegationTarget is `passive`.',
        path: ['poolId'],
      });
    }
  });
export type BuildConfigureDelegationArgs = z.infer<typeof buildConfigureDelegationArgsSchema>;

export const buildConfigureBakerArgsSchema = z
  .object({
    sender: accountAddressSchema,
    amountMicroCcd: u64StringSchema.optional(),
    restakeEarnings: z.boolean().optional(),
    openStatus: z.enum(['open', 'closed', 'closed_for_new']).optional(),
    ...commonBuildArgs,
  })
  .superRefine(addSponsorshipIssue);
export type BuildConfigureBakerArgs = z.infer<typeof buildConfigureBakerArgsSchema>;

const publicKeySchemeSchema = z.string().transform((value, ctx) => {
  try {
    return publicKeyScheme.require(value);
  } catch (error) {
    ctx.addIssue({ code: 'custom', message: errorMessage(error) });
    return z.NEVER;
  }
});

const ed25519CredentialKeySchema = z.object({
  scheme: publicKeySchemeSchema,
  publicKey: z.string().transform((value, ctx) => {
    try {
      return ed25519PublicKey.require(value) as string;
    } catch (error) {
      ctx.addIssue({ code: 'custom', message: errorMessage(error) });
      return z.NEVER;
    }
  }),
});

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const credentialKeyIndexSchema = z
  .string()
  .regex(/^(?:0|[1-9]\d?|1\d\d|2[0-4]\d|25[0-5])$/, 'Credential key indexes must fit in 0..255.');

const replacementCredentialKeysSchema = z
  .record(credentialKeyIndexSchema, ed25519CredentialKeySchema)
  .refine((keys) => Object.keys(keys).length > 0, 'At least one replacement key is required.');

export const buildUpdateCredentialKeysArgsSchema = z
  .object({
    sender: accountAddressSchema,
    credentialIndex: z.string().regex(/^\d+$/, 'Expected a decimal credential index.').optional(),
    credentialId: z
      .string()
      .regex(/^[0-9a-fA-F]{96}$/, 'Expected a 48-byte credential ID hex string.')
      .optional(),
    keys: replacementCredentialKeysSchema,
    threshold: z.number().int().positive(),
    ...commonBuildArgs,
  })
  .superRefine((args, ctx) => {
    addExactlyOneFieldIssue(args, ctx, 'credentialIndex', 'credentialId');
    addSponsorshipIssue(args, ctx);
    const keyIndexes = Object.keys(args.keys);
    if (args.threshold > keyIndexes.length) {
      ctx.addIssue({
        code: 'custom',
        message: 'threshold must be at most the number of replacement keys.',
        path: ['threshold'],
      });
    }
  });
export type BuildUpdateCredentialKeysArgs = z.infer<typeof buildUpdateCredentialKeysArgsSchema>;

export const buildInitContractArgsSchema = z
  .object({
    sender: accountAddressSchema,
    moduleRef: z.string().describe('Hex-encoded module reference of the deployed module.'),
    initName: z.string().describe('Init receive name, e.g. `init_my_contract` (the `init_` prefix is optional).'),
    parameterHex: z.string().describe('Hex-encoded serialized init parameter bytes.').optional(),
    parameterJson: mcpJsonValueSchema.describe('JSON parameter value to serialize with the embedded module schema.').optional(),
    amountMicroCcd: u64StringSchema.optional(),
    energy: u64StringSchema.describe('Contract execution energy budget.').optional(),
    ...commonBuildArgs,
  })
  .superRefine((args, ctx) => addParameterEncodingIssue(args, ctx))
  .superRefine(addSponsorshipIssue);
export type BuildInitContractArgs = z.infer<typeof buildInitContractArgsSchema>;

export const buildUpdateContractArgsSchema = z
  .object({
    sender: accountAddressSchema,
    contract: contractAddressSchema,
    receiveName: z.string().describe('Receive name, e.g. `transfer`.'),
    parameterHex: z.string().describe('Hex-encoded serialized parameter bytes.').optional(),
    parameterJson: mcpJsonValueSchema.describe('JSON parameter value to serialize with the embedded module schema.').optional(),
    amountMicroCcd: u64StringSchema.optional(),
    energy: u64StringSchema.describe('Contract execution energy budget.').optional(),
    ...commonBuildArgs,
  })
  .superRefine((args, ctx) => addParameterEncodingIssue(args, ctx))
  .superRefine(addSponsorshipIssue);
export type BuildUpdateContractArgs = z.infer<typeof buildUpdateContractArgsSchema>;

function addParameterEncodingIssue(
  args: { parameterHex?: string | undefined; parameterJson?: McpJsonValue | undefined },
  ctx: z.RefinementCtx,
): void {
  if (args.parameterHex === undefined || args.parameterJson === undefined) return;
  ctx.addIssue({
    code: 'custom',
    message: 'parameterHex and parameterJson are mutually exclusive.',
    path: ['parameterJson'],
  });
}

const capabilitySchema = z.enum(['fund', 'release', 'send', 'cancel']);
const lockRecipientsSchema = z.union([
  z.literal('any'),
  z.array(accountAddressSchema).describe('Accounts permitted to receive funds controlled by the lock.'),
]);
const lockGrantSchema = z.object({
  account: accountAddressSchema,
  capabilities: z.array(capabilitySchema).min(1),
});
const lockMetadataSchema = z
  .object({
    name: z.string().optional(),
    description: z.string().optional(),
  })
  .catchall(mcpJsonValueSchema);

const pltUpdateBaseArgs = {
  sender: accountAddressSchema,
  ...commonBuildArgs,
};

const pltMemoFields = {
  memoText: z.string().describe('Optional plain-text memo to CBOR encode.').optional(),
  memoJson: mcpJsonValueSchema.describe('Optional JSON value to CBOR encode as the memo.').optional(),
};

const lockReferenceFields = {
  lockId: z.string().describe('Existing base58check lock identifier.').optional(),
  lockRef: z.string().describe('Reference label of a lock created earlier in the same operation list.').optional(),
};

const tokenAdminRoleSchema = z.enum([
  'updateAdminRoles',
  'mint',
  'burn',
  'updateAllowList',
  'updateDenyList',
  'pause',
  'updateMetadata',
]);

const transferOperationSchema = z
  .object({
    type: z.literal('transfer'),
    tokenId: z.string(),
    toAddress: accountAddressSchema,
    amountUnits: u64StringSchema,
    ...pltMemoFields,
  })
  .superRefine((args, ctx) => {
    addMutuallyExclusiveFieldsIssue(args, ctx, 'memoText', 'memoJson');
  });

const mintOperationSchema = z.object({
  type: z.literal('mint'),
  tokenId: z.string(),
  amountUnits: u64StringSchema,
});

const burnOperationSchema = z.object({
  type: z.literal('burn'),
  tokenId: z.string(),
  amountUnits: u64StringSchema,
});

const tokenTargetOperationBase = z.object({
  tokenId: z.string(),
  target: accountAddressSchema,
});

const addAllowListOperationSchema = tokenTargetOperationBase.extend({
  type: z.literal('add_allow_list'),
});
const removeAllowListOperationSchema = tokenTargetOperationBase.extend({
  type: z.literal('remove_allow_list'),
});
const addDenyListOperationSchema = tokenTargetOperationBase.extend({
  type: z.literal('add_deny_list'),
});
const removeDenyListOperationSchema = tokenTargetOperationBase.extend({
  type: z.literal('remove_deny_list'),
});

const pauseOperationSchema = z.object({ type: z.literal('pause'), tokenId: z.string() });
const unpauseOperationSchema = z.object({ type: z.literal('unpause'), tokenId: z.string() });

const updateMetadataOperationSchema = z.object({
  type: z.literal('update_metadata'),
  tokenId: z.string(),
  metadataUrl: z.string().describe('New metadata URL for the token.'),
});

const adminRolesOperationBase = z.object({
  tokenId: z.string(),
  account: accountAddressSchema,
  roles: z.array(tokenAdminRoleSchema).min(1),
});

const assignAdminRolesOperationSchema = adminRolesOperationBase.extend({
  type: z.literal('assign_admin_roles'),
});
const revokeAdminRolesOperationSchema = adminRolesOperationBase.extend({
  type: z.literal('revoke_admin_roles'),
});

const lockCreateOperationSchema = z
  .object({
    type: z.literal('lock_create'),
    ref: z.string().describe('Optional reference label for later operations in the same transaction.').optional(),
    recipients: lockRecipientsSchema,
    lockExpiryUnixSeconds: u64StringSchema,
    grants: z.array(lockGrantSchema),
    tokenIds: z.array(z.string()).min(1),
    keepAlive: z.boolean().optional(),
    controllerMemoText: z.string().optional(),
    controllerMemoJson: mcpJsonValueSchema.optional(),
    metadataJson: lockMetadataSchema.describe('Optional JSON object to CBOR encode as lock metadata.').optional(),
  })
  .superRefine((args, ctx) => {
    addMutuallyExclusiveFieldsIssue(args, ctx, 'controllerMemoText', 'controllerMemoJson');
  });

const lockFundOperationSchema = z
  .object({
    type: z.literal('lock_fund'),
    tokenId: z.string(),
    amountUnits: u64StringSchema,
    ...lockReferenceFields,
    ...pltMemoFields,
  })
  .superRefine((args, ctx) => {
    addExactlyOneFieldIssue(args, ctx, 'lockId', 'lockRef');
    addMutuallyExclusiveFieldsIssue(args, ctx, 'memoText', 'memoJson');
  });

const lockSendOperationSchema = z
  .object({
    type: z.literal('lock_send'),
    tokenId: z.string(),
    amountUnits: u64StringSchema,
    sourceAddress: accountAddressSchema,
    toAddress: accountAddressSchema,
    ...lockReferenceFields,
    ...pltMemoFields,
  })
  .superRefine((args, ctx) => {
    addExactlyOneFieldIssue(args, ctx, 'lockId', 'lockRef');
    addMutuallyExclusiveFieldsIssue(args, ctx, 'memoText', 'memoJson');
  });

const lockCancelOperationSchema = z
  .object({
    type: z.literal('lock_cancel'),
    ...lockReferenceFields,
    ...pltMemoFields,
  })
  .superRefine((args, ctx) => {
    addExactlyOneFieldIssue(args, ctx, 'lockId', 'lockRef');
    addMutuallyExclusiveFieldsIssue(args, ctx, 'memoText', 'memoJson');
  });

const lockReleaseOperationSchema = z
  .object({
    type: z.literal('lock_release'),
    tokenId: z.string(),
    amountUnits: u64StringSchema,
    sourceAddress: accountAddressSchema,
    ...lockReferenceFields,
    ...pltMemoFields,
  })
  .superRefine((args, ctx) => {
    addExactlyOneFieldIssue(args, ctx, 'lockId', 'lockRef');
    addMutuallyExclusiveFieldsIssue(args, ctx, 'memoText', 'memoJson');
  });

export const buildPltArgsSchema = z
  .object({
    ...pltUpdateBaseArgs,
    operations: z
      .array(
        z.union([
          transferOperationSchema,
          mintOperationSchema,
          burnOperationSchema,
          addAllowListOperationSchema,
          removeAllowListOperationSchema,
          addDenyListOperationSchema,
          removeDenyListOperationSchema,
          pauseOperationSchema,
          unpauseOperationSchema,
          updateMetadataOperationSchema,
          assignAdminRolesOperationSchema,
          revokeAdminRolesOperationSchema,
          lockCreateOperationSchema,
          lockFundOperationSchema,
          lockSendOperationSchema,
          lockCancelOperationSchema,
          lockReleaseOperationSchema,
        ]),
      )
      .min(1),
  })
  .superRefine((args, ctx) => {
    addSponsorshipIssue(args, ctx);
    const refs = new Set<string>();
    for (const [index, operation] of args.operations.entries()) {
      if (operation.type === 'lock_create' && operation.ref !== undefined) {
        if (refs.has(operation.ref)) {
          ctx.addIssue({
            code: 'custom',
            message: `Duplicate lock ref '${operation.ref}'.`,
            path: ['operations', index, 'ref'],
          });
        }
        refs.add(operation.ref);
      }
    }
  });
export type BuildPltArgs = z.infer<typeof buildPltArgsSchema>;
