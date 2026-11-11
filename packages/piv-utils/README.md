# @ccd-agent-kit/piv-utils

Private shared PC/SC/PIV transport and neutral codecs. It owns native loading,
discovery/watch, scoped card sessions, APDU/TLV handling, metadata observation,
management authentication, PIN verification, and YubiKey 5 management reboot mechanics.
Config, signer, and identity manager consume it but never import one another.

## Contract

`createPivTransport()` provides callback-scoped card discovery/selection and device
watching. The default discovery window is 2 seconds after PC/SC context creation.
Explicit serial selection starts on the first exact PIV match; serial-less selection
uses the full window for zero/ambiguity checks. The timer does not limit callback work.

Sessions and native handles stay inside awaited callbacks. Cleanup covers listeners,
timers, connections, readers, and context; cleanup does not replace the triggering error. A
session pool may keep shared callbacks pending until close or device removal and
serialize operations on each device.

Shared public-slot observations are cached for the active connection and invalidated on
removal/reconnect or caller-reported catalog change; reconnect reobserves before use.
Device watching reports insertion/removal, not external PIN-state changes; consumers must
not promise a PIN notification or add polling around that limitation.

`PivCardSession` exposes PIV selection, device facts, slot metadata, management
authentication, PIN status/verification/logout, internal transmission, and disconnect.
Public TSDoc defines callable options. `PivDeviceNotFoundError` and
`isPivSharingViolation` support sanitized consumer error mapping.

Native identity and Ed25519 adapters compose typed service contracts over this
structured transport and an optional session pool. Composition helpers and card/APDU
objects are internal; consumers receive typed service results rather than native
handles or a second raw transport surface. The identity adapter exposes its stable,
sanitized hardware-error contract.

After attempted or confirmed key material mutation—including uncertain mutating-APDU
failure or catalog failure after hardware mutation—config uses management reboot rather than factory reset or PC/SC
reset. No-op, read-only, and pre-mutation guard failures do not reboot. The operation
records verified/unverified PIN state and collects any PIN needed to restore that state
after reconnect. Per-operation initially-locked restoration is separate.
Partial failures retain stable stage-aware classification; external tools may require
replug. No notification side channel is defined.

Config's targeted generate/import/adopt/forget, PIN lock/unlock, and integrity-repair
commands require explicit device selection. Read-only integrity may inspect all connected
devices across both catalogs. Repair is catalog-only and never turns observation
into adoption or changes hardware; disconnected locations are unavailable, not stale.

Generic codecs preserve signer wire behavior. Strict identity TLV/metadata decoders
reject malformed framing and retain complete public-key template bytes. Consumers own
scheme validation and policy.

## Ownership And Safety

Do not move catalog schemas, Ed25519 signing codecs/slot policy, identity P-256/`9d`
policy, root derivation, persistence, or application authorization here. Trusted callbacks may
supply transient PIN/management material; this grants no durable custody. Never expose
APDU payloads, native handles, secrets, or raw causes through CLI/MCP output. Raw APDU
transmission is not a public tool passthrough.

See [architecture](../../docs/architecture.md) and [security](../../docs/security.md).
