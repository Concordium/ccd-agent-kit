---
name: ccd-sponsored-multisig-transaction
description: Use when coordinating sponsored or multi-signature Concordium account transactions.
---

# Concordium Sponsored And Multisig Transaction

Use this workflow when more than one signature set may be needed, including sponsored transactions, account-threshold multisig, credential-threshold multisig, or retrying rejected signatures.

1. Build the unsigned transaction with the appropriate `build_*` tool, including `sponsor` when the transaction should be sponsored.
2. Send the same unsigned `transactionHex` to each required signer using a Concordium-compatible signing tool. Do not share private keys or signer-local paths.
3. Collect returned role-separated detached signature sets.
4. Call `complete_transaction` with `transactionHex` and all collected signature sets.
5. Keep the returned `signatures`; they contain only signatures verified as good for the resolved network.
6. If `hasRejectedSignatures` is true, use `badSignatures` to ask signers for replacements by role, credential index, and key index, then call `complete_transaction` again with the known-good `signatures` plus replacements.
7. If `isFullySigned` is false, collect more signatures according to `missingSignatures` and combine again.
8. When `isFullySigned` is true, keep the returned `blockItemHex`, or call `complete_transaction` with `submit: true` if broadcast is authorized for the task.
9. Poll `ccd://block-item/{transactionHash}/effects` and inspect `.result` after submission.

The completer does not sign. It verifies submitted signatures individually against the transaction and current account credential state, returns rejected candidates grouped by reason, finalizes complete signature sets, and submits only when `submit: true` is provided.

## Code-Based Orchestration

If your host supports code-based MCP tool orchestration, use it for repetitive signature collection, combination, finalization, submission, and polling steps to reduce context loss and transcription errors. Keep each MCP call explicit and stop on tool errors. Verify resolved addresses and signature requirements before signing or submitting, respect each signer's authorization, and record signature status, transaction hashes, and final status.
