---
name: ccd-plt-transfer
description: Use when transferring protocol-level tokens with Concordium MCP tools.
---

# Concordium PLT Transfer

Use this workflow to build, sign, submit, and confirm a protocol-level token transfer.

1. If needed, inspect token metadata in `.result` from `ccd://plt/{tokenId}`.
2. If needed, inspect sender balance in `.result` from `ccd://account/{account}/balances/{tokenId}`.
3. Build the PLT transfer operation with `build_plt`.
4. Review the returned transaction details and unsigned `transactionHex`.
5. Sign the unsigned transaction with a Concordium-compatible signing tool.
6. Complete the signed transaction with `complete_transaction`, passing detached signatures and `submit: true` only when broadcast is authorized for the task.
7. Poll `ccd://block-item/{transactionHash}/effects` and inspect `.result` until finalized or rejected.

`build_plt` transfer amounts use raw smallest-unit `amountUnits`. If the user gives a display amount, use token decimals from the resource `.result` before building.

## Code-Based Orchestration

If your host supports code-based MCP tool orchestration, use it for multi-step transfers to reduce context loss and transcription errors. Keep each MCP call explicit and stop on tool errors. Verify resolved addresses, token identifiers, and amounts before signing or submitting, act only within the authorization granted for the task, and record transaction hashes and final status.
