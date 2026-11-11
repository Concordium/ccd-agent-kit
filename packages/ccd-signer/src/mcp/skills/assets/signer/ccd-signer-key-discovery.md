---
name: ccd-signer-key-discovery
description: Use when finding cataloged public keys or signer-capable accounts.
---

# Concordium Signer Key Discovery

Use this workflow when a user asks what this signer can sign with or how to understand signer-local key availability.

1. Read `ccd://keys` to list public signing keys available to this signer, including optional catalog labels and status: `unlocked`, `locked`, `unavailable`, or `unknown`.
2. Read `ccd://accounts` to list accounts this signer has observed keys for on the active default network. Account rows are under `.result.accounts` and include `signingStatus`.
3. Read `ccd://*/accounts` when the user asks across all configured networks; each network entry has its account rows under `.result.accounts`.
4. Read `ccd://signer/instance` when signing is blocked by locked encrypted software storage or when the user needs the current signer MCP instance state.
5. Read `ccd://networks` if you need to explain which network scopes signer account discovery by default.
Public keys and labels are protected shared catalog metadata. Labels do not imply account ownership. Signer-capable accounts come from finalized account credential observations intersected with cataloged keys visible through enabled signer modules. `locked` means local authorization is required; `unavailable` means the backend is not reachable; `unknown` means module-owned status refresh has not classified the backend yet.

Never ask for or expose private keys, storage passwords, PIV PINs, PIV management keys, key file paths, socket paths, or IPC authentication material.

## Code-Based Orchestration

If your host supports code-based MCP tool orchestration, use it for repeated signer account/key discovery across networks to reduce context loss and transcription errors. Keep each MCP call explicit, stop on tool errors, and verify resolved account addresses, public keys, key status, and signer capability before using them in later workflow steps.
