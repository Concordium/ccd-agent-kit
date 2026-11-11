# Security

## Security Model

The signer is the only runtime package allowed to use account-signing private material, including credential-deployment
keys. `ccd-config-manager` has one narrow exception: during an explicit operator provisioning or import operation it may handle
signing material transiently through trusted callbacks and shared protected-storage/PIV primitives. It must not sign,
become a runtime signing backend, or persist secrets outside the store owned by the signing domain.

The public identity-manager package separately owns private identity secrets, identity derivation, and ECDH results. It
never derives or uses account-signing keys. The chain MCP server queries, builds unsigned artifacts, verifies
signatures, completes signed artifacts, and explicitly submits them; it never holds private keys, signs, or reads signer
private storage.

Shared packages are capability-neutral:

- `@ccd-agent-kit/config-utils` owns protected public catalogs, policy persistence, and protected storage primitives and formats;
  its consumers retain custody and authorization.
- `@ccd-agent-kit/piv-utils` owns callback-scoped PC/SC/PIV mechanics and fake/injected interfaces, not signer policy, identity
  derivation, catalogs, or application authorization.
- MCP and CLI utility packages own transport and presentation mechanics, not secrets, signing, PIN interpretation, or
  domain policy.
- `@ccd-agent-kit/ccd-skills` contains only public Markdown workflow guidance. It provides no
  tools, resources, credentials, authority, installer behavior, or runtime capability.

## Secret And Output Boundaries

Private keys, passwords, PINs, management keys, storage keys, bearer tokens, complete identity objects, undisclosed
identity data, proof randomness, hardware locators, native handles, and protected filesystem/socket paths must never
appear in MCP responses, stdout protocol traffic, logs, public status, or error causes. Unknown backend and node errors
are sanitized rather than forwarded. MCP inputs must not accept raw private keys, passwords, PINs, management keys, or
protected paths.

The permitted identity exception is an explicitly requested standard proof or disclosure artifact. It may contain only
the requested public disclosures defined by that protocol; selected account-opening values are sensitive until
submission. Local CLI diagnostics may identify protected state only where an operator explicitly requested path
inspection.

MCP stdout is reserved for protocol frames. Signing tools may return detached signatures and public metadata. Query
tools may return public chain data and configured public labels. Public inventory and source discovery use explicit safe
projections rather than spreading internal records.

Resource-update notifications contain only the exact subscribed URI and mean that its value may have changed. Domain
runtimes publish semantic resource names and canonical network scope, never protected filesystem paths, file contents,
node errors, or secrets. The subscription manager performs no filesystem or network-registry observation, and
subscriptions create no chain polling, mutation, or secret operation.

## Labels, Policy, And Runtime Authorization

Signing-key, identity-root, identity-object, identity-provider, network-scoped account, and
network-scoped contract-instance labels occupy separate namespaces. Shared policy compares labels
ASCII-case-insensitively while retaining stored spelling. Hard labels are operator-protected; soft labels are
agent-modifiable. Persisted ownership encoding is never exposed as user input or output. A label is metadata, not
cryptographic, device, chain, custody, or signing authority. Native identifiers keep domain comparison rules, and
YubiKey device names are not labels.

Signer MCP may write signing-key soft labels, identity-manager MCP may write identity-root and identity-object soft
labels, and chain MCP may write network-scoped account and contract-instance soft labels. None may replace, remove,
recase, or demote a hard label. Full shared-catalog mutation belongs to `ccd-config-manager`; identity and provider stores are
under the identity-manager CLI boundary.

Disabled modules are a privacy and capability boundary: their material must not appear in listings, resources,
readiness, signing, derivation, import, generation, or mutation. Signer and identity-manager runtimes independently
enforce their enabled-module policy; `ccd-config-manager` is only the persisted policy manager. Its status commands report
configured enablement, not hardware presence, private-material availability, or operation authority.

Authorization-sensitive workflows are host-neutral. Authority may be supplied by the
current task or by an established policy that covers the actor, operation, target, network,
disclosures, and effects. Before issuance, recovery, disclosure, proof creation, signing,
or broadcast, an agent must verify that the available authority covers the exact action.
Verification is mandatory; a repeated human prompt is not when sufficient authority is
already established. Missing, stale, ambiguous, or narrower authority requires stopping
rather than inferring consent. In particular, permission to prepare or sign does not imply
permission to disclose attributes or broadcast.

Local MCP instance control uses namespace-separated restricted registry/socket state, random bearer tokens, and
constant-time comparison. Public instance views omit endpoints, tokens, paths, and private status. Heartbeat and PID
cleanup are availability mechanisms, not authorization. `ccd-config-manager` is an authenticated client; signer owns its control
server and process-local software lock state, while identity manager owns a separate refresh-only control server whose
public status is only its instance ID. Identity refresh IPC accepts no unlock, PIN, locator, or private field. YubiKey PIN
lock/unlock instead changes direct, device-wide PIV state and creates no process-local authorization; post-success refresh
delivery carries no PIN.

## PIV And Hardware Safety

PIV sessions and native handles stay inside awaited trusted callbacks. PINs, management keys, and imported private
keys are entered interactively, held only as long as required, and never supplied by arguments, environment variables,
config, MCP, paths, or inventory. JavaScript and SDK copies prevent a guarantee of complete memory erasure; owned
buffers are cleared best-effort.

Software Ed25519 generation uses the platform cryptographic RNG and sends generated private bytes directly to the
signer-owned encrypted-file writer. It creates no intermediate key file and emits only the public key and public catalog
reference. Owned seed buffers are cleared best-effort in `finally`; JavaScript still cannot guarantee erasure of all
runtime copies. Encrypted-file is the only software private-key storage implementation.

MCP hardware operations never prompt for a PIN. Readiness and cached PIN status are advisory; the attempted signing or
ECDH operation is authoritative. PIN-`always` keys are never considered persistently ready. CLI private operations prove
PIN knowledge and restore an initially locked state. No native mutation is implicitly retried.

Signer PIV signing verifies the pinned public key before each signature. Identity ECDH and config hardware workflows
verify pinned keys and slot metadata before and after sensitive operations. Mismatches fail closed and are never silently
adopted. Unknown slot occupancy fails closed. Replacing
occupied key material requires `--force` and exact typed confirmation. Read-only inspection performs no PIN
verification, ECDH, provisioning, or mutation.

After an attempted or confirmed key-material mutation, including an uncertain mutating APDU or catalog failure after
hardware change, config reports truthful stage-aware facts and uses YubiKey management reboot—not factory reset or PC/SC
reset. It does not retry the mutation or claim the old state survived. Reconnect attempts restore the PIN state recorded
before mutation; external recovery may still require replugging. Read-only, no-op, and pre-mutation guard failures do
not reboot.

Raw APDU transmission is trusted internal capability, never a CLI/MCP passthrough. Injected and fake PIV interfaces
support composition and deterministic testing but grant no alternate authorization path.

## Local Protected State

XDG state is namespaced under `ccd-agent-kit`:

```text
$XDG_CONFIG_HOME/ccd-agent-kit/
$XDG_DATA_HOME/ccd-agent-kit/
$XDG_STATE_HOME/ccd-agent-kit/
$XDG_RUNTIME_DIR/ccd-agent-kit/
```

Sensitive directories use mode `0700` and files use `0600`. Readers and writers reject symlinks and malformed or unknown
versions, use atomic replacement, and use exclusive locks where the owning protocol requires serialization. A stale lock
is never aged out or stolen. Readable labels, public keys, account observations, endpoints, workflow state, and device
references are sensitive and linkable operational metadata.

Protected-file ancestor checks anchor at the `ccd-agent-kit` application directory before
enforcing the protected signer or identity-manager subtree. Runtime instance registries use
the runtime path above, or the state-root `ccd-agent-kit/runtime/` fallback when
`XDG_RUNTIME_DIR` is absent. No alternate application directory is read.

Signer inventory may contain public keys, labels, module references, and verified backend locators, but never private
keys, PINs, management keys, passwords, absolute private-key paths, or account-opening payloads.
Locators are hints; the pinned key is authority. Unsupported storage-module locators remain inert catalog metadata and
grant no private-material access.

Catalog `forget` operations are metadata-only. They may remove an emptied public backend, signing-key record, or
identity-root record (and a removed root's default selection), but never erase a software private-key file, mutate a
hardware slot, or delete identity objects. Backend and location ordering accepts only exact permutations of existing
entries and grants no custody or runtime authority.

### Encrypted signer storage

The encrypted-file signer backend uses a random storage key for Ed25519 seeds and a password-derived
key to wrap that storage key. Exact algorithms, formats, validation, and password-change behavior are
defined in [architecture](./architecture.md#encrypted-software-key-storage).

Use a strong password: possession of storage state permits offline guessing, and its salt is public.
Back up storage state and encrypted key files together. Password changes do not rotate the storage
key or revoke older backups, so old state/key-file copies remain accessible with the old password.
Process locking and transient-buffer clearing are best-effort in JavaScript, not guaranteed erasure.
File modes and protected-path checks mitigate local exposure but do not replace host security or
backup protection.

## Identity Manager

The identity manager is publicly packaged, but its identity data and custody boundary are private. Exact protocol
bytes, derivation, encrypted storage, and workflow schemas are defined
by [architecture](./architecture.md#identity-derivation); package boundaries and callable workflow contracts are
defined in [architecture](./architecture.md#identity-manager).

### Identity custody and trust

The manager may transiently hold ECDH output, derived roots, identity secret scalars, attribute openings, decrypted
identities, and proof randomness. Durable identity objects are encrypted; plaintext fallback, password-derived fallback,
root backup, and alternate identity stores are forbidden. A P-256 root is held in PIV slot `9d`; the catalog-pinned
canonical root, not serial, locator, name, or label, is authority.

The configured node supplies finalized network, anchor, provider, anonymity-revoker, account, and credential facts.
Operations verify full genesis and provenance; node unavailability is never interpreted as absence or invalidity.
Network namespace and SDK context are selected from verified genesis, never guessed from a name or CAIP-2 prefix. An
existing record is never repointed, trial-repinned, or rewritten after context mismatch.

Provider selection is a native index or ASCII case-insensitive local label. Enabled state and endpoint completeness authorize MCP use.
Issuance and recovery endpoints come only from protected provider settings; node descriptions, response URLs, labels,
and stale workflow fields are not endpoint authority. Every operation binds fresh finalized provider/global context,
full genesis, canonical network identity, and configured endpoints.

Per-provider anonymity-revocation policy controls new issuance only. Configured AR values
are positive uint32 `arIdentity` identifiers, never response-array positions. Configuration
checks a nonempty, unique list against the cached local inventory and atomically validates
the merged list and independently optional threshold; setting or clearing one field cannot
silently rewrite the other. Issuance repeats validation against the fresh finalized AR map
immediately before reservation or cryptographic request generation. Unknown or empty
selection and invalid thresholds fail closed without reserving an identity index. Thresholds
are never clamped: omission means selected count minus one, while an explicit value must be
`1..min(selected count, 255)`. A one-AR network therefore requires explicit threshold `1`.

### Issuance, recovery, and reservation safety

The issuance request receives only the freshly resolved AR subset and threshold, and its
signed `preIdentityObject.choiceArData` records that actual choice. The complete finalized AR
map remains authoritative in `IdentityContext` and in context hashing for existing identity
integrity. The optional issuance-policy field is explicitly excluded from that hash, as is
POST transport metadata; there is no migration, fallback, or alternate hash retry.
Discovery, recovery, account-credential, and proof operations neither enforce the current
issuance policy nor replace the complete AR context pinned for an existing identity. They
accept a nonempty one-AR finalized context, while an empty map always fails.

Provider retrieval and recovery GETs are bounded and never follow redirects. GET issuance uses the configured bounded
callback flow. POST issuance durably records a fresh unconfirmed attempt before exactly one bounded request. Its fixed
JSON body contains the canonical CAIP-2 network and the stringified SDK identity-object request; operators cannot add
custom POST fields. The returned human URL is display-only. The opaque returned context ID is encoded only as a path
segment in `/agent-id/{encodeURIComponent(ctxId)}/identity-object` on the configured issuance origin, and that derived
URL is persisted for new-session status and monitor polling. Response URLs and context IDs never grant endpoint
authority. The monitor never prompts, retries POST creation, uses account keys, or starts provider I/O merely because a
deadline passed.

The POST status endpoint reports `pending`, `done`, or `error`. Only `done` supplies an identity object for the normal
binding, encryption, and persistence checks. Binding succeeds before any request-attempt metadata is removed. The
persisted `ready` entry then contains only durable identity metadata and rejects request, attempt, POST-session,
authorization, retrieval, and confirmed-failure fields; non-ready `awaiting_verification`, `pending`, `error`, and
`expired` records retain the issuance lifecycle and its existing failure handling. Existing workflow records without a
persisted status URL keep their configured recovery-GET path; this compatibility does not permit new response-selected
endpoints.

Existing ready metadata that predates this split requires one internal protected cleanup before strict issued parsing is
enforced. Cleanup atomically replaces only the same index entry under the normal store lock, preserves durable fields,
and must not delete or rewrite the encrypted identity-object file. It exposes no public cleanup command and introduces
no permissive parser or alternate read fallback.

Only the configured recovery endpoint's HTTP 404 proves absence for discovery or release. All other status, body,
transport, storage, hardware, or context failures are indeterminate. Reservations are occupied until a fresh, bound
check authorizes release. Mutation ordering, complete-scope comparison, attempt IDs, workflow snapshots, and
compare-and-swap guards prevent stale monitors and callbacks from freeing or overwriting newer work.

Credential discovery uses one finalized block. SDK account `NOT_FOUND` alone proves absence. Any credential-ID account
hit proves historical use, even if the credential is no longer current, and the association stays occupied. Explicit
historical association must reproduce the pinned root, derivation, identity/public binding, provider context, and full
genesis; it never repins ciphertext or occurs as a side effect.

A pending account opening is occupied until finalized reconciliation. Expiry by wall clock is insufficient: only
finalized post-expiry account absence releases it. Node errors or unexpected account contents preserve pending state.

### Disclosure and proof safety

Account-opening disclosure is explicit opt-in and restricted to the architecture's exact allowlist. Raw date of birth,
identity-document number, missing selected values, and unknown fields are rejected. The decoded handoff disclosure must
exactly equal the requested stored values before pending state is written. Preparation is review, not approval, signing,
or submission.

Credential completion is not structural assembly alone. Shared SDK-utils assembly binds
the handoff target into the signing digest, verifies each supplied Ed25519 signature against
the indexed credential key committed by the unsigned deployment, and requires the declared
credential threshold. Chain MCP permits credential-deployment completion only for a
new-account target; signer may sign either new-account or existing-account handoffs.

Proof parsing and finalized anchor binding precede sensitive I/O. `ContextString` is untrusted verifier text; domain
binding is not inferred. Candidate search returns safe selectors only and is advisory, not authorization. One identity
or one concrete account credential must satisfy the whole request; claims cannot be combined across subjects.

Generation rechecks the anchor, subject eligibility, exact public parameters, and current credential membership, then
verifies the presentation against the exact request, context, and claims. Literal empty subject claims and empty
account-only proofs are not holder authorization and are rejected. Raw forbidden attributes are undisclosable even
when private predicates are supported. Outputs contain only the standard requested disclosures without alteration—never roots, seeds,
identity secrets, openings, randomness, undisclosed values, complete identity objects, hardware locators, or protected
paths.

### Current limitations

Identity-manager secrets and protected state are private. JavaScript cannot guarantee secret erasure. Identity-root backup is unsupported,
and broader hardware, recovery, account-proof, external-verifier, and authenticated-domain assurance is limited.

## Chain Client Safety

Chain MCP may query public state, build unsigned artifacts, verify signatures, finalize artifacts, and explicitly submit
finalized block items. Submission changes network state but is not signing. Tool descriptions and annotations must
distinguish queries, builders, verification/completion, and explicit broadcast. Building or signing never implies
submission.

Chain MCP exposes no WalletConnect or ID App pairing/`create_account` handoff surface. The
supported account-opening path keeps identity preparation in identity manager, detached
credential signing in signer, and verification, finalization, and optional submission in
chain client's `complete_account_opening` tool.
