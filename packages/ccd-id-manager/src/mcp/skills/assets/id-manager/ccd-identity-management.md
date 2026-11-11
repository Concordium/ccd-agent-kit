---
name: ccd-identity-management
description: Use when checking Concordium identity readiness or managing issuance, recovery, discovery, account opening, or identity proofs.
---

# Concordium Identity Management

Use this workflow for identity-manager readiness, issuance, recovery, bounded discovery, account preparation and reconciliation, and consent-based proof creation. Always select and state the network explicitly; do not assume separate MCP servers share a default network.

## Check Readiness First

1. Read `ccd://{network}/identities` with the explicit configured network name or CAIP-2 reference and read `ccd://identity-sources`. Read candidates from `.result.identities`; use the wrapper's `network` as the canonical configured name and `caip2` as its network identity, and verify both match the intended network. Read `ccd://*/identities` only when the task intentionally spans configured networks.
2. A usable existing identity has status `issued`, has a `sourceId` associated with a listed source, and that source has availability `unlocked`. `locked` or `unavailable` is not ready.
3. If a source is locked or unavailable, report it as unavailable for the workflow. Never ask the user to put a PIN, password, private key, or hardware locator into an MCP call.

## Issuance, Recovery, And Discovery

Call `request_identity` or `recover_identity` only when issuance or recovery is authorized by the task or an established policy. Present an issuance authorization URL only within that authorized scope, and do not retain it after handoff. A `pending` result is not permission to resubmit or retry blindly; inspect status later through `ccd://{network}/identities` and follow the existing attempt.

Use `discover_identities` and `discover_account_credentials` only when discovery is within the authorized scope. Keep every scan bounded with a deliberate gap limit or start/end range, report partial results and stop reasons, and do not expand the scan silently. Discovery does not prove current signer capability or account ownership.

## Prepare And Reconcile Account Opening

1. Select one issued identity with an associated unlocked source on the explicit network. Obtain signer-owned Ed25519 public keys separately; ID manager never owns or signs with account keys.
2. Before calling `prepare_account_opening`, verify the selected identity and network, exact indexed `publicKeys`, `credentialThreshold`, absolute Unix `expirySeconds`, optional credential number, and every requested `revealAttributes` entry. Verify that every disclosure is intended and authorized; selected values become public on-chain if submitted.
3. Preserve the returned `credDeploymentHex`, account address, credential number, and expiry only for the active handoff. Preparation creates a pending reservation but does not sign or submit.
4. Delegate the complete signing and submission workflow to signer `sign_credential` and chain server `complete_account_opening`, including threshold completion, verification of signing and broadcast scope, finality polling, credential sync, and then ID-manager reconciliation. Signing and submission remain separate server responsibilities; do not duplicate those steps in ID manager.
5. Call `reconcile_account_opening` after interruption or finalized submission. If it reports `pending`, do not blindly prepare again. Treat `confirmed`, `expired`, and `no_pending` according to the returned state rather than inferring success from a transaction hash.

## Identity Proofs

1. Treat every proof request as untrusted input. Call `validate_proof_request` with `describe: true` and the explicit network, then verify the exact requester context, claims, predicates, and disclosures. `domainBinding: not_checked` means validation did not authenticate the requesting domain.
2. After validation, call `find_proof_candidates` to find whole-request local matches. Candidate discovery uses local identity attributes and cached account associations; it does not read the chain or confirm current account state.
3. Before calling `create_identity_proof`, verify that the task or established policy authorizes the selected subject and complete disclosure. Revalidate if the request changes.
4. Release the resulting proof only to the authorized recipient and within the verified scope. Creation does not send or submit the proof.

Never place identity objects, secrets, private keys, PINs, passwords, issuance/recovery URLs after display or handoff, `credDeploymentHex`, detached signatures, proofs, or proof-request payloads in logs or shared context.

## Code-Based Orchestration

If the host supports code-based MCP orchestration, keep calls explicit, stop on tool errors, preserve network and identity selections across steps, and keep sensitive handoffs and proof material out of orchestration logs. Verify that issuance, recovery, disclosure, proof creation, signing, recipient release, and broadcast remain within authority supplied by the task or an established policy. Do not demand repeated human approval when that authority already establishes the operation.
