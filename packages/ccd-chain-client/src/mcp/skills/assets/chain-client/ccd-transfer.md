---
name: ccd-transfer
description: Use when transferring CCD to another account with Concordium MCP tools.
---

# Concordium CCD Transfer

Use this workflow to build, sign, submit, and confirm a CCD transfer.

1. Build the transfer with `build_transfer`.
2. Review the returned transaction details and unsigned `transactionHex`.
3. Sign the unsigned transaction with a Concordium-compatible signing tool.
4. Complete the signed transaction with `complete_transaction`, passing detached signatures and `submit: true` only when broadcast is authorized for the task.
5. Poll `ccd://block-item/{transactionHash}/effects` and inspect `.result` until the transaction is finalized or rejected.

If the user gives a display CCD amount, convert it to microCCD before calling `build_transfer`.

## Code-Based Orchestration

If your host supports code-based MCP tool orchestration, use it for multi-step transfers to reduce context loss and transcription errors. Keep each MCP call explicit and stop on tool errors. Verify resolved addresses and amounts before signing or submitting, act only within the authorization granted for the task, and record transaction hashes and final status.
