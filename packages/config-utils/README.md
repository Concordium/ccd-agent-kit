# @ccd-agent-kit/config-utils

Shared XDG paths, network resolution, label policy, finalized public observations,
identity-context snapshots, and protected public catalogs. Applications consume this
package directly; human mutation is exposed by `ccd-config-manager`.

Config, data, and state helpers use the `ccd-agent-kit` XDG application directory.
Protected-file ancestor validation uses that directory as its application-root anchor.

Chain-client settings are owned by `chainClient.ts`. The public names are
`ChainClientConfig`, `loadChainClientConfig`, `saveChainClientConfig`,
`updateChainClientStartupRefreshConfig`, `resetChainClientConfig`, and
`getChainClientConfigPath`. The sole filename is `chain-client.json` under the
`ccd-agent-kit` config directory.

The network registry validates canonical lowercase 64-hex genesis hashes and the exact
`ccd:<first-32-hex-characters>` CAIP-2 binding on both read and write. Resolved-network
consumers may rely on that producer contract. The shared `updateNetwork` API can replace
a valid identity pair; identity-preserving endpoint updates are specifically enforced by
the `ccd-config-manager network update` CLI after a complete-genesis comparison.

Configured network names are trimmed through the shared catalog-label normalizer and must
match `[A-Za-z][A-Za-z0-9_-]{0,48}`. No prefix is reserved, so `ccdDev` is valid; a full
`ccd:<reference>` is not a name. Resolver inputs are selectors rather than names and accept
a configured name, a 32-hex CAIP-2 reference, or a full CAIP-2 identifier. The
name grammar is therefore applied to registry writes and name-based label queries, not to
CAIP-capable selector resolution.

Finalized account-credential storage validates SDK-valid account addresses and canonical
decimal credential indexes `0..255` on read and write. Valid address aliases are accepted
and matchable; successful refresh writers may replace equivalent aliases with
the node-canonical address.

It also owns protected persistence and read-only runtime access for independent signer
and identity-manager version-1 module policies at `signer/config.json` and
`id-manager/config.json` beneath the XDG config root. Consumer runtimes read and enforce
policy directly; only `ccd-config-manager` invokes policy mutation. They do not watch policy
files, while on-demand reads load current persisted policy. There is no live policy-mutation
channel.

Config exports signer-instance discovery and authenticated request clients built with
MCP-utils' generic instance-client factory. `listIdentityManagerInstances()` uses that
factory for the separate `id-manager` namespace and returns
`McpInstanceRegistryEntry<{instanceId: string}>[]` with public `pid`, `parentPid`, `startedAt`,
`lastSeenAt`, and `network` metadata when present. Listing prunes stale/dead entries and
does not issue an IPC request or expose auth tokens, sockets, paths, secrets, or working
directories. It also exports
`notifyMcpInstancesConfigChanged(targets: readonly McpConfigRefreshTarget[]): Promise<void>`,
where targets are `'signer' | 'idManager'`. The helper uses minimal `{instanceId}` status parsing for
refresh delivery, while signer listing and lock control retain their separate strict public
status parser. It maps targets to the `signer` and `id-manager` namespaces and sends
`inventory-refresh` and `sources-refresh`, respectively. Missing instances and delivery
failures are best effort. Config does not own either control server, request authorization,
or runtime software lock/source state.

## Catalog Boundary

The shared label module owns validation, ASCII case-insensitive matching and collision
checks, target uniqueness, hard/soft protection, mutation-mode resolution, and bare-label
output. Catalog owners provide target equivalence, network scope, and persistence. Stored
spelling is retained without a persisted folded key. Native IDs, addresses, public keys,
source IDs, and provider indexes retain domain semantics; YubiKey device names are excluded.
Config-utils owns the canonical identity-source ID pattern `^ir:[a-z2-7]{15}$` for reuse by
identity-manager CLI, MCP, records, and reservations. Its colon makes the native namespace
disjoint from label grammar: a bare 15-character payload is a label, not a source ID, so each
explicit selector has exactly one interpretation.

This package is the schema, validation, and persistence owner for:

- `signer/inventory.json`, the centralized public signing-key catalog;
- `id-manager/sources.json`, the public identity-root catalog with ordered backends
  and device locations; and
- root `yubikeys.json`, the version-1 device-registry schema.

It also owns network-scoped contract-instance labels: authoritative data files are
`contract-instance-labels/<caip2Ref>.json`, and the derived version-1 state index is
`contract-instance-labels.json` with `networks[caip2Ref].labels`. Each network permits one
label per canonical address and one case-insensitive use of each bare label across hard and soft forms;
collision guards preserve both files.

Network-scoped account labels use authoritative `account-labels/<caip2Ref>.json` maps and
the derived `account-labels.json` state index with `networks[caip2Ref].labels`. Exported
types and functions use `AccountLabel`/`AccountLabels` terminology, including path,
load/save/index, lookup, scope, validation, and address-list APIs.

It also supplies the protected encrypted-file storage primitive and backend formats using shared
PIV types. Private software key storage is signer-owned. There is no software identity-root
backend, daemon, hardware IPC side channel, generic notification
bus, or catalog update lock. The narrowly scoped authenticated runtime refresh clients are
not a catalog lock or watcher. Catalog mutation uses atomic replacement.
`generateLocalEd25519Key` creates a cryptographic seed, writes it directly through encrypted-file
storage, clears its owned seed buffer best-effort, and returns only
`{publicKey, keyRef}`.
`checkEncryptedFileIntegrity({fix})` reports references, invalid files, and adoptable orphans;
repair only prunes missing references. After unlock, `adoptEncryptedFileKey({publicKey, label?})`
verifies one canonical managed file and catalogs it without rewriting private material.
The config CLI orchestrates import/storage through shared protected-storage
and PIV primitives; this public catalog package is not a secret store.
Its operator-facing trees are named `signing-key` and `identity-root`. Shared YubiKey
defaults represent PIN-once/touch-never policy with global and per-device precedence and
signing-only slot selection.

Catalog ordering requires every existing identity exactly once. Signing location reorder input is a
union keyed by `signingModule`, with `SoftwareSignerBackend[]` for `software-signer` and
`PivDeviceLocator[]` for `yubikey-piv`; persisted backend payloads remain `unknown`, and
`SoftwareSignerBackend.storageModule` remains an extensible string. Signing forget is
`forgetSignerInventoryKeyLocation(publicKey, target)`, where required `target` is `'all'` or a
backend-discriminated concrete `SoftwareSignerBackend`/`PivDeviceLocator` location.
`IdentitySourceRegistry` exposes only `forgetLocation(source, target)`, where required `target` is
`'all'` or `{backend: 'yubikey-piv', location: {serial: string}}`. Neither API has a backend-wide
variant or identity `forget` alias. Concrete targets retain membership and malformed/duplicate
stored-location guards; empty backends and records are pruned, and a removed identity root clears
its matching default. Forgetting changes metadata only.

See [architecture](../../docs/architecture.md) and
[security](../../docs/security.md).
