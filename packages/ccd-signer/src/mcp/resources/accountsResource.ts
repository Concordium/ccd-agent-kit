import {
  createNetworkResourceAdapter,
  findAccountLabelInMap,
  loadAccountCredentials,
  loadAccountLabels,
} from '@ccd-agent-kit/config-utils';
import {
  registerNetworkResourceFamily,
  type McpJsonValue,
} from '@ccd-agent-kit/mcp-utils';
import type { PublicKeyScheme } from '@ccd-agent-kit/sdk-utils';

import { caip2Reference } from '../../core/config/grpc.js';
import type { ListedSignerKeyStatus } from '../../core/keys/listSignerKeys.js';
import { listVisibleSignerInventoryKeys } from '../../core/modules/keyVisibility.js';
import {
  aggregateAccountSigningStatus,
  aggregateSignerBackendStatus,
  getSignerBackendStatus,
  type AccountSigningStatus,
} from '../../core/modules/status.js';

/** Signer account key metadata exposed by signer account discovery. */
export interface SignerAccountKeyDto {
  scheme: PublicKeyScheme;
  publicKey: string;
  status: ListedSignerKeyStatus;
}

/** Account with at least one on-chain credential key known to this signer. */
export interface SignerAccountDto {
  address: string;
  label?: string;
  signingStatus: AccountSigningStatus;
  publicKeys: string[];
  keys: SignerAccountKeyDto[];
}

/** Network-independent domain result wrapped by the shared resource family. */
export interface AccountsResourceResult extends Record<string, unknown> {
  accounts: SignerAccountDto[];
}

/** Builds the signer-capable account domain result for an already resolved network. */
export function formatAccountsResource(
  network: { caip2: string },
): AccountsResourceResult {
  const ref = caip2Reference(network.caip2);
  const accountLabels = loadAccountLabels(ref);
  const visibleKeys = new Map(
    listVisibleSignerInventoryKeys().map((key) => [
      key.publicKey,
      {
        publicKey: key.publicKey,
        scheme: key.entry.scheme,
        status: aggregateSignerBackendStatus(
          key.backends.map((backend) => getSignerBackendStatus(backend, key.entry.scheme)),
        ),
      } satisfies SignerAccountKeyDto,
    ]),
  );
  const merged = new Map<string, SignerAccountDto>();

  for (const [address, observation] of Object.entries(loadAccountCredentials(ref))) {
    const keys = Object.values(observation.credentials)
      .flatMap((credential) => Object.values(credential.keys).map((key) => key.publicKey))
      .flatMap((publicKey): SignerAccountKeyDto[] => {
        const visibleKey = visibleKeys.get(publicKey);
        return visibleKey === undefined ? [] : [visibleKey];
      });
    if (keys.length === 0) continue;
    const existing = merged.get(address);
    const mergedKeys = dedupeKeys([...(existing?.keys ?? []), ...keys]);
    merged.set(address, {
      address,
      label: findAccountLabelInMap(address, accountLabels),
      keys: mergedKeys,
      publicKeys: mergedKeys.map((key) => key.publicKey),
      signingStatus: aggregateAccountSigningStatus(mergedKeys.map((key) => key.status)),
    });
  }

  return { accounts: [...merged.values()].sort((left, right) => left.address.localeCompare(right.address)) };
}

/** Shared default, explicit, and wildcard signer-account resource registration. */
export const accountsResourceRegistration = registerNetworkResourceFamily(
  createNetworkResourceAdapter(),
  {
    name: 'signer-accounts',
    path: 'accounts',
    title: 'Concordium Signer Accounts',
    description: 'Accounts this signer can sign for on the selected network.',
    read: async ({ network }) => formatAccountsResource(network) as unknown as McpJsonValue,
  },
);

function dedupeKeys(keys: SignerAccountKeyDto[]): SignerAccountKeyDto[] {
  const byPublicKey = new Map<string, SignerAccountKeyDto>();
  for (const key of keys) {
    const existing = byPublicKey.get(key.publicKey);
    byPublicKey.set(key.publicKey, existing === undefined ? key : {
      ...key,
      status: aggregateSignerBackendStatus([existing.status, key.status]),
    });
  }
  return [...byPublicKey.values()].sort((left, right) => left.publicKey.localeCompare(right.publicKey));
}
