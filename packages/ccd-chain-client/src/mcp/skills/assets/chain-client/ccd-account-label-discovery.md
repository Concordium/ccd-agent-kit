---
name: ccd-account-label-discovery
description: Use when finding configured Concordium account labels or explaining their network scope.
---

# Concordium Account Label Discovery

Use this workflow to find configured account labels or check label availability on a network.

1. Read `ccd://account-labels` and use `.result.labels` for mappings on the active default network.
2. Read `ccd://*/account-labels` and use each `.networks[name].result.labels` for cross-network lookups.
3. Use network-qualified account-label resources for a specific network.
4. Before using a selected account, verify the resolved network, label, and address are consistent with the intended operation.

Account labels are network-specific, matched case-insensitively, and returned with stored casing. `label_account` changes soft labels only: supply either `label` or `remove: true`, never both. Labels do not prove account ownership or signer capability; use signer account resources for that.

## Code-Based Orchestration

If your host supports code-based MCP tool orchestration, use it for repeated account-label lookups across networks to reduce context loss and transcription errors. Keep each MCP call explicit, stop on tool errors, and verify the resolved network, labels, and addresses before using them in later workflow steps.
