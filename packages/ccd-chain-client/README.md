# @ccd-agent-kit/ccd-chain-client

Concordium MCP server for public node queries, contract simulation, unsigned transaction
building, public signature verification, artifact completion, and explicit submission. It
never holds private keys, signs, or reads signer-managed private storage.

| Contents                            |
| ----------------------------------- |
| [MCP tools](#mcp-tools)             |
| [MCP resources](#mcp-resources)     |
| [Installation](#installation)       |
| [Setup](#setup)                     |
| [Safe workflows](#safe-workflows)   |
| [Troubleshooting](#troubleshooting) |

See the canonical
[chain-client architecture](https://github.com/Concordium/ccd-agent-kit/blob/main/docs/architecture.md#chain-client)
and [security model](https://github.com/Concordium/ccd-agent-kit/blob/main/docs/security.md#chain-client-safety).

## MCP Tools

Use MCP tool discovery for complete input and output schemas.

| Tool                           | What it can do                                                                                                                  |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `label_account`                | Set or remove an agent-modifiable account label without changing an operator-protected label.                                   |
| `sync_account_credentials`     | Fetch finalized public credential keys for an account and cache them so signer can detect usable accounts.                      |
| `label_contract_instance`      | Set or remove an agent-modifiable contract-instance label without changing an operator-protected label.                         |
| `simulate_contract`            | Simulate a contract receive call without changing chain state; return its result, energy, return value, and events.             |
| `get_cis2_token_balance`       | Read a CIS-2 token balance in raw smallest units; decimals come from off-chain metadata.                                        |
| `build_transfer`               | Build an unsigned CCD transfer transaction; never sign or submit it.                                                            |
| `build_register_data`          | Build an unsigned register-data transaction; never sign or submit it.                                                           |
| `build_configure_delegation`   | Build an unsigned delegation-configuration transaction; never sign or submit it.                                                |
| `build_configure_baker`        | Build an unsigned validator-configuration transaction; never sign or submit it.                                                 |
| `build_update_credential_keys` | Build an unsigned transaction replacing one credential's complete public-key set after refreshing finalized sender credentials. |
| `build_init_contract`          | Build an unsigned contract-initialization transaction; never sign or submit it.                                                 |
| `build_update_contract`        | Build an unsigned contract-update transaction; never sign or submit it.                                                         |
| `build_plt`                    | Build an unsigned tag-27 token update from ordered scoped token or unscoped token/lock operations.                              |
| `verify_transaction_signature` | Verify detached transaction signatures against finalized on-chain account keys.                                                 |
| `verify_message_signature`     | Verify a detached message signature against finalized on-chain account keys.                                                    |
| `complete_transaction`         | Combine and verify detached signatures, optionally finalize a block item, and submit only when explicitly requested.            |
| `complete_account_opening`     | Verify flat credential signatures, finalize a new-account block item, and submit only when explicitly requested.                |

`build_plt` keeps its flattened operation inputs, including lock-create
`controllerMemoText`/`controllerMemoJson`. Protocol 11 lock release uses operation type
`lock_release` and grant capability `release`; the former `lock_return` and `return` names are not
aliases. A `lock_create` operation may include `metadataJson`, a JSON object whose optional `name`
and `description` values must be strings; other JSON fields and an empty object are allowed. The
same object appears in the unsigned payload summary for review:

```json
{
  "type": "lock_create",
  "metadataJson": {
    "name": "Escrow",
    "description": "Release after delivery",
    "reference": 42
  }
}
```

Lock detail queries omit `metadata` when none exists. Otherwise they return the original bytes as
`metadata.hex` and, when SDK decoding produces MCP-safe JSON, an inspection view as
`metadata.cbor`. CBOR byte strings become hex strings and big integers become decimal strings; a
decode or JSON-projection failure leaves the raw hex available without failing the lock query.
Token metadata updates continue to accept a URL only; no metadata-checksum input is exposed.

## MCP Resources

Network-scoped rows below each represent three registered URI templates: `ccd://PATH` uses
the server's default network, `ccd://{network}/PATH` selects a configured name or bare CAIP-2
reference, and `ccd://*/PATH` reads every configured network. Thus the 30 network rows are 90
registered resources; with the global network catalog and five skill resources, the server
registers 96 resources. Chain-client resources are request/response only and do not support
subscriptions.

| URI or template                                                                                                                                                                                                                                                | What it shows                                                                     |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `ccd://networks`                                                                                                                                                                                                                                               | Configured networks and the active default network.                               |
| `ccd://account/{account}`<br>`ccd://{network}/account/{account}`<br>`ccd://*/account/{account}`                                                                                                                                                                | Account summary selected by address, alias, account index, or configured label.   |
| `ccd://account/{account}/balances`<br>`ccd://{network}/account/{account}/balances`<br>`ccd://*/account/{account}/balances`                                                                                                                                     | CCD and protocol-level token balances keyed by token identifier.                  |
| `ccd://account/{account}/credentials`<br>`ccd://{network}/account/{account}/credentials`<br>`ccd://*/account/{account}/credentials`                                                                                                                            | Finalized public credential keys, read from cache or refreshed from chain.        |
| `ccd://account/{account}/next-sequence-number`<br>`ccd://{network}/account/{account}/next-sequence-number`<br>`ccd://*/account/{account}/next-sequence-number`                                                                                                 | Next account sequence number and finality status.                                 |
| `ccd://account/{account}/balances/{tokenId}`<br>`ccd://{network}/account/{account}/balances/{tokenId}`<br>`ccd://*/account/{account}/balances/{tokenId}`                                                                                                       | One CCD or protocol-level token balance.                                          |
| `ccd://account/{account}/stake`<br>`ccd://{network}/account/{account}/stake`<br>`ccd://*/account/{account}/stake`                                                                                                                                              | Validator or delegator staking details.                                           |
| `ccd://delegation/passive`<br>`ccd://{network}/delegation/passive`<br>`ccd://*/delegation/passive`                                                                                                                                                             | Passive delegation totals and commission.                                         |
| `ccd://delegation/{poolId}`<br>`ccd://{network}/delegation/{poolId}`<br>`ccd://*/delegation/{poolId}`                                                                                                                                                          | Validator-pool delegation totals, commission, status, and capacity.               |
| `ccd://block/{id}`<br>`ccd://{network}/block/{id}`<br>`ccd://*/block/{id}`                                                                                                                                                                                     | Block hash, height, slot time, era, and transaction count.                        |
| `ccd://block/{id}/events`<br>`ccd://{network}/block/{id}/events`<br>`ccd://*/block/{id}/events`                                                                                                                                                                | Transaction event summaries for a block.                                          |
| `ccd://block-item/{id}`<br>`ccd://{network}/block-item/{id}`<br>`ccd://*/block-item/{id}`                                                                                                                                                                      | Transaction status, inclusion block, kind, and serialized block-item hex.         |
| `ccd://block-item/{id}/effects`<br>`ccd://{network}/block-item/{id}/effects`<br>`ccd://*/block-item/{id}/effects`                                                                                                                                              | Transaction effect summaries.                                                     |
| `ccd://contract-instance/{addressOrLabel}`<br>`ccd://{network}/contract-instance/{addressOrLabel}`<br>`ccd://*/contract-instance/{addressOrLabel}`                                                                                                             | Contract instance module, owner, balance, contract name, and receive entrypoints. |
| `ccd://contract-instance/{addressOrLabel}/init/schema`<br>`ccd://{network}/contract-instance/{addressOrLabel}/init/schema`<br>`ccd://*/contract-instance/{addressOrLabel}/init/schema`                                                                         | Parsed contract initialization schema.                                            |
| `ccd://contract-instance/{addressOrLabel}/events/schema`<br>`ccd://{network}/contract-instance/{addressOrLabel}/events/schema`<br>`ccd://*/contract-instance/{addressOrLabel}/events/schema`                                                                   | Parsed contract event schema.                                                     |
| `ccd://contract-instance/{addressOrLabel}/receive/{entrypoint}/schema`<br>`ccd://{network}/contract-instance/{addressOrLabel}/receive/{entrypoint}/schema`<br>`ccd://*/contract-instance/{addressOrLabel}/receive/{entrypoint}/schema`                         | Parsed receive-entrypoint schema.                                                 |
| `ccd://modules`<br>`ccd://{network}/modules`<br>`ccd://*/modules`                                                                                                                                                                                              | Smart-contract module references.                                                 |
| `ccd://module/{moduleRef}`<br>`ccd://{network}/module/{moduleRef}`<br>`ccd://*/module/{moduleRef}`                                                                                                                                                             | Parsed module schema.                                                             |
| `ccd://module/{moduleRef}/contract/{contractName}`<br>`ccd://{network}/module/{moduleRef}/contract/{contractName}`<br>`ccd://*/module/{moduleRef}/contract/{contractName}`                                                                                     | Parsed schema for one module contract.                                            |
| `ccd://module/{moduleRef}/contract/{contractName}/init/schema`<br>`ccd://{network}/module/{moduleRef}/contract/{contractName}/init/schema`<br>`ccd://*/module/{moduleRef}/contract/{contractName}/init/schema`                                                 | Parsed initialization schema for one module contract.                             |
| `ccd://module/{moduleRef}/contract/{contractName}/events/schema`<br>`ccd://{network}/module/{moduleRef}/contract/{contractName}/events/schema`<br>`ccd://*/module/{moduleRef}/contract/{contractName}/events/schema`                                           | Parsed event schema for one module contract.                                      |
| `ccd://module/{moduleRef}/contract/{contractName}/receive/{entrypoint}/schema`<br>`ccd://{network}/module/{moduleRef}/contract/{contractName}/receive/{entrypoint}/schema`<br>`ccd://*/module/{moduleRef}/contract/{contractName}/receive/{entrypoint}/schema` | Parsed receive-entrypoint schema for one module contract.                         |
| `ccd://contract-instance-labels`<br>`ccd://{network}/contract-instance-labels`<br>`ccd://*/contract-instance-labels`                                                                                                                                           | Configured contract-instance labels.                                              |
| `ccd://locks`<br>`ccd://{network}/locks`<br>`ccd://*/locks`                                                                                                                                                                                                    | Protocol-level lock identifiers and network-qualified detail URIs.                |
| `ccd://lock/{lockId}`<br>`ccd://{network}/lock/{lockId}`<br>`ccd://*/lock/{lockId}`                                                                                                                                                                            | Protocol-level lock details.                                                      |
| `ccd://plts`<br>`ccd://{network}/plts`<br>`ccd://*/plts`                                                                                                                                                                                                       | Protocol-level token catalog.                                                     |
| `ccd://plt/{tokenId}`<br>`ccd://{network}/plt/{tokenId}`<br>`ccd://*/plt/{tokenId}`                                                                                                                                                                            | Protocol-level token details.                                                     |
| `ccd://chain/capabilities`<br>`ccd://{network}/chain/capabilities`<br>`ccd://*/chain/capabilities`                                                                                                                                                             | Chain features supported by the selected network.                                 |
| `ccd://account-labels`<br>`ccd://{network}/account-labels`<br>`ccd://*/account-labels`                                                                                                                                                                         | Configured account labels.                                                        |
| `ccd://consensus/status`<br>`ccd://{network}/consensus/status`<br>`ccd://*/consensus/status`                                                                                                                                                                   | Consensus status.                                                                 |

### Skill resources

These Markdown resources are also available through the MCP Skills extension.

| URI                                                   | What it shows                                                            |
| ----------------------------------------------------- | ------------------------------------------------------------------------ |
| `skill://ccd-network-discovery/SKILL.md`              | How to find the active default network or list configured networks.      |
| `skill://ccd-account-label-discovery/SKILL.md`        | How to find account labels and interpret their network scope.            |
| `skill://ccd-transfer/SKILL.md`                       | How to transfer CCD with the separated build, sign, and submit workflow. |
| `skill://ccd-plt-transfer/SKILL.md`                   | How to transfer protocol-level tokens with MCP tools.                    |
| `skill://ccd-sponsored-multisig-transaction/SKILL.md` | How to coordinate sponsored or multi-signature account transactions.     |

## Installation

Install the package from its project-specific GitHub Release asset. Follow
[Installing Release Assets](https://github.com/Concordium/ccd-agent-kit/blob/main/docs/release.md#installing-release-assets)
for checksum verification, installation, Node.js requirements, and release naming. This package
does not import the native PIV/PC/SC stack. It includes the repository's
[Apache License 2.0](https://github.com/Concordium/ccd-agent-kit/blob/main/LICENSE) as
`LICENSE`.

## Setup

This package has one binary, `ccd-chain-client-mcp`; there is no human transaction CLI.
`--help` is its only command-line interface:

```sh
ccd-chain-client-mcp --help
```

Replace every `REPLACE_*` placeholder below before use. Examples assume commands are available
on `PATH`; use the absolute executable paths shown in MCP host configuration.

Install `ccd-config-manager` separately to manage verified network entries. For a custom
network:

```sh
ccd-config-manager network add \
  --name REPLACE_NETWORK \
  --grpc-host REPLACE_NODE_HOST \
  --grpc-port REPLACE_NODE_PORT
ccd-config-manager network doctor --name REPLACE_NETWORK
ccd-config-manager network default set --name REPLACE_NETWORK
```

Network state uses standard XDG roots in the `ccd-agent-kit` namespace:

| Variable          | Default base     | Purpose                                 |
| ----------------- | ---------------- | --------------------------------------- |
| `XDG_CONFIG_HOME` | `~/.config`      | Network and chain-client configuration. |
| `XDG_DATA_HOME`   | `~/.local/share` | Public labels and catalogs.             |
| `XDG_STATE_HOME`  | `~/.local/state` | Cached account credentials and indexes. |

If you override these roots, give config manager and the MCP host the same values. The server
captures its default network and endpoint overrides at startup; restart after changing them.

| Variable              | Meaning                                                          | Default             |
| --------------------- | ---------------------------------------------------------------- | ------------------- |
| `CCD_NETWORK`         | Configured name, bare CAIP-2 reference, or full `ccd:REFERENCE`. | Configured default. |
| `CCD_GRPC_ENDPOINT`   | Default-network node as `host[:port]`.                           | Registry endpoint.  |
| `CCD_GRPC_TLS`        | `true` or `false`.                                               | Registry TLS value. |
| `CCD_GRPC_TIMEOUT_MS` | Positive request timeout in milliseconds.                        | `15000`.            |
| `MCP_TRANSPORT`       | `stdio` or `http`.                                               | `stdio`.            |
| `MCP_HTTP_PORT`       | HTTP port.                                                       | `3000`.             |
| `MCP_HTTP_PATH`       | HTTP path beginning with `/`.                                    | `/mcp`.             |

Startup refresh policy is persisted by config manager and may be overridden per process with
`CCD_ACCOUNT_CREDENTIALS_STARTUP_REFRESH`,
`CCD_ACCOUNT_CREDENTIALS_STARTUP_REFRESH_MAX_AGE`,
`CCD_ACCOUNT_CREDENTIALS_STARTUP_REFRESH_FAILURE_RETRY`, and
`CCD_ACCOUNT_CREDENTIALS_STARTUP_REFRESH_CONCURRENCY`. Refresh revisits only previously cached
accounts, uses finalized chain state, and is non-fatal.

### Stdio

Use the absolute executable path in the MCP host configuration:

```json
{
  "mcpServers": {
    "ccd-chain-client": {
      "command": "/ABSOLUTE/PATH/TO/ccd-chain-client-mcp",
      "env": {
        "CCD_NETWORK": "REPLACE_NETWORK"
      }
    }
  }
}
```

For a project-local install, use
`/ABSOLUTE/PATH/TO/PROJECT/node_modules/.bin/ccd-chain-client-mcp`. If the host supports `cwd`,
the equivalent command is `npx` with `args: ["--no-install", "ccd-chain-client-mcp"]` and the
absolute project directory as `cwd`.

### Streamable HTTP

```sh
MCP_TRANSPORT=http \
MCP_HTTP_PORT=3000 \
MCP_HTTP_PATH=/mcp \
CCD_NETWORK=REPLACE_NETWORK \
ccd-chain-client-mcp
```

HTTP is stateless. The built-in listener has no authentication or TLS, sends permissive CORS
headers, and has no bind-address setting. Do not expose it directly to an untrusted network;
restrict it locally or place it behind an authenticated TLS reverse proxy. Stdio is safer for a
local agent host.

## Safe Workflows

### Build, sign, and submit a transaction

1. Call the appropriate `build_*` tool; builders may query chain context but never sign or
   submit.
2. Review the returned `transactionHex` and signature requirements.
3. Pass the artifact to `ccd-signer` for detached sender or sponsor signatures.
4. Call `complete_transaction` to verify and combine signatures. Submission is false by default
   and must be explicitly requested.

### Open an account

1. Identity manager `prepare_account_opening` returns `credDeploymentHex`.
2. Signer `sign_credential` returns flat key-indexed detached signatures.
3. `complete_account_opening` verifies signatures and threshold, finalizes, and optionally
   submits. It accepts only a new-account handoff and defaults to no submission.

### Rotate credential keys

```text
build_update_credential_keys
→ sign with current account keys
→ complete_transaction with explicit submission authority
→ wait for finality
→ sync_account_credentials
```

Building, signing, preparation, and verification do not imply permission to submit. Confirm
broadcast authority separately. Never place private keys, PINs, passwords, wallet paths, or
other secrets in MCP arguments or environment variables.

## Troubleshooting

`label_account` and `label_contract_instance` can change only soft labels. Labels are metadata,
not chain or signing authority.

- On startup failure, inspect stderr, run `ccd-config-manager network list`, and test the endpoint
  with `network doctor --name REPLACE_NETWORK`.
- Confirm `CCD_NETWORK`, `CCD_GRPC_ENDPOINT`, and `CCD_GRPC_TLS` are not stale process overrides.
- Node failures expose a fixed safe message and, when available, a numeric node code. Unknown
  failures are sanitized.
- MCP stdout is reserved for protocol frames; diagnostics go to stderr.
