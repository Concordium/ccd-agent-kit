---
name: ccd-network-discovery
description: Use when finding the active default Concordium network or listing configured networks.
---

# Concordium Network Discovery

Use this workflow before assuming which Concordium network a tool, resource, or signer operation will use.

1. Read `ccd://networks` from the MCP server you are using.
2. Treat `defaultNetwork` as the active default network for that server.
3. Interpret `defaultNetworkSource`:
   - `session` means the current process is using a session override such as `CCD_NETWORK`.
   - `config` means the active default comes from persisted configuration or built-in fallback.
4. Use each network entry's `name` for display and its `caip2` value when an unambiguous chain identifier is useful.
5. When building or querying with tools that accept a `network` argument, pass the intended network explicitly when ambiguity matters.

Do not infer the active default network from block heights, genesis times, token lists, or consensus status when `ccd://networks` is available.

## Code-Based Orchestration

If your host supports code-based MCP tool orchestration, use it for repeated network discovery or cross-network lookups to reduce context loss and transcription errors. Keep each MCP call explicit, stop on tool errors, and verify the resolved network name and CAIP-2 identifier before using them in later workflow steps.
