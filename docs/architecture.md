# Architecture

## Purpose

This monorepo contains four public CCD tools, one public asset-only skills package, and
shared libraries. Public tools are
separate package boundaries and never import one
another. This document is canonical for package boundaries, trust, persisted protocols,
and cross-package contracts. Package READMEs, exported types and TSDoc, executable
schemas, and `--help` define callable details.

## Package boundaries

| Package                             | Responsibility                                                                                                                                                                    |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@ccd-agent-kit/ccd-signer`         | Inspect, sign, and finalize locally through independently enabled account-signing backends.                                                                                       |
| `@ccd-agent-kit/ccd-chain-client`   | Query nodes; build, verify, finalize, and explicitly submit public artifacts.                                                                                                     |
| `@ccd-agent-kit/ccd-config-manager` | Sole human CLI for shared configuration, catalogs, labels, consumer module policy, MCP-instance refresh clients, and signing-key, identity-root, and device management.           |
| `@ccd-agent-kit/ccd-id-manager`     | Identity derivation, issuance/recovery, proofs, encrypted storage, and account-opening preparation.                                                                               |
| `@ccd-agent-kit/ccd-skills`         | Asset-only distribution of the seven MCP-served skills for harnesses without MCP Skills extension support.                                                                        |
| `@ccd-agent-kit/config-utils`       | XDG paths, protected public catalogs and storage primitives, network resolution, shared label policy, public observations, identity-context snapshots, and MCP-instance clients.  |
| `@ccd-agent-kit/sdk-utils`          | Stateless SDK-adjacent validation, codecs, account comparison, transaction bytes, and cryptographic public-data helpers.                                                          |
| `@ccd-agent-kit/cli-utils`          | Generic CLI validation, terminal input, executable launching, and shared Commander status mapping; output and domain rendering are adapter-owned.                                 |
| `@ccd-agent-kit/mcp-utils`          | JSON-safe MCP structures, canonical JSON-file serialization, network-scoped resource routing/aggregation, subscription state, and generic authenticated local-instance lifecycle. |
| `@ccd-agent-kit/mcp-skills`         | Private shared loader for the shared MCP skill catalog and Markdown assets.                                                                                                       |
| `@ccd-agent-kit/piv-utils`          | Neutral PC/SC transport, scoped PIV sessions, authentication, and codecs.                                                                                                         |

Dependencies point inward to shared libraries. In particular, config-utils imports SDK-utils,
PIV-utils, and MCP-utils; config-manager imports config-utils, PIV-utils, SDK-utils, and
CLI-utils; signer and identity manager import the shared packages they need; chain client imports config-utils,
SDK-utils, CLI-utils, MCP-utils, and MCP-skills. Shared packages do not import public tools, and
domain modules do not import through their own package entry point.

Public application identities are explicit and do not derive one identifier from another:

| Source directory              | Nx `projectName` / `nx.name` | npm `name`                          | Binaries                               |
| ----------------------------- | ---------------------------- | ----------------------------------- | -------------------------------------- |
| `packages/ccd-signer`         | `ccd-signer`                 | `@ccd-agent-kit/ccd-signer`         | `ccd-signer`, `ccd-signer-mcp`         |
| `packages/ccd-chain-client`   | `ccd-chain-client`           | `@ccd-agent-kit/ccd-chain-client`   | `ccd-chain-client-mcp`                 |
| `packages/ccd-config-manager` | `ccd-config-manager`         | `@ccd-agent-kit/ccd-config-manager` | `ccd-config-manager`                   |
| `packages/ccd-id-manager`     | `ccd-id-manager`             | `@ccd-agent-kit/ccd-id-manager`     | `ccd-id-manager`, `ccd-id-manager-mcp` |
| `packages/ccd-skills`         | `ccd-skills`                 | `@ccd-agent-kit/ccd-skills`         | none                                   |

Each public package directory basename matches its unscoped npm name. Each public source manifest
declares its unscoped Nx identity explicitly as `nx.name`; changing a directory or npm name must
not rename projects, alter existing tags, or change executable names. The config-manager entrypoint
remains `src/bin/ccd-config-manager.ts`, and chain client's only entrypoint remains
`src/bin/ccd-chain-client-mcp.ts`.

Advertised MCP server names are `ccd-chain-client`, `ccd-signer`, and `ccd-id-manager`.
The chain client's `-mcp` suffix identifies only the protocol binary used by a host or
harness. MCP tool/resource names, `CCD_*` environment variables, IPC domain namespaces,
request names, and status shapes are defined by their owning package and executable contracts.

Both public and private packages use the `@ccd-agent-kit/*` scope; scope is therefore not a
publication classifier. Release and packaging code classifies a workspace package from its
explicit private flag and workspace/project identity. For example, the private config package
identities are `packages/config-utils`, `@ccd-agent-kit/config-utils`, and Nx project
`libs/config-utils`. Public tools use the scoped npm names listed above while Nx projects,
binaries, servers, protocols, environment variables, and domains use their `ccd-*` identities.
There are no alternate package, skill, or executable aliases.

### Skill assets and catalogs

The seven skills have these exact identifiers, with no aliases:

- `ccd-transfer`;
- `ccd-plt-transfer`;
- `ccd-sponsored-multisig-transaction`;
- `ccd-account-label-discovery`;
- `ccd-signer-key-discovery`;
- `ccd-identity-management`; and
- `ccd-network-discovery`.

Each MCP server owns its source assets beneath
`packages/ccd-<owner>/src/mcp/skills/assets/<owner>/`: `chain-client`, `signer`, or `id-manager`.
The shared network skill is beneath `packages/mcp-skills/src/assets/shared/`. Every asset root
contains a `catalog.json` array of Markdown filenames, the catalogued Markdown files, and a
`project.json` defining the asset-only Nx project `skills/chain-client`, `skills/signer`,
`skills/id-manager`, or `skills/shared`. These asset projects have no package manifest or
independent version. Each Markdown filename is `<skill-name>.md`, and its frontmatter name
matches that stem. The JSON catalogs and Markdown are the source of truth.

Server catalog TypeScript stays outside the asset roots. It reads its source `catalog.json` and
the listed Markdown files, so adding a valid catalog entry automatically exposes that skill
through standard resource discovery and the MCP Skills extension. The private
`@ccd-agent-kit/mcp-skills` library reads the shared catalog in the same way. There is no second
hard-coded skill-name catalog or alias path.

Server distributions preserve runtime asset lookup behavior by
copying each owned asset directory, including `catalog.json` and Markdown, beside the bundled
binary in the corresponding asset-folder layout. Each server project has an Nx implicit
dependency on its own asset project; `libs/mcp-skills` has its asset dependency on `skills/shared`.
Changing server code does not affect `ccd-skills`, while changing any of the four source asset
projects does.

The public `ccd-skills` project has explicit Nx implicit dependencies only on those four asset
projects. Its builder discovers source catalogs with Node filesystem `globSync` over
`packages/*/src/**/assets/*/catalog.json`; it does not import compiled servers or native code.
For every catalog entry it emits `dist/skills/<skill-name>/SKILL.md`. Duplicate skill names with
identical Markdown are deduplicated; duplicate names with different Markdown fail the build.
One focused test asserts that the built package contains exactly the expected seven skills. Manual
design verification uses Nx affected `--files` checks to prove that server-code-only changes do
not affect `ccd-skills` and asset changes do; cache hits alone are not evidence. Release dry-run
behavior is also checked manually. These checks add no CI jobs.

### Public package distribution

The four public tools and the asset-only skills package are independently versioned stable npm
packages. Every package version matches its unscoped Nx project release, project tag
`{projectName}/v{version}`, tarball, and checksum. Source manifests remain at `0.0.0` as Nx's disk
fallback; Conventional Commit intent and the affected project graph derive release versions.
Versions must not be forced by editing manifests.

The release artifact for each project is `<projectName>-<version>.tgz` with a lowercase SHA-256
sidecar. Public source and staged manifests declare public npm access. Tool tarballs contain the
manifest, compiled output, package README, and root Apache-2.0 `LICENSE`; private workspace
libraries are bundled and tree-shaken, while used third-party dependencies remain external. Public
tools neither bundle nor import one another. Runtime assets come from current source trees and are
copied beside the binaries in their consumed layout; staging has no stale build-output fallback.

The `ccd-skills` tarball contains only its minimal public manifest, README, LICENSE, and
`skills/**`. It has no binary, runtime dependency, native code, or install hook. It distributes
workflow guidance for harnesses without MCP Skills extension support and does not replace the MCP
tools and resources those workflows require.

Automatic release accepts only `main`. It asks Nx to calculate and apply independent versions in
the CI workspace without committing manifest changes, builds and stages each selected public
project, runs `npm pack`, and computes the checksum. Nx then creates project tags and GitHub
Releases, after which the release script uploads the tarball and checksum. Missing artifacts,
mapping mismatches, or upload failures fail the job. Artifact mapping and staging are keyed by the
unscoped `projectName`; validation binds each selected project to its scoped npm manifest name.
Dry-run performs version calculation only.

The root `release-channels.json` is the release branch allowlist and channel configuration:

```json
{
  "main": {
    "preid": null,
    "npmTag": "latest"
  }
}
```

An unlisted branch exits before version calculation, build, release creation, or upload. `main` is
the stable channel and `latest` is the npm dist-tag used only by manual publication. The workflow
branch allowlist and channel file must remain synchronized. Pull requests cannot release; pushes to
`main` release only after full verification succeeds.

Automatic release never publishes to npm. Manual npm publication is a distinct `workflow_dispatch`
operation from `main` that targets one existing project release, verifies its checksum and package
identity/version, and publishes that exact tarball without rebuilding or repacking. It uses npm
trusted publishing through GitHub OIDC, is gated by the protected `npm` environment, and has no
`NPM_TOKEN` input or fallback. The environment must allow only `main`, disallow administrator bypass,
require approval from an authorized release owner other than the initiator, and prevent self-review.
The reviewer verifies the selected project tag, release, tarball, and checksum before approval.
Each public package requires its own npm trusted-publisher registration; operational setup is defined
only in the [release guide](release.md#manual-npm-publication).

Changes to `main` are collaborator pull requests with rebase-only linear history, one approval,
stale-approval dismissal, resolved review threads, successful required verification, and no force
push, branch deletion, or bypass. Required checks are repository verification plus CodeQL code
scanning results, blocking High/Critical security alerts and Error-level code-quality alerts. Pull-request workflows
use read-only permissions and no publishing OIDC; CodeQL receives only its scoped
`security-events: write` permission. Pull-request code does not run through `pull_request_target`.
OIDC is reserved for the manual npm workflow. Repository Actions default to read-only permissions;
secret scanning with push protection and Dependabot updates are enabled.

Each owner validates genuinely untrusted CLI, MCP, file, node, device, or protocol input
and emits structured errors. Consumers may rely on documented producer guarantees, but
`unknown`, ordinary strings, and records are not trusted merely because they crossed a
module boundary. Persistence readers retain consistency checks unless validated
construction makes the invariant explicit.

### Security and custody

- Signer is the only runtime allowed to use account-signing private material, including
  credential-deployment keys. Config may handle imported material transiently during an
  explicit provisioning/import operation through shared protected-storage/PIV primitives;
  it does not sign or own runtime private storage.
- Identity manager owns identity secrets, P-256 slot-`9d` root trust, ECDH, and identity
  derivation. It accepts an indexed set of external Ed25519 public keys plus a credential
  threshold and emits an account-opening handoff; it never derives account-signing keys,
  signs, or submits.
- Chain MCP never holds private keys, signs, or reads signer-managed files.
- Config owns catalog schemas and protected software-storage primitives; PIV owns hardware
  mechanics; domain runtimes own authorization and enabled-module enforcement.
- MCP output never exposes private keys, PINs, passwords, wallet paths, protected local
  paths, hardware locators, socket/token material, or raw native errors.

## Configuration and data ownership

Shared state uses XDG roots below `ccd-agent-kit`: configuration for networks, providers, and
module policy; data for labels, catalogs, and domain-owned private stores; state for public
observations, identity context, and local runtime metadata. Protected paths reject unsafe
permissions and symlinks. Local CLI diagnostics may show paths; MCP output may not.

The application directory is `ccd-agent-kit` under config, data, state, and runtime roots.
Implementations read and write only this application directory.
Protected-file ancestor validation anchors permission enforcement at the `ccd-agent-kit`
application directory before the protected `signer` or `id-manager` namespace. MCP-utils'
runtime `getRegistryDir` constructs
`$XDG_RUNTIME_DIR/ccd-agent-kit/<namespace>/instances`; when `XDG_RUNTIME_DIR` is absent it
uses `<getStateDir()>/runtime/<namespace>/instances`, where the state helper already includes
the application directory. Config-utils consumes MCP-utils' generic instance client;
MCP-utils does not import config-utils.

### Shared CLI policy

Adapters translate CLI input into typed operational requests; domain handlers do not accept help
requests. The config-manager, signer, and identity-manager adapters expose help only through `-h` and
`--help`; help does not execute actions or perform prompts, registry access, native loading, or
network access. `@ccd-agent-kit/cli-utils` owns the shared policy for suppressing generated help
subcommands and classifying framework statuses. Each executable adapter still owns parsing and
usage output, buffered output, and domain-error rendering. Help succeeds, usage failures use status
`2`, and action-selected domain statuses remain intact.

### Object-first configuration CLI

`ccd-config-manager` exposes one object-first tree without command or selector aliases. Use the
[config-manager README](../packages/ccd-config-manager/README.md#cli-commands) and
`ccd-config-manager --help` for syntax and options; this document defines boundaries instead.

Config-manager owns material provisioning, import, adoption, and public catalog metadata; it never
signs. Runtime signing remains solely signer-owned. Service-policy operations manage persisted
consumer enablement, while shared device and PIN operations manage PIV hardware state; neither
substitutes for a consumer runtime's authorization and readiness checks.

Operator provisioning selectors and persisted identifiers are separate architectural identities.
Software and PIV selectors choose a provisioning backend; catalogs retain their backend IDs, while
software stores retain independent storage IDs. No backend-to-storage mapping is implied.

Software key generation uses cryptographically secure randomness and writes only to encrypted-file
storage. Private bytes pass directly to protected storage without an intermediate key file, and only
public material is cataloged or emitted. Passwords remain transient; owned seeds are cleared without
claiming complete zeroization.

Unsupported storage-module identifiers remain inert catalog metadata and cannot load private
material or sign.

### Catalog mutation invariants

Backend and location reordering accepts only an exact, duplicate-free permutation of existing
entries. Location requests are backend-discriminated and use concrete built-in location types; they
never add, drop, deduplicate, rewrite, or strip persisted fields. Signing-key and identity-root
schemas and runtime fallback behavior remain unchanged.

Persisted signing backend payloads remain intentionally `unknown` at the extensible catalog
boundary. Built-in mutation validates them through typed parsers; software storage-module IDs remain
strings rather than a closed list. Unknown signing backends remain readable and preserved and may
participate in backend ordering, but do not gain location mutation support.

Forget always requires either the whole-record target or one backend-discriminated concrete
location; there is no backend-wide target. It validates concrete membership and malformed or
duplicate stored locations before mutation, then prunes empty backends and records. Removing an
identity root also clears its matching default. All forget operations change public catalog metadata
only; they never delete private material, hardware keys, or identity objects.

### Networks and invocation defaults

The network registry validates lowercase 64-hex genesis hashes and the exact
`ccd:<first-32-hex-characters>` CAIP-2 binding on read and write. Configured network names
are trimmed and use the shared catalog-label grammar: 1–49 ASCII characters, an ASCII
letter first, then ASCII letters, digits, `_`, or `-`. There is no reserved network-name
prefix; for example, `ccdDev` is a valid name, while `ccd:...` is not a name because `:` is
outside the grammar. The config owner normalizes names for writes and name-based label
queries. It does not apply the name grammar to network selectors, which continue to accept
configured names, 32-hex CAIP-2 references, or full `ccd:<reference>` identifiers. Shared
precedence is explicit selector, `CCD_NETWORK`, persisted default, then built-in mainnet
where that fallback applies. CAIP-2 identifies configuration/storage; only verified
official-mainnet genesis selects SDK `Mainnet`. Every other verified genesis selects SDK
`Testnet`.

`ccd-id-manager` and `ccd-signer` each declare `--network <network>` once as a root/global
CLI option rather than repeating it on command groups or leaf commands. Commander accepts
the option before or after a command; identity-manager also accepts it between the `idp`,
`identity`, or `account` group and its leaf command. Child help displays the inherited global
option. Parsing the option does not resolve or validate it globally: help remains lazy and
performs no network I/O, and only network-dependent action handlers resolve the selector.
Identity-manager retains explicit selector, `CCD_NETWORK`, then configured-default
precedence. Signer's existing network-dependent `sign` and `sign-message` request factories
receive the inherited option and retain their current default behavior. Its `describe`,
`finalize`, and `list-keys` commands intentionally ignore the option, including an unknown
selector. This is one shared Commander option per executable, not a new command,
compatibility branch, or shared wrapper.

`ccd-config-manager network add` and `network update` reject empty or whitespace-only gRPC hosts.
Update treats only an absent (`undefined`) option as omitted. `network update` changes
endpoint fields only after comparing the node's full genesis hash with the configured
identity. The lower-level registry API validates each identity pair but does not promise
update immutability.

Chain MCP captures its default network and `CCD_GRPC_ENDPOINT`, `CCD_GRPC_TLS`, and timeout
overrides at startup. Omitted request selectors use that captured default. Clients are
cached by resolved network name without TTL; explicit non-default networks use registry
host/port/TLS and the configured timeout. Restart to observe changed cached defaults or
endpoints.

Config-utils owns these settings in `chainClient.ts`. Exported names are
`ChainClientConfig`, `loadChainClientConfig`, `saveChainClientConfig`,
`updateChainClientStartupRefreshConfig`, `resetChainClientConfig`, and
`getChainClientConfigPath`. Config-manager owns the `service chain-client` command group in
`chainClientCommand.ts`, including `ChainClientCommandRequest` and
`runChainClientCommand`; it does not register an `mcp-server` command alias.

### Current persisted paths

| Data                     | Current path below its XDG root                                                                                    | Owner                                                |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------- |
| Signer module policy     | config `ccd-agent-kit/signer/config.json`                                                                          | config persistence; signer enforces                  |
| Identity backend policy  | config `ccd-agent-kit/id-manager/config.json`                                                                      | config persistence; identity manager enforces        |
| Chain startup policy     | config `ccd-agent-kit/chain-client.json`                                                                           | config persistence; chain client consumes            |
| Signing-key catalog      | data `ccd-agent-kit/signer/inventory.json`                                                                         | config schema/persistence; signer consumes           |
| Identity-root catalog    | data `ccd-agent-kit/id-manager/sources.json`                                                                       | config schema/persistence; identity manager consumes |
| YubiKey registry         | data `ccd-agent-kit/yubikeys.json`                                                                                 | config schema/persistence                            |
| Account labels           | data `ccd-agent-kit/account-labels/<caip2Ref>.json`; state `ccd-agent-kit/account-labels.json`                     | config schema/persistence; chain MCP consumes        |
| Contract-instance labels | data `ccd-agent-kit/contract-instance-labels/<caip2Ref>.json`; state `ccd-agent-kit/contract-instance-labels.json` | config schema/persistence; chain MCP consumes        |
| Identity network store   | data `ccd-agent-kit/id-manager/<canonical-network>/`                                                               | identity manager                                     |
| Local MCP instances      | runtime `ccd-agent-kit/<namespace>/instances`, or state `ccd-agent-kit/runtime/<namespace>/instances`              | MCP-utils mechanics; domain runtime authority        |

`ccd-agent-kit/chain-client.json` is the sole chain-client settings path. The settings schema
and exported config APIs are defined in `packages/config-utils/src/chainClient.ts`.

Catalog updates use atomic replacement but no cross-process catalog update lock. The
YubiKey registry is version 1 with `updatedAt` and a `devices` map keyed by name; each
entry contains decimal `serial`, `registeredAt`, and `updatedAt`. Exact schemas and
callable mutation APIs live with `@ccd-agent-kit/config-utils`.

### JSON file serialization

`@ccd-agent-kit/mcp-utils` exports `serializeJsonFile(value: unknown): string` as the single
serialization implementation for repository-owned JSON file writes. It applies
`JSON.stringify(value, null, 2)` and appends exactly one trailing newline. If JSON
serialization returns `undefined` for an unserializable root value (`undefined`, a function,
or a symbol), it throws `TypeError` before any writer opens or changes its destination.
Native circular-reference and `bigint` serialization errors propagate unchanged; this
helper performs no bigint conversion.

All JSON persistence writers use this serializer, including config-utils' ordinary JSON
writer and protected atomic writer, MCP instance registry entries, identity-provider
registry replacement, and identity workflow reservation/index/credential, encrypted-
envelope, and bootstrap writes. Existing pretty-printed writers migrate as well as compact
writers. The serializer owns bytes only: callers retain their existing directory validation,
permissions, exclusive creation, locking, temporary-file cleanup, rollback, and atomic
rename behavior. Locating the helper in MCP-utils preserves the inward dependency graph:
config-utils and identity manager already depend on MCP-utils, and MCP-utils has no reverse
dependency on them or on a public tool.

This file contract does not apply to HTTP, MCP, CLI, socket, GitHub Actions matrix, hashing,
canonicalization, or encryption-plaintext serialization, nor to deliberately malformed test
fixtures. Those serializers retain their protocol- or test-specific byte contracts.

Finalized account-credential observations are network-scoped public chain cache, separate
from per-network account/contract-instance labels and signing inventory. Storage validates
SDK-valid addresses and canonical decimal credential indexes `0..255` on read and write.
It accepts valid aliases; refresh
writes the node-canonical address, removes equivalent aliases, records `last_final`
provenance, and preserves prior data on failure.

### Labels and catalogs

`@ccd-agent-kit/config-utils` owns the shared label-policy module. It performs input trimming and
grammar validation (`[A-Za-z][A-Za-z0-9_-]{0,48}`), stored-marker decoding, ASCII-only
case-insensitive comparison, selection, collision and target-uniqueness checks, hard/soft
protection, mutation-mode resolution, and canonical bare-label output. Catalog owners
supply namespace and network scope, native target equivalence, and persistence. Stored
spelling is retained; no folded comparison key or index is persisted.

Signing-key, identity-root, identity-object, identity-provider, account, and
contract-instance namespaces are separate. Account, contract-instance, identity-object,
and identity-provider labels are network-scoped. Labels are metadata, never native IDs,
addresses, public keys, source IDs, provider indexes, or authorization identity; those
values retain their exact domain semantics. Network names reuse the grammar but are not
labels and are registry-owned. YubiKey device names are entirely outside label policy,
including its grammar, mode, comparison, and storage encoding.
Identity-root/source IDs use the disjoint native grammar `^ir:[a-z2-7]{15}$`. Config-utils owns
that canonical pattern, and identity-manager CLI, MCP, record, and reservation validation
reuse it. Because `:` is excluded from label grammar, a bare 15-character source payload is
a valid label, not a native ID, and cannot overlap the native namespace.
Genuine native network/provider names, token metadata, contract module/entrypoint names,
YubiKey device names, protocol field names, filesystem entry names, and JavaScript `Error.name`
use their domain terminology.

Typed signing-key catalog requests carry one required selector string, parsed first as a 64-hex
public key and otherwise normalized as a bare label for case-insensitive lookup, with no escape or
fallback syntax.

A stored bare label is operator-protected **hard**; stored `@label` is agent-modifiable
**soft**. The marker is persistence-only: user input and output are bare, and marker-prefixed
input is rejected. An operator set creates a hard label by default. For an existing label,
omitted mode preserves its mode, explicit mode converts it, and omitted label text preserves
its stored spelling. A new set without label text is invalid. CLI removal is explicit.
All MCP label tools require exactly one action: `label` to set, or `remove: true` to remove.
The shared action schema rejects both, neither, and `remove: false`.

Soft-only MCP callers may mutate only soft labels. They cannot replace, remove, convert, or
recase a hard label; an identical hard-label request may only return the canonical
result. Protected mutations raise `CatalogLabelError` with code `LABEL_PROTECTED`. Signer MCP
is soft-only for signing keys, identity-manager MCP for identity roots and identity objects,
and chain MCP for network-scoped accounts and contract instances. Config CLI has full policy
for shared catalogs; identity-manager CLI has full policy for its identity and provider stores.
Config provisioning paths delegate label checks to the same policy. Domain-specific multi-key
label generation is followed by shared validation and collision checks.

Contract-instance data files are authoritative per-network maps from stored labels to
canonical unsigned-decimal `{index, subindex}` addresses. The derived version-1 state index
uses `networks[caip2Ref].labels`. Within a network, labels are unique under ASCII
case-insensitive comparison across hard and soft forms, and each address has at most one
label. Validation and collision guards run
before either file changes, preserving both stores on failure.

Account data files are maps from stored labels to addresses. The derived version-1 state
index uses `networks[caip2Ref].labels`. MCP catalogs use `ccd://account-labels`,
`ccd://{configuredName|bareCaip2Ref}/account-labels`, and `ccd://*/account-labels`; catalog payloads use
`labels` with rows shaped as `{label, address}`. The account-discovery skill identifier is
`ccd-account-label-discovery`.

The label terminology is uniform through account persistence, internal models, exported
config APIs, CLI text, transaction annotations, and signer results. Exported account
catalog symbols are `AccountLabelMap`, `AccountLabel`, `ACCOUNT_LABEL_PATTERN`,
`AccountLabelsIndexNetwork`, `AccountLabelsIndex`, `AccountLabelScopeMatch`,
`ResolvedAccountLabel`, and `SetAccountLabelInput`. Public operations are
`getAccountLabelsPath`, `getAccountLabelsPathForNetwork`, `loadAccountLabelsIndex`,
`saveAccountLabelsIndex`, `rebuildAccountLabelsIndex`, `loadAccountLabels`,
`saveAccountLabels`, `resolveAccountLabel`, `findAccountLabelForAddress`,
`findAccountLabelInMap`, `setAccountLabel`, `setSoftAccountLabel`,
`isValidAccountLabel`, `assertValidAccountLabel`, `removeAccountLabel`,
`listAccountLabelAddresses`, `findAccountLabelScopes`, and `findAddressLabelScopes`.
Scope matches contain `label`.
Annotated transaction fields are `senderAccountLabel`,
`sponsorAccountLabel`, `toAccountLabel`, and participant `accountLabel`. Managed
transaction-signing results and `sign_message` expose optional `label`, never `name`.

The signing catalog validates canonical `ed25519:<64 lowercase hex>` references, stored
labels, entries, and backend envelopes, then enforces shared label uniqueness. It preserves
unknown version-1 envelope fields, order, timestamps as strings, and module-owned
`backend` payloads as `unknown`. Unknown modules and payloads are the plugin boundary;
built-in consumers and location mutations use config-owned typed parsers. Catalogs contain
public keys, labels, module references, and backend locators, never passwords, PINs,
absolute key paths, private keys, or durable account-to-key bindings.

### Consumer module policy

`ccd-config-manager` is the only management surface for persisted module policy. Signer module
IDs and service-module CLI selectors are `software-signer` and `yubikey-piv`; identity manager
supports `yubikey-piv`. No module-selector aliases are accepted. Policy files are independent,
version 1, and protected. List/inspect reads persisted enablement only: it does not load
keys, enumerate hardware, activate modules, or imply readiness. Runtimes read and enforce
their own policy, but do not watch policy files. On-demand service reads still load current
persisted configuration; this is not a frozen startup snapshot. After a successful covered
CLI mutation, config sends a best-effort authenticated refresh to active affected runtimes
as defined under local MCP instance control. Signer software lock state is process-local
authorization, not module policy.

ID manager exposes `skill://ccd-identity-management/SKILL.md` through standard
resource discovery and the MCP Skills extension. Its local skill covers identity readiness,
authorized issuance/recovery, bounded discovery, account preparation and reconciliation, and
authorized proof creation. Signing and submission are separate server responsibilities.
Workflow skills are host-neutral: authorization can come from the current task or established
policy with authority for the operation. An agent verifies that scope before issuance,
recovery, disclosure, proof creation, signing, or broadcast; the contract does not require a
repeated human prompt when sufficient authority is already established.

Identity inventory follows the shared network-scoped MCP resource contract below. Identity
sources are global; identity objects and identity providers are network-scoped.

## MCP resource model

### Network-scoped families

Every resource whose value depends on a Concordium network has one domain definition: a
relative path, registration metadata, domain reader, and optional `subscribable` flag.
MCP-utils combines it with an injected `NetworkResourceAdapter`; it does not import config.
The adapter's `list`, `resolveDefault`, and `resolve` operations synchronously read one current
configuration snapshot and return canonical `name`, full `caip2`, and opaque owner context.
Network lookup is not an asynchronous I/O boundary. Domain readers are asynchronous because
they may perform bounded node, storage, or domain-service work; shared code owns routing metadata
and errors.

`registerNetworkResourceFamily` derives routing, registration, aggregation, and completion.
`ccd://<path>` uses the request default; `ccd://{configuredName|bareCaip2Ref}/<path>` resolves
one configured network; and `ccd://*/<path>` reads every configured network.

The `*` form is a scope, not an adapter selector. Completion offers configured names and
deduplicated bare CAIP-2 references. Order is deterministic, and path parameters apply in
each network. With no configured networks, the result is `{"networks":{}}`.

Default and explicit reads return exactly `{network, caip2, result}`. Wildcards return
`{networks: {name: {network, caip2, result|error}}}` and always include every configured
network, including empty domain collections.

Each entry has exactly one of `result` or `error`; failures are isolated per network.
`NetworkResourceError` exposes `NETWORK_NOT_FOUND`, `RESOURCE_NOT_FOUND`,
`NODE_REQUEST_FAILED`, and `RESOURCE_READ_FAILED`; unknown failures map to the last code.
Public errors use safe text, and read failures are never reinterpreted as absence.

All network-dependent families use this pattern. Global resources retain their payloads and
scope; routing does not change owner-enforced mutation guards. Each domain defines a
`BoundMcpResourceDefinition` once with its name, URI, typed metadata, bound reader, and optional
list/completion callbacks. MCP-utils' `registerMcpResources` registers those definitions with
the MCP SDK, constructs URI templates, and maps shared resource errors to protocol errors. This
shared integration is why MCP-utils directly depends on `@modelcontextprotocol/server`; domain
readers and config ownership belong to their owning packages, so the dependency is
acyclic.

### Resource subscriptions

Only stdio signer and identity-manager servers advertise subscriptions. Eligible network
families set `subscribable: true`; the manager explicitly lists eligible global resources.
Unknown and ineligible URIs are rejected. Stateless HTTP is unsubscribable.

`ResourceSubscriptionManager` records the exact requested URI and its routing scope. Global
subscriptions retain only the resource registration name. Default and explicit network URIs
resolve once and pin the canonical network name and CAIP-2 until unsubscribe. A wildcard takes
one configured-network snapshot when subscribed and pins that set. Later default or registry
changes do not alter active scopes.

Domain runtimes publish semantic invalidations directly through the manager:

```ts
interface ResourceInvalidation {
  resourceName: string;
  network?: string;
}

manager.invalidate({ resourceName, network });
```

`resourceName` is the registered definition name. The canonical network name is required for
a network-scoped event. The manager matches the event against its pinned scopes and sends a best-effort
`resources/updated` notification containing the subscribed exact URI; clients then reread that
URI. Unsubscribe removes that URI, and close clears manager state. The manager holds no
filesystem observers, dependency graph, refresh queue, or registry watcher.

The only subscribable resources are global `ccd://keys` and the three identity forms
`ccd://identities`, `ccd://{configuredName|bareCaip2Ref}/identities`, and
`ccd://*/identities`. Signer publishes a key invalidation for process-local software
lock/unlock and observed device insertion/removal changes that affect key availability.
PC/SC provides no event for PIN changes made outside the process, so external PIN state is
not a promised notification source; no PIN polling or external PIN-event subsystem is
introduced. Inventory, label, and configuration changes are not subscription notification
sources. Identity manager publishes a
network-scoped invalidation when its background issuance monitor persists a terminal `issued`
or `failed` transition. Direct tool mutations, pending-state writes, sources, providers,
accounts, signer instances, networks, label catalogs, and chain-backed resources
do not publish subscription updates. Subscriptions create no file watch, registry watch, chain
stream/query/polling, expiry poller, mutation, or secret operation.

`bindResourceSubscriptions` installs schema-validated subscribe/unsubscribe handlers for the
eligible stdio servers and composes with close handling. All identity URI forms use the shared
read envelopes defined above.

## Signer

Signer consumes the shared public catalog and finalized credential observations; it never
queries chain state or submits. Wallet files are import sources, not durable account
bindings. Disabled or unregistered modules expose no keys and cannot sign. Built-in
backends are encrypted software storage and YubiKey PIV. `unlocked` means an attempt is
permitted, not guaranteed to succeed.

Inventory may contain ordered backends for one Ed25519 key. Runtime performs an initial
reconciliation, observes only hardware insertion/removal for referenced devices in enabled
backends, and caches public-slot observations until reconnect or explicit refresh. It does
not watch inventory or policy files. The authenticated signer-instance request is named
`inventory-refresh` and explicitly reconciles current inventory without being a file watcher.
Covered successful `ccd-config-manager` mutations request this refresh automatically; restart
the runtime when no active instance receives it or refreshed state is not observed.
The runtime checks the observed slot key before each signature. Mismatch is unavailable,
never silent adoption. Software private storage is signer-owned.

`ccd-config-manager` owns import, generation, adoption, forgetting, labels, defaults, integrity,
and device PIN control. Signing PIV slots are `9c` by default or explicit `9c`/`82..95`;
identity slot `9d` is outside signer policy. Generate/import catalogs the result. PIV adoption
requires exact fingerprint confirmation. Encrypted-file adoption is instead an explicit,
single-public-key operation over only the canonical managed file: password unlock followed by
decryption and expected-public-key verification authorizes cataloging, without a trust ceremony,
key-file rewrite, arbitrary path, or bulk mode. Decrypted private
bytes are cleared after the existing validated load. Forget removes catalog locations only.

Encrypted-file integrity reports healthy and missing catalog references, invalid entries, and
valid unreferenced canonical files as adoptable orphans. Repair removes only catalog references
whose canonical file is confirmed missing; it never adopts an orphan, rewrites a key file, or
changes invalid entries. Adoption remains the targeted operation above. Shared PIN-once/touch-never
defaults resolve explicit command input, per-device default, then global default.

Signer CLI describes artifacts, signs accounts/messages/credential handoffs, finalizes
offline, and lists safe public inventory. Message signing accepts exactly one of UTF-8
text or exact hex and never trims bytes. Signer MCP is stdio-only and never submits.
Executable help and package TSDoc define the callable surface.

The signer's root/global `--network` option affects only account and message signing.
Transaction description and finalization are offline artifact operations, while key listing
is global inventory; these commands neither resolve nor validate a supplied network.

Signer MCP's label-mutation surface is `label_signing_key`, with the shared explicit
set/remove action. Account resources are read-only catalog projections. Its
`sign_credential` tool accepts a credential handoff as `credDeploymentHex` plus
signature/key-selection controls and returns detached credential signatures and threshold
status.

### Encrypted software-key storage

The encrypted-file backend separates password protection from per-key encryption. Initialization
generates one random 32-byte storage key. A password-derived 32-byte key wraps that storage key,
while the storage key encrypts a fixed verifier and every stored 32-byte Ed25519 seed. The password
therefore does not directly encrypt individual key files.

All encrypted values use AES-256-GCM with a fresh random 12-byte nonce and a 16-byte authentication
tag; nonces, tags, and ciphertext are hex encoded. Password derivation uses Node `scryptSync` with a
fresh public 16-byte salt and fixed parameters `N=16384`, `r=8`, `p=1`, and a 32-byte output. A
strong password is required because an attacker with the storage-state file can attempt offline
password guesses; the salt prevents precomputation but is not secret.

The storage-state and per-key JSON formats are version 1. Readers require the exact expected
envelope fields, type markers, encodings, sizes, and fixed KDF parameters. AES-GCM currently uses no
additional authenticated data: JSON metadata is structurally validated, but the whole JSON envelope
must not be described as cryptographically authenticated. Loading also binds the relative key-file
reference to the expected public key and derives the public key from the decrypted seed to require a
match before returning private material.

Changing the password creates a fresh salt and fresh nonces, derives a new password key, and
rewraps the same storage key. It does not rewrite individual key files or rotate/revoke the storage
key. Consequently, copies of an older storage-state file remain usable with its old password when
paired with key files encrypted under that storage key.

The process keeps the unlocked storage key in memory until lock or replacement. Locking overwrites
the owned storage-key buffer before dropping its reference, and transient owned buffers are also
cleared where practical. JavaScript and runtime copies mean this is best-effort, not a guarantee of
complete secret erasure.

Recovery requires a consistent backup of both signer storage state and encrypted key files. The
descriptive locations are the signer key-storage state file `encrypted-file.json` and signer-data
references under `keys/ed25519-encrypted/`; callers must use protected path APIs rather than exposing
resolved local paths. Operational protections and limitations are summarized in
[Security](./security.md#encrypted-signer-storage).

### Transaction parsing and presentation

SDK-utils owns signing digests, public verification, and a tiny empty-map encoder because the SDK serializer rejects an empty sender.
Unsigned account `transactionHex` is a standard block item: V0 is `00 || 00 || header || payload`;
V1 is `03 || 00 || 00 || header || payload`. SDK decoding identifies the version, SDK serialization
finalizes it, and V1 bitmap bytes are signing bytes. Signing, combination, and completion
require empty maps and detached signatures; partially signed inputs are rejected without merging.
Signed block-item description, verification, and submission are supported.
Credential handoffs use `credDeploymentHex` at public object and tool boundaries.

Workspace packages that directly consume the SDK move together to
`@concordium/web-sdk` `13.0.0-alpha.2`; no package retains an alpha.1 compatibility adapter.
Signer owns inspection models and stable errors. With `@concordium/web-sdk` `13.0.0-alpha.2`,
transaction tag 27 has one `tokenUpdate` inspection summary with two variants: scoped updates
include `tokenId`, while unscoped updates do not. Scoped operations keep the SDK token operation
names. Unscoped token operation names are the SDK's `tokenTransfer`, `tokenMint`, and other
`token*` discriminants; lock operations use `lockCreate`, `lockFund`, `lockSend`, `lockCancel`, and
`lockRelease`. Known SDK operations retain an operation-local
`Map<CborAccountAddress.Type, string>` keyed by address object identity for label annotation. An
in-scope known operation with malformed CBOR/shape is an inspection error. Unknown or future
operations remain recursively validated opaque JSON for inspection; they are not reinterpreted
through another scope or parsed through the former alpha.1 operation model.

Account-label annotation visits only protocol participant paths: header sender/sponsor and
CCD transfer recipient; token transfer recipient, allow/deny target, admin account; and
unscoped lock-create recipients/simple-v0 grant account, lock-send source/recipient, and
lock-release source. It never recursively searches JSON, memos, extension fields, or opaque
operations.

Terminal formatting converts SDK-known operations once, applies account labels, rich memo
views, and established lock-field adaptation. Token metadata update input remains URL-only and
is converted directly to the SDK details object `{url}`; the MCP surface does not add a checksum
input. It removes internal wrappers/maps from structured JSON, JSON text, and human text. Opaque
operations bypass this formatter without transformation.
Human review escapes terminal controls, Unicode direction controls, and line separators
without changing structured values. Account transactions show serialized `Max energy`;
credential deployments do not invent one. Credential proofs are opaque while decoded
disclosures are exact. Credential public keys are typed `Ed25519PublicKeyHex`; the
wire-order contract is in [credential signing preimage](./credential-signing-preimage.md).

### Signature contracts

Account signatures are nested credential/key index maps; credential-deployment signatures
use a distinct flat map and preimage. Indexes are decimal `0..255`. Account signatures are
nonempty even-length hex; credential-deployment signatures are exactly 128 hex characters
and must reference a handoff key before counting. `isFullySigned` and offline
`signatureRequirements` report structural completion, not cryptographic verification.
Contextual account completion verifies exact digests and finalized credential slots.
Account roles use strict `{sender, sponsor}`; omitted roles are empty maps, while null or
unknown keys fail. Caller/backend maps are not mutated or aliased.

SDK-utils owns reusable signed-credential assembly for both handoff targets. It strictly
decodes `00 || u64_be(messageExpiry) || unsignedCredentialDeployment` and
`01 || 32-byte accountAddress || unsignedCredentialDeployment`, validates canonical and
distinct byte-sized public-key and signature indexes, rejects signatures for absent keys,
verifies every supplied Ed25519 signature over
`sha256(unsignedCredentialDeployment || targetContext)`, and requires the credential
threshold to be met. It returns an SDK `CredentialDeploymentInfo`; callers own the target-
specific envelope. Account-opening finalization requires the new-account target and wraps
the assembled normal credential with its message expiry as a credential-deployment block
item. Existing-account callers receive the assembled credential for use in their own
target-specific envelope.

## Chain client

The chain client owns node clients, public JSON-safe DTOs, resources, builders,
verification, completion, and explicit submission. It
supports local stdio and stateless Streamable HTTP; HTTP does not make workflow state an
HTTP-session contract. Builders may query nonce, protocol, schema, credentials, or
simulation; account builders return the standard unsigned block item defined above and never sign.

Contract input accepts raw parameter hex or schema-backed JSON, never both. Completion
has separate account-transaction and account-opening registrations. `complete_transaction`
accepts account transactions and role-separated signatures only; it supports direct
submission of an already signed block item, including valid non-account-transaction block
item kinds, when signatures are omitted and submission is explicitly requested.
`complete_account_opening` accepts a new-account `credDeploymentHex` handoff and flat
credential signatures, verifies and assembles them through SDK-utils, and optionally
submits the resulting credential-deployment block item. Both tools expose the applicable
`submit`, `finalize`, `returnInput`, and network controls; submission is false by default,
and `submit: true` requires finalization. Incomplete account-transaction signatures are
returned rather than broadcast. Contextual account completion submits against the network
resolved during signature combination.

### Protocol-level token updates

The chain client uses `@concordium/web-sdk` `13.0.0-alpha.2` directly, with no alpha.1
compatibility path. `build_plt` selects the SDK's scoped or unscoped `tokenUpdate` payload from
network protocol capabilities. Both serialize as account-transaction tag 27; protocol 11 does not
use a separate `metaUpdate` transaction kind. Scoped updates target one payload-level `tokenId`.
Unscoped updates carry token IDs on token operations and may include lock operations.

The existing flattened MCP operation inputs remain the public build contract, including
`controllerMemoText` and `controllerMemoJson` on lock creation. The only naming migrations are
`lock_return` to `lock_release` and the simple-v0 grant capability `return` to `release`; the old
names are rejected rather than retained as aliases. Lock creation is converted to the SDK tagged
configuration `{simpleV0: {recipients, expiry, grants, tokens, keepAlive?, memo?, metadata?}}`.
The `lock_create` input optionally accepts `metadataJson`, which must be a JSON object. Its optional
`name` and `description` fields must be strings when present; additional JSON fields are allowed,
and an empty object is retained. `SDKLockMetadata.encode` encodes that object as raw CBOR for the
last argument of `LockConfig.simpleV0`, while the creation payload summary returns the same
`metadataJson` input for review. This does not change the existing controller memo or `keepAlive`
contracts, add a raw-metadata creation input, or add alternate metadata formats. Token metadata
updates still accept only a URL, converted directly to `{url}` without a `TokenMetadataUrl` wrapper
or checksum input.

SDK lock queries return `{lock, config, funds}`. The public `LockInfoDTO` remains flattened with
its current lock identifier, creator fields, recipients, expiry, grants, token IDs, optional
keep-alive and memo fields, and funds; only grant capability `return` changes to `release`. When
lock metadata exists, the DTO also includes
`metadata: {hex: string, cbor?: McpJsonObject}`. `hex` always preserves the original raw metadata
bytes. The optional `cbor` inspection view comes from `SDKLockMetadata.decode` and uses the same
recursive JSON projection as memo and transaction-effect inspection: CBOR byte strings become
lowercase hex strings and big integers become decimal strings. If SDK decoding fails or the decoded
value cannot be represented as MCP JSON, the query returns `metadata: {hex}` rather than failing the
entire lock read. No metadata omits the field; decoded empty-object metadata remains present. This
decoded view is for inspection, not a lossless JSON round trip; `hex` is the canonical preservation
of the original bytes.

Successful `tokenUpdate` effects retain the public `tokenEvents` collection for scoped and unscoped
updates. The projection includes token events and
the SDK lock event variants `lockCreated`, `lockDestroyed`, `lockAmount`, and `unlockAmount`.
Token transfer events no longer expose `fromLock` or `toLock`; lock movement is represented by the
dedicated lock events.

Known SDK `BlockItemSummary` and block-selector values are typed through mapping; they
are not serialized to `unknown` and inferred back. Unsupported extension payloads use
explicit `JsonValue`/`JsonObject`; terminal JSON serialization is not a typed interchange
unless reparsed by an owning schema. Tools return tool-shaped results. Validated client
errors may retain safe structured fields; unknown failures use a fixed generic error.
Node failures expose a fixed public message and optional numeric code. Resources throw
resource/JSON-RPC errors and project only domain-owned public fields.

Wildcard resources use the shared per-network aggregation contract. They may perform the
same bounded domain read once for each configured network, but never sign, disclose secrets,
submit, poll, or create a streaming chain query. Chain account summary resources use the
node-canonical address with an alias-aware optional local `label`.

Contract-instance query/build tools and resources accept `addressOrLabel`; instance metadata
uses optional `label`. Catalog resources use the `contract-instance-labels` path and
`labels` projections. Chain MCP's label-mutation surface is `label_account` and
`label_contract_instance`; both set or remove soft labels only. Hard-label changes are
exclusive to `ccd-config-manager`.

The chain client does not expose WalletConnect or ID App pairing, connection, QR, disconnect,
or `create_account` request tools/resources. Account opening remains the standard handoff:
identity manager prepares `credDeploymentHex`, signer produces detached credential signatures,
and `complete_account_opening` verifies, finalizes, and optionally submits the result.
`@walletconnect/sign-client`, `qrcode`, and `@types/qrcode` are not chain-client dependencies.
Chain client packages no account-opening workflow skill; the `complete_account_opening` tool
remains available.

MCP JSON excludes `bigint`, undefined, functions, symbols, and nonfinite numbers; large
integers use decimal strings. Public artifacts are serialized hex plus detached
signatures, never signable transaction JSON. Tool descriptions distinguish reading,
building, signing, and broadcasting.

## Identity manager

`ccd-id-manager` is a public tool package. This packaging status does not make identity
objects, identity secrets, derivation material, protected provider settings, or local
identity state public; those are inside the identity-manager security boundary.
Network-scoped operations
use explicit selector, `CCD_NETWORK`, then
the configured default. They verify full node genesis and use protected provider settings
plus fresh finalized global/IDP/AR context. Provider index or shared label selection applies; only an
enabled, complete, currently inventoried provider is available to MCP context-loading.
The identity-manager CLI inherits its single root/global `--network` option through all
`idp`, `identity`, and `account` leaves; each leaf resolves it only when its action runs.

Identity objects use shared label policy within each canonical network while retaining
identity IDs and workflow/storage boundaries. Hard bare-label and soft `@label` storage is
valid; CLI input is bare and uses optional mode selection. MCP is soft-only.
New records receive an approved initial label or the soft
`@ID-<15-character-source-payload>-<idp-index>-<identity-index>` default. The default embeds
only the payload, not the native `ir:` prefix, preserving its existing human spelling; existing
labels are not rewritten. Generated labels must not become hard. `identity label set|remove` uses
shared policy; explicit removal leaves the record unlabeled without regenerating the default.
Cryptographic paths always use the canonical 64-lowercase-hex identity ID, and concurrent label
changes must survive workflow mutations.

Identity-provider settings also use shared label policy per canonical network: unmarked
stored labels are hard and `@label` values are soft. The `ccd-id-manager idp` CLI accepts
optional mode selection; a new label defaults hard, omitted
mode preserves an existing mode, and explicit mode converts it. Provider-index selection
keeps native numeric semantics, and the node-provided provider name is separate from the
local label. There is no identity-provider MCP label mutation tool.

Each provider configuration may independently store `anonymityRevokers?: number[]` and
`anonymityRevokerThreshold?: number`. Revoker values are `ArInfo.arIdentity` identifiers,
not positions in a node-returned array. A configured list is nonempty and contains unique
positive uint32 values (`1..0xffffffff`); every value must exist in the locally cached AR
inventory when configuration is written. Omitting the list means all ARs in the fresh
finalized network context at issuance. The threshold is independently optional, including
when the list is omitted. An explicit threshold is an integer from `1` through
`min(selected AR count, 255)`; an omitted threshold resolves to `selected AR count - 1`.
The value is never clamped. Consequently, one selected AR is valid only with an explicit
threshold of `1`; its default threshold of `0` is invalid. An empty finalized AR map is
always invalid for new issuance.

`ProviderPatch` uses omission to preserve either field and `null` to clear that field.
Persisted provider settings may omit these fields but must reject `null`. The CLI maps
`--ars <csv>` and `--ar-threshold <n>` to set operations and `--clear-ars` and
`--clear-ar-threshold` to independent clears. A set and clear option for the same field
conflict; changing or clearing one field leaves the other unchanged. Configuration
validates the complete merged policy atomically, so no invalid intermediate or persisted
combination is written. For example, `--ars 1,3,5 --ar-threshold 2` selects AR identities
1, 3, and 5 with threshold 2. Detailed inspection and resolved-provider results expose the
two configured optional fields only when present; they add no computed effective-policy
fields. The existing safe provider/AR inventory projection is unchanged.

### Identity derivation

Current protocol identifier: `piv-p256-hkdf-sha256-v1`. One fixed P-256 private key stays
in PIV slot `9d`; no ECDH private key exists on the host. RFC 9380 hashes this exact UTF-8
message to the context-bound peer point:

```text
ccd-id-manager/identity-seed/v1|<coin-type>|<idp-index>|<identity-index>
```

Each interpolation is exactly eight lowercase hexadecimal characters, left-padded with
zeroes. SDK `Mainnet` coin type is decimal `919` (`00000397`); SDK `Testnet` is decimal
`1` (`00000001`). Delimiters are literal, with no whitespace or newline. IDP and identity
indexes are `0..2^31-1`; eight-hex encoding does not broaden the range. Genesis,
credential number, and device serial are excluded.

The exact UTF-8 DST is
`ccd-id-manager/identity-seed/v1/P256_XMD:SHA-256_SSWU_RO_`. Perform one hash-to-curve/ECDH
operation. The uncompressed SEC1 peer point is 65 bytes. ECDH output is the fixed-width
32-byte x coordinate with leading zeroes retained; never round-trip it through a
variable-width integer or perform a second agreement for storage.

All stages use HKDF-SHA-256 with fixed public UTF-8 salt
`ccd-id-manager/hkdf/v1`:

| Stage             | IKM                       | Exact UTF-8 info                      | Output                                 |
| ----------------- | ------------------------- | ------------------------------------- | -------------------------------------- |
| SDK identity seed | 32-byte ECDH x coordinate | `ccd-id-manager/identity-sdk-seed/v1` | 64 bytes                               |
| Opaque file ID    | same 64-byte seed         | `ccd-id-manager/identity-file-id/v1`  | 32 bytes, rendered as 64 lowercase hex |
| Identity-file key | same 64-byte seed         | `ccd-id-manager/identity-file-key/v1` | 32-byte AES-256 key                    |

Every protocol string above and the AAD below is exact UTF-8 with no added NUL, newline,
or whitespace. The file ID is not a hash of linkable `idCredPub`. The 64-byte seed is
passed to the SDK with its `Network` type; paths are not manually constructed. Mainnet
uses SDK `Mainnet`; official testnet and local/other verified networks use SDK `Testnet`.
Networks sharing SDK namespace, device, IDP index, and identity index reproduce seed,
file ID, and key. Full genesis is intentionally absent from secret derivation, source ID,
file ID, and AAD. It is present in pinned network storage, reservation scope, and the
issuance/recovery `IdentityContext` and `contextHash`.

The frozen scalar-186 public vector has a fixed-width ECDH x coordinate beginning with
`00`; that leading zero is retained through seed, file-ID, and file-key derivation.

The encrypted file accepts exactly `version: 1`, `type: "ccd-id-manager.identity"`, and
`cipher: "aes-256-gcm"`, with hexadecimal `iv`, `tag`, and `cipherText`. AES-256-GCM uses
the derived 32-byte key, a fresh random 12-byte IV per write, a 16-byte tag, and exact AAD
`ccd-id-manager.identity|1|aes-256-gcm`. Headers are validated before decryption; AAD binds
those headers and no registry metadata. Plaintext is only the SDK's unmodified
`Versioned<IdentityObjectV1>`. There is no password KDF, wrapped random storage key,
verifier, plaintext fallback, or root backup.

Stable source IDs have canonical form `ir:<payload>`. The payload remains the first 75
most-significant SHA-256 bits over UTF-8 `ccd-id-manager/source-id/v1\0`, ASCII `1`, one NUL
byte, and the canonical 65-byte root, encoded as 15 lowercase base32 characters. The `ir:`
namespace prefix changes only derived identifier output: the hash preimage and truncation,
ECDH seed, file ID, file key, AAD, and context hash are unchanged. Backend, locator, serial,
label, network, and randomness are excluded; root, not locator, is authority.

### Identity storage

A network store is:

```text
$XDG_DATA_HOME/ccd-agent-kit/id-manager/<canonical-network>/
  index.json
  credentials.json
  <identity-id>.json
  .mutation.lock
```

`<canonical-network>` is the lowercase 32-hex CAIP-2 reference without `ccd:`;
`<identity-id>` is the derived 64-lowercase-hex file ID. Directories are `0700`, files
`0600`. The ephemeral lock exists only during mutation.

`index.json` version 1 pins immutable `{caip2, genesisHash, sdkNetwork}`. Each identity
entry has file name, `recipeVersion: 1`, optional top-level label, selection
`{device, rootPublicKey, rootPublicKeyFingerprint, identityProviderIndex, identityIndex}`,
and workflow state. The root is canonical 65-byte uncompressed P-256 encoded as 130
lowercase hex; its fingerprint is lowercase SHA-256 over those bytes.

A stored identity is a discriminated union of exactly two shapes:

- The issuance-lifecycle shape has one of four statuses: `awaiting_verification`, `pending`,
  `error`, or `expired`. It retains the durable `version`, `id`, `sourceId`, `selection`, optional
  `label`, `contextHash`, and `idCredPub` fields and may carry the transient `request`,
  `requestAttemptId`, `postIssuance`, `authorizationUrl`, `retrievalUrl`, and
  `confirmedFailure` fields needed by the current attempt. These four non-ready statuses
  remain one lifecycle shape, including existing provider and authenticated failure
  handling; there is no third stored shape.
- The issued shape has status `ready` and retains only the durable `version`, `id`,
  `sourceId`, `selection`, optional `label`, `contextHash`, and `idCredPub` fields. An
  in-memory store may additionally attach the validated decrypted `identity`; production
  registry metadata never does. Issued records reject every issuance-lifecycle field.

The encrypted file contains only the SDK identity object and no manager metadata. Registry
metadata contains no identity object, account key, or signing key. Before strict issued-shape
parsing is enabled, a one-time internal protected-metadata cleanup must rewrite existing
`ready` index entries that still contain lifecycle fields. It updates only the same identity
entry under the store's existing serialization and atomic index-replacement guarantees,
preserves all durable fields, and leaves the encrypted identity-object file intact. This is
not a public CLI operation, compatibility parser, or alternate migration path.

Bootstrap resolves the configured network, verifies CAIP-2 against node full genesis,
classifies SDK namespace from verified built-in genesis, and stores actual genesis once.
Every derivation, identity, and reconciliation operation requires an exact pin match.
Network metadata is immutable.

`credentials.json` version 1 maps each 96-lowercase-hex credential ID to `identityId`,
nonnegative integer `credentialNumber`, and status `pending | confirmed`. Pending entries
also require canonical `expectedAccountAddress` and integer `expirySeconds`; confirmed
entries forbid both and are occupied. Identity index, derivation credential number,
and on-chain credential index are distinct. Account membership/public keys come only
from finalized observations, never this registry.

### Identity roots and hardware

`ccd-config-manager` alone inspects, generates, imports, adopts, replaces, forgets, labels, orders,
and sets defaults for roots. Identity manager performs only runtime agreement through an
enabled catalog backend. Generation/import always targets slot `9d` and catalogs the
observed root; adoption requires exact fingerprint confirmation; forgetting changes only
catalog locations. Replacement requires `--force` and typed confirmation. Unknown
occupancy fails closed. Failure after mutation begins is `GENERATION_UNCERTAIN` and is not
retried automatically.

Runtime agreement validates cataloged root metadata before and after ECDH; concurrent
device/root change fails closed. PIV supplies the fixed-width result but owns no root,
derivation, or source authorization policy.

Each catalog source has ordered backend locations. Every observation must match the pinned
root. Runtime performs an initial reconciliation, observes only hardware insertion/removal
for referenced enabled devices, caches public-slot observations until reconnect, and treats
mismatch as unavailable. It does not watch source-catalog or policy files. On-demand source
operations still read the current catalog and policy. `IdentitySourceService` exposes
`refresh(): Promise<void>`; the runtime service serializes initial, device-event, and
authenticated explicit refreshes through its reconciliation queue so retained
connections and observations cannot race. Covered successful `ccd-config-manager` mutations request
an explicit refresh; restart the runtime when no active instance receives it or refreshed
state is not observed. Reordering
is an exact permutation; removing a source clears a matching default but never changes
hardware or identity records. Source selection uses an exact canonical `ir:` source ID, an
ASCII case-insensitive local label, or the configured default and never falls back. The ID and
label grammars are disjoint, so each explicit selector has exactly one interpretation.
Identity-source catalog records persist the hard or `@`-prefixed soft value in `label`; registry records,
summaries, exported source APIs, CLI/MCP output, and the `ccd://identity-sources` safe
projection use `label` consistently. The workflow methods are `setOperatorIdentityLabel`
for full operator policy and `setAgentIdentityLabel` for soft-only agent mutation, making
authority explicit. Identity-source label failures use `INVALID_LABEL` and
`DUPLICATE_LABEL`, not name-based codes.
Availability (`unlocked | locked | unavailable`) is advisory; discovery also exposes only
ID, aggregate availability, and optional default ID.

### Issuance, recovery, and reservations

Protected network-scoped provider settings own local labels, enablement, issuance/recovery URLs,
issuance method, AR issuance policy, and timeout. `IdentityContext.arsInfos` remains the
authoritative complete finalized network AR map. The optional
`IdentityContext.anonymityRevocation` carries the configured
`{anonymityRevokers?: number[], anonymityRevokerThreshold?: number}` policy only for a new
issuance request. `identityContextHash` includes full genesis, canonical network, configured
URLs, SDK namespace, global parameters, selected IDP, and the complete AR map; it explicitly
removes both optional top-level POST `issuance` and `anonymityRevocation`. Context mismatch
fails closed. Adding this field does not change existing hashes and introduces no migration,
fallback, or alternate hash retry.

After checking for an existing identity, and before reserving an index or generating new
issuance material, the workflow resolves the policy against the fresh finalized AR map. It
selects the configured AR identities, or the complete map when the list is omitted, then
resolves and validates the explicit or default threshold. Unknown configured IDs, duplicate
or out-of-domain IDs, an empty selected set, or a threshold outside
`1..min(selected count, 255)` fail with `INVALID_CONFIGURATION` before reservation and before
`crypto.request`. The SDK
request receives only that selected AR subset and resolved threshold. The signed identity's
`preIdentityObject.choiceArData` therefore records the actual AR identities and threshold.

AR issuance policy applies to new issuance only. Existing-identity discovery and recovery
do not resolve or enforce it, and account-credential and proof paths continue using the
complete pinned/fresh network AR context required to hash, bind, recover, and prove an
already issued identity. Context loaders require at least one finalized AR rather than two;
an empty map still fails. This permits a one-AR network when issuance explicitly configures
threshold `1` and permits subsequent recovery and proofs without weakening full-context
pinning.

The SDK-utils identity-context snapshot parser validates AR identities with a distinct
positive-uint32 validator (`1..0xffffffff`). Identity-provider identities retain their
existing `0..0x7fffffff` domain. The SDK AR threshold remains byte-sized and is capped at
255 independently of AR identifier width.

POST body customization is not a public or persisted provider contract. The obsolete
`issuanceBody` settings field is accepted and ignored while reading existing version-1
settings, is absent from provider projections, and is dropped on the next provider-settings
write. The CLI exposes no issuance-body flags.

GET issuance returns a browser URL with callback
`ccd-id-manager://identity/<opaque-id>`; no callback HTTP server exists. POST first
persists an unconfirmed attempt, then makes exactly one bounded no-redirect request with
JSON body `{network: canonicalCaip2, state: JSON.stringify({idObjectRequest: sdkRequest})}`.
It adds no query or authorization header. A valid response supplies a human-facing `url`
and opaque `ctxId`; the URL is display-only. The manager derives
`/agent-id/{encodeURIComponent(ctxId)}/identity-object` on the configured issuance origin
and persists that absolute `statusUrl`. It never treats a response URL or context ID as
endpoint authority.

Status and background monitoring poll the persisted endpoint once per check for new POST
sessions. Provider results are `pending`, `done`, or `error`; pending preserves the attempt,
done supplies the identity object, and error remains an issuance-lifecycle provider failure.
Completion validates and binds a returned identity against the request and durable record
before removing attempt fields. It then encrypts the identity object and replaces the same
index entry with the issued shape using the persistence layer's serialization and atomic
replacement guarantees; it does not create a separate record shape or identity entry. POST
creation is never retried. Legacy workflow records without `statusUrl` retain
their existing configured-recovery-GET completion path.
Explicit reconciliation of an expired reservation also checks its POST session first:
pending preserves the reservation, errors are inconclusive, and done completes storage
without falling through to recovery or releasing the reserved index.

Public status is `pending | issued | failed | unknown`. Only authenticated current-attempt
failure is `failed`. A matching non-ready attempt is pending until its configured
deadline (24 hours by default), then becomes unknown; time alone never releases a
reservation. Monitoring never retries POST, prompts for PIN, or starts provider I/O at the
deadline. On the legacy recovery path, monitor 404 means pending; other monitor failures
are inconclusive.

Only HTTP 404 from configured recovery proves absence. Every other status, body claim,
transport, hardware, storage, or context failure is indeterminate. A found identity is
bound, encrypted, persisted, and marked used before return. Recovery never overwrites
authenticating ciphertext. It may restore missing ciphertext for a matching ready record,
or complete the same non-ready issuance entry while preserving selection, identity ID,
labels, durable binding metadata, and credential registry and stripping issuance-lifecycle
fields. Failed index replacement removes newly written ciphertext and preserves prior state.

The global version-2 reservation table scopes identity index by full genesis, source ID,
SDK namespace, and provider. States are `reserved | used | failed | released`, each with
timestamp. Used and authenticated failed-key rows are occupied. Timeout permits a new
bound recovery precheck but not reuse: 404 releases, a found identity becomes used, and
ambiguity preserves reservation. Automatic allocation chooses above the occupied
high-water mark.

Reservation mutation takes the global lock before a network identity lock. Release
compares complete scope, state, timestamp, and the workflow snapshot read before provider
I/O. Each request has a fresh attempt UUID. Release first retires the matching non-ready
workflow; callbacks/completion compare the attempt. These CAS rules prevent stale work
from freeing or replacing newer work.

Credential discovery derives registration IDs without account keys and queries one
captured finalized block. SDK account `NOT_FOUND` alone proves absence; any account hit
proves historical use even if the credential is no longer current. Current credentials
are cached under the node-canonical address. Historical source association is explicit
config-CLI trust setup: it verifies locator/root, deterministic ID, namespace, provider
indexes, full genesis, fresh context, public binding, and any ciphertext. It writes only
source ID and a conservative used reservation; it never repins or rewrites ciphertext.

### Account opening and reconciliation

Disclosure is explicit opt-in. The allowlist is exactly `firstName`, `lastName`,
`countryOfResidence`, `nationality`, `idDocType`, `idDocIssuer`, `idDocIssuedAt`,
`idDocExpiresAt`, `lei`, `legalName`, `legalCountry`, and `registrationAuth`. Omitted or
empty selection reveals nothing. Raw date of birth, identity-document number, unknown
fields, and missing selected values are rejected. Preparation decodes the exact SDK
policy and requires names/values to equal requested stored values; empty must decode to
empty. Ownership proofs are opaque. Nonempty output includes only selected decoded
values plus the warning that submission makes them public. Preparation does not sign,
submit, infer approval, or require host UI confirmation.

At most one opening is pending per identity. Optional explicit `credentialNumber`, or the
lowest unused number, must be an integer in
`0 <= n < min(identity.value.attributeList.maxAccounts, 256)`. Pending and confirmed
numbers are occupied. Allocation, SDK construction, and insertion are one serialized
mutation under exclusive-created `.mutation.lock` plus atomic registry replacement. The
one-pending guard is rechecked under lock. The record is durable before handoff return.
Contention and stale locks fail closed; locks are removed in `finally` and never aged out
or stolen.

Account-opening preparation accepts `publicKeys`, an indexed map of canonical Ed25519
public keys (1–255 entries), and `credentialThreshold`. Indexes are canonical decimal bytes (`0..255`),
must be distinct after parsing, and the threshold is an integer from `1` through the key
count. The complete map and threshold are committed into the credential and ownership
proof generation, so account opening supports multi-key credentials. Preparation accepts
these values as `publicKeys` and `credentialThreshold` and returns the handoff as
`credDeploymentHex`.
The handoff is exactly
`00 || u64_be(messageExpiry) || unsignedCredentialDeployment`, and proof generation binds
that new-account target. Existing-account handoffs are supported by signer and shared
SDK-utils assembly with exact bytes
`01 || 32-byte accountAddress || unsignedCredentialDeployment`.

Reconciliation captures `lastFinalizedBlock` once and queries block info plus expected
account at that hash. Only SDK `NOT_FOUND` means absent. Other node failures preserve
pending state. Expected account plus credential confirms regardless of expiry; account
without credential is an error. An absent account is pending through expiry and is
removed only when finalized block time is later than expiry, making its number reusable.
Wall clock alone is insufficient. Confirmed entries are occupied. Any observed account
also updates shared finalized credentials with the same block. Reconciliation uses the
same lock/atomic path and no hardware.

### Identity proofs

Proof tools accept standard SDK Verify & Access request JSON. Strict parsing precedes
configuration, storage, node, or hardware I/O. Validation returns review data; candidate
search returns safe selectors; generation returns the SDK presentation without alteration.
`ContextString` is preserved as untrusted verifier text and domain binding is always
reported `not_checked`.

Validation binds request hash to finalized `RegisterData`; node failure is a tool error,
not invalidity. Candidate search uses protected identity state and finalized credential
cache only, performs no chain/cache expansion, and exposes no checked values. One identity
or one concrete account credential must satisfy all claim groups; subjects are not mixed.

Generation revalidates request, anchor, selected subject, exact-anchor public parameters,
bound-block time, account commitments/policy, and latest finalized membership. SDK
post-verification must match exact request, context, and claims. Output excludes roots,
seeds, `idCredSec`, openings, randomness, undisclosed values, identity objects, locators,
and paths. A zero-statement identity-credential group is meaningful because its signature
binds identity/context. Literal `subjectClaims: []` and statement-free account-only
requests are rejected. Singleton `AttributeInSet` equality is supported; request-side
`AttributeValue` and payment-hash context are unsupported. Private date-of-birth
predicates are allowed.

## Local MCP instance control

Signer and identity manager share MCP-utils' resource mechanics and generic namespaced
Unix-socket lifecycle. Resource helpers carry no domain custody or config dependency.
Instance registries, sockets, bearer tokens, statuses, and handlers are separate under the
`signer` and `id-manager` namespaces. Random instance IDs are sufficient to target
an instance within its namespace; no service-type field is added.
Restricted registry/socket state uses random tokens, constant-time comparison,
heartbeat/dead-process pruning, strict public-status parsing, and best-effort cleanup.
Public status excludes tokens, sockets, paths, secrets, and working directories.

`ccd-config-manager service signer instances`, `ccd-config-manager service id-manager instances`,
and `service signer unlock|lock --instance <id>` use namespace-specific clients exported by config
and built with MCP-utils. Both listing commands print `{instances: [...]}` and return an
empty array when no live process is registered. Signer owns its server, authorization,
request handler, protected IPC state, and process-local software lock. MCP-utils owns no
password/PIN interpretation, signing, hardware action, readiness policy, or domain error.
Signer's strict public lock-status parser is separate from config refresh delivery.

Config's `mcpInstances.ts` owns shared refresh delivery and identity-manager discovery;
`signerInstances.ts` owns signer discovery, status, and lock/unlock controls. Config exports
`listIdentityManagerInstances()`, which returns
`McpInstanceRegistryEntry<{instanceId: string}>[]` containing the minimal identity-manager
status plus generic public process metadata when present:
`pid`, `parentPid`, `startedAt`, `lastSeenAt`, and `network`. Listing reads the protected
`id-manager` registry and prunes stale/dead entries through the generic client factory; it
does not send an IPC request. Config also exports
`notifyMcpInstancesConfigChanged(targets: readonly McpConfigRefreshTarget[]): Promise<void>`,
where `McpConfigRefreshTarget` is `'signer' | 'idManager'`. The helper creates namespace-specific clients with the
generic MCP-utils factory and a minimal strict public status `{instanceId}`. It maps
`signer` to the `inventory-refresh` request and `idManager` to `sources-refresh`.
Missing active instances, stale entries, and bounded delivery or handler failures are
best-effort outcomes and never turn an already successful mutation into failure.

The identity-manager MCP process owns its `id-manager` control server and binds only the
authenticated `sources-refresh` request to `sources.refresh()`. Its public control status is
only `{instanceId}`. Its config CLI surface supports discovery only: there is no identity-
manager unlock command because it has no software-lock status. Listing exposes no secrets,
paths, auth tokens, socket directories, working directory, or hardware-key activity, and
shares no registry, socket, token, or handler with signer. Signer uses the
`inventory-refresh` request name and software lock/unlock controls. YubiKey
lock/unlock targets hardware directly through config and is device-wide; their post-success
refresh notification carries no PIN.

The config CLI has one explicit post-action helper at its command root rather than a generic
event bus or distributed mutation classifier. It runs only after the command's persisted
action and any hardware cleanup have succeeded. The covered mutation-to-target mapping is:

| Successful object-first CLI mutation                                                                                         | Refresh target              |
| ---------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| Signing-key generation, import, adoption, backend ordering, or location ordering/forgetting                                  | signer                      |
| Storage enable/disable or integrity repair; signer module enable/disable                                                     | signer                      |
| Identity-root generation, import, adoption, forgetting, default selection, backend ordering, or location ordering/forgetting | identity manager            |
| Identity-manager module enable/disable                                                                                       | identity manager            |
| Device lock/unlock or integrity repair                                                                                       | signer and identity manager |

Partial mutation failure sends no refresh. Reads, labels, network changes, device
registration/rename/removal, storage initialization/password changes, identity default `show`, and
every mutation not listed above send none. No automatic fallback or
broader inference is performed. Instance listing is one of those reads and sends no refresh. In
particular, network refresh is out of scope: sessions use persisted network behavior and fresh
per-request/on-demand network resolution.

These requests add no file watcher, registry watcher, generic notification bus, hardware IPC
side channel, or MCP resource subscription source. Key subscription invalidations are
limited to actual changed runtime status under their established rules; config
notification delivery itself is not a resource invalidation.

Signer startup failure and normal close attempt cleanup of control server, activated
modules, and persistent YubiKey service exactly once; one cleanup failure does not prevent
remaining cleanup. Identity-manager startup failure and normal close likewise attempt its
control server, monitor, and persistent source-service cleanup without exposing those
lifecycle operations through IPC.

## PIV session safety

PIV owns lazy native loading, discovery/watch, callback-scoped connections, APDU/TLV
codecs, device facts, management authentication, PIN verification/logout, and YubiKey 5
management reboot. Native handles and sessions never escape awaited callbacks. Cleanup
closes listeners, timers, connections, readers, and context while preserving the primary
error. Raw APDU is internal; observations may expose status/framing counts, never payload
bytes or handles, and observer failure cannot change the operation.

Explicit serial selection starts on the first exact PIV match; selector-free discovery
waits the full window for zero/ambiguity checks. The discovery timer does not limit the
operation callback. A process-owned session pool is keyed by serial, serializes APDUs, and
may retain callbacks/connections until device removal or close. It retains no PIN. First
close rejects new work, drains queued work, and releases all connections; later sequential
close is a no-op. Concurrent callers are not promised the same completion promise. An
identity service closes an injected pool as a whole and maps close failure to its stable
sanitized hardware error.

CLI private operations always verify supplied hidden PIN input, discard it, and restore an
initially locked state. MCP never prompts; it queries current device-wide PIV status and
retains connections, not PINs. Device authorization and signer process-local software
lock are separate controls.

After attempted or confirmed key-material mutation, including uncertain mutating APDU or
post-mutation catalog failure, config issues the YubiKey 5 management reboot command—not
factory reset or PC/SC reset. Read-only, no-op, and pre-mutation guard failures do not
reboot. Before mutation it records verified/unverified PIN state and gathers any PIN
needed to restore that state after removal/arrival reconnect. Partial failures retain
stage-aware classification, are not automatically retried, and may require physical
replug. No hardware IPC side channel or hardware-event notification channel exists; the
separate post-success config notification requests only domain-owned runtime reconciliation.

## Development and release

Use Node `>=22.23.4`, pnpm, TypeScript ESM, and Nx. Update this document before changing
boundaries or contracts; document exported APIs with TSDoc; define behavior in tests
before production changes. Test classification, scratch-space rules, and verification
commands live in [development](./development.md). Security review guidance lives in
[security](./security.md).

Scripts under `scripts/` define local and CI verification and release orchestration;
workflows are thin wrappers around `pnpm verify`, `pnpm verify:affected`, and `pnpm release`.
Packages version independently. The public tool projects are `ccd-signer`,
`ccd-chain-client`, `ccd-config-manager`, and `ccd-id-manager`; private library project
identities include `libs/config-utils` and `libs/piv-utils`. Nx derives versions from
Conventional Commits and the project graph. Commit headers and body lines are limited to 160
characters; footer limits remain unchanged. Current automation creates annotated project tags and
GitHub Releases without release commits, release PRs, or registry publication. See [release](./release.md).
