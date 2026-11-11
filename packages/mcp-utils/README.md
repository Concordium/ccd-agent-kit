# @ccd-agent-kit/mcp-utils

Private shared helpers for JSON-safe MCP structures, responses, skill metadata,
network-scoped resource mechanics, subscriptions, and namespaced local MCP-instance
lifecycle.

`serializeJsonFile(value)` is the shared serializer for repository-owned JSON file writes.
It returns two-space-indented JSON with exactly one trailing newline. It throws `TypeError`
when an `undefined`, function, or symbol root cannot be serialized, preserves native
circular-reference and `bigint` errors, and does not convert bigint values. File writers
retain ownership of atomic replacement, exclusive creation, locking, permissions, cleanup,
and rollback. Protocol payloads, CLI output, hashing/canonicalization, encryption plaintext,
and intentionally malformed test fixtures do not use this file serializer.

`registerNetworkResourceFamily` accepts one relative family path/domain reader plus an
injected `NetworkResourceAdapter`. The adapter synchronously supplies a deterministic current
configured-network snapshot and default/explicit resolution; MCP-utils has no config
dependency. Domain reads are asynchronous. The helper defines
`ccd://path`, `ccd://{configuredName|bareCaip2Ref}/path`, and `ccd://*/path`, owns matching and
completion once, and returns `{network, caip2, result}` for one network or
`{networks: {name: {network, caip2, result|error}}}` for all networks. Wildcard errors are
isolated per network and distinguish missing resources from node/read failures.

MCP-utils directly depends on `@modelcontextprotocol/server`. `BoundMcpResourceDefinition`
contains a resource name, URI, typed metadata, bound reader, and optional list/completion
callbacks. `registerMcpResources` registers these definitions with the SDK, constructs URI
templates, and maps shared reader failures to protocol errors. Consumers define each resource
once instead of translating it into server-specific resource types.

Network families have an optional `subscribable` flag; eligible globals are listed explicitly.
`ResourceSubscriptionManager` is exact-URI bookkeeping over the same
matcher. Global scopes retain the registration name; default and explicit scopes pin one
canonical network; wildcards pin the configured-network set captured at subscribe time.
Registry changes do not alter active scopes.

Domain runtimes call
`manager.invalidate({ resourceName, network })`. The canonical network name
is required for network-scoped invalidations. The manager matches the event to pinned scopes and
sends best-effort updates for the subscribed exact URI. Unsubscribe removes the URI and close
clears manager state. The manager has no observation adapter, filesystem watcher, registry
watcher, dependency graph, or refresh queue.
`bindResourceSubscriptions` installs schema-validated handlers only where the stdio owner has
subscribable definitions and composes with close handlers.

The instance boundary owns restricted registry/socket creation, random bearer
authentication, heartbeat/dead-process pruning, authenticated client request delivery,
and best-effort cleanup. Consumers provide namespace, state directory, strict public-
status parsing, and an authenticated domain request handler. `@ccd-agent-kit/config-utils` builds
namespace-specific signer and identity-manager refresh clients with this factory;
signer and identity manager still own their separate servers, authentication policy, and
domain handlers. Unique IDs target instances only within the selected namespace, so no
service-type field is required. MCP-utils has no reverse dependency on config, either
runtime, or the CLI.

It does not own prompting, PIN/password interpretation, signing, hardware operations,
readiness policy, identity sources, or domain errors. Signer and identity manager use
separate registries, sockets, tokens, statuses, and handlers.

Runtime paths are `$XDG_RUNTIME_DIR/ccd-agent-kit/<namespace>/instances`, or
`<getStateDir()>/runtime/<namespace>/instances`.
The runtime-root path is constructed inside MCP-utils; config-utils consumes this client,
and MCP-utils does not depend on config-utils.
Public projections omit sockets, tokens, protected paths, and domain secrets. Exported
TSDoc defines the callable controller API.

See [architecture](../../docs/architecture.md#mcp-resource-model),
[instance control](../../docs/architecture.md#local-mcp-instance-control), and
[security](../../docs/security.md).
