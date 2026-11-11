# Credential Signing Preimage

This note records the credential-deployment handoff wire contract used between
`ccd-chain-client` and `ccd-signer`. The canonical architecture is
[`./architecture.md`](./architecture.md); codec source is
`packages/sdk-utils/src/credentialDeployments.ts`, signer parsing is in
`packages/ccd-signer/src/core/parser/parseTransaction.ts`, and signer digesting is in
`packages/ccd-signer/src/core/sign/signCredentialDeployment.ts`.

## Protocol Context

Concordium credential account-key signing is bound to both the unsigned
credential deployment and a target context:

```text
unsignedCredentialDeployment || targetContext
```

`targetContext` is the protocol `Either<TransactionTime, AccountAddress>`:

```text
00 || u64_be(messageExpiry)      # opening a new account
01 || 32-byte accountAddress     # adding a credential to an existing account
```

The target cannot be recovered from a digest alone. A generic protocol parser
that receives a full protocol preimage would need to walk serialized
`CredentialDeploymentValues` and opaque `IdOwnershipProofs` to locate this final
`Either` safely; it must not guess by scanning from the end because bytes inside
an account address or proof can resemble tags or lengths. That offset-walking
analysis is protocol background only, not the live repository handoff parser.

## Repository Handoff Format

The implemented signer/finalizer handoff is self-describing by prefixing the
target context:

```text
targetContext || unsignedCredentialDeployment
```

The signer parses the prefix directly:

- tag `00`: read 8 bytes of `messageExpiry`, then treat the remainder as the
  unsigned credential deployment;
- tag `01`: read 32 bytes of `accountAddress`, then treat the remainder as the
  unsigned credential deployment.

It then signs:

```text
sha256(unsignedCredentialDeployment || targetContext)
```

The byte order intentionally differs between transport and digest: the handoff
is `targetContext || unsignedCredentialDeployment` for parsing, while the digest
preimage uses the Concordium protocol order.

The normal block-item parser runs before handoff parsing. Credential deployment
block items and existing-account handoffs can both start with `01`, so canonical
serialized block items must win when they parse successfully.

## Signer Completion State

The signer accepts flat signature maps with canonical decimal key indexes `0..255`
and exactly 128 hex characters per signature. Supplied indexes must exist in the
handoff before counting toward its threshold or invoking a signing backend.
`isFullySigned` describes structural threshold completion, not cryptographic
verification of supplied signatures.

The signer MCP tool is `sign_credential`. It accepts the handoff as
`credDeploymentHex` and returns detached signatures and threshold status.

## Account Opening Build And Finalize

Identity manager account-opening preparation builds an account-opening handoff:

```text
00 || u64_be(messageExpiry) || unsignedCredentialDeployment
```

`complete_account_opening` finalizes only this account-opening handoff shape. It requires:

- target tag `00`;
- canonical, distinct credential public-key and signature indexes in `0..255`;
- every supplied signature index to exist in the credential public-key map;
- every supplied Ed25519 signature to verify over the target-bound digest; and
- valid signatures meeting the credential threshold.

Reusable SDK-utils assembly performs these checks and produces an SDK
`CredentialDeploymentInfo`. Account-opening completion then wraps it in the
new-account block-item envelope and may submit only when explicitly requested.

The resulting node-submittable block item is:

```text
01 || u64_be(messageExpiry) || 01 || signedCredentialDeploymentPayload
```

The first `01` is the Concordium block-item kind for credential deployment. The
second `01` is the `AccountCredential::Normal` variant tag inside the credential
deployment payload expected by nodes.

## Existing-Account Handoffs

Existing-account target contexts (`01 || accountAddress`) are supported for
signing by `ccd-signer.sign_credential` and by shared signed-credential assembly.
They are not accepted by `complete_account_opening`, which accepts only tag `00`.
The shared assembler returns `CredentialDeploymentInfo` for either target context;
the caller owns the target-specific envelope.

## Review Summaries

Credential deployment block-item summaries decode stable credential-value fields,
including credential public keys, threshold, credential ID, identity provider,
revocation threshold, anonymity-revoker count, and policy dates. Ownership proofs are
opaque review metadata; the summary records their serialized byte length
and does not decode or verify zero-knowledge proof internals. Initial credential
variants are unsupported by the current summary/finalization path.
