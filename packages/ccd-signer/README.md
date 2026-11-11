# @ccd-agent-kit/ccd-signer

Local Concordium CLI and stdio MCP server for transaction inspection, detached account and
message signatures, credential-deployment signatures, and offline finalization. It is the only
runtime allowed to use account-signing private material. It never queries the chain or submits
transactions.

| Contents                              |
| ------------------------------------- |
| [MCP tools](#mcp-tools)               |
| [MCP resources](#mcp-resources)       |
| [CLI usage](#cli-usage)               |
| [Installation](#installation)         |
| [Setup](#setup)                       |
| [Common workflows](#common-workflows) |
| [Troubleshooting](#troubleshooting)   |

Provision keys, devices, labels, module policy, and finalized account-credential observations
with `ccd-config-manager`. Query, complete, and explicitly submit artifacts with
`ccd-chain-client`. See the canonical
[architecture](https://github.com/Concordium/ccd-agent-kit/blob/main/docs/architecture.md#signer)
and [security model](https://github.com/Concordium/ccd-agent-kit/blob/main/docs/security.md).

## MCP Tools

Use MCP tool discovery for complete input and output schemas.

| Tool                   | What it can do                                                                                             |
| ---------------------- | ---------------------------------------------------------------------------------------------------------- |
| `label_signing_key`    | Set or remove an agent-modifiable signing-key label without changing hard labels or exposing custody data. |
| `describe_transaction` | Decode signed, unsigned, or finalized Concordium transaction or block-item hex for review.                 |
| `sign_transaction`     | Add detached sender or sponsor signatures to an unsigned transaction using available signer keys.          |
| `sign_credential`      | Sign a credential-deployment handoff for opening an account or adding a credential.                        |
| `sign_message`         | Sign exact text or hex bytes with an account this signer can sign for and return detached signatures.      |

MCP outputs omit private keys, passwords, PINs, backend paths, and control tokens. Signer accepts
no PIN through MCP.

## MCP Resources

The account family has three registered forms: `ccd://accounts` uses the default network,
`ccd://{network}/accounts` selects a configured name or bare CAIP-2 reference, and
`ccd://*/accounts` reads all configured networks. The server registers eight resources in total.

| URI or template                             | What it shows                                                                                                                     |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `ccd://networks`                            | Configured Concordium networks and the active default network.                                                                    |
| `ccd://keys`                                | Public signing keys visible to enabled signer modules, with optional local labels. This is the only subscribable signer resource. |
| `ccd://signer/instance`                     | Agent-safe status for this signer process, including unlock guidance when needed.                                                 |
| `ccd://accounts`                            | Accounts this signer can sign for on the default network.                                                                         |
| `ccd://{network}/accounts`                  | Accounts this signer can sign for on one selected network.                                                                        |
| `ccd://*/accounts`                          | Accounts this signer can sign for across all configured networks.                                                                 |
| `skill://ccd-network-discovery/SKILL.md`    | How to find the active default network or list configured networks.                                                               |
| `skill://ccd-signer-key-discovery/SKILL.md` | How to find cataloged public keys or signer-capable accounts.                                                                     |

Skill resources are also available through the MCP Skills extension.

## CLI Usage

Use uppercase values as placeholders and prefer files or stdin for artifacts and messages.
Do not put passwords, PINs, private keys, or sensitive messages in command arguments.

```sh
ccd-signer --help
ccd-signer-mcp --help

# Safe public inventory
ccd-signer list-keys

# Inspect a serialized transaction or block item
ccd-signer describe \
  --input-file /ABSOLUTE/PATH/TO/REPLACE_TRANSACTION_HEX.txt \
  --output text

# Produce detached sender signatures
ccd-signer sign \
  --network REPLACE_NETWORK \
  --input-file /ABSOLUTE/PATH/TO/REPLACE_UNSIGNED_TRANSACTION.txt \
  --role sender \
  --key REPLACE_CREDENTIAL_INDEX:REPLACE_KEY_INDEX

# Sign exact UTF-8 bytes read from a protected file
ccd-signer sign-message \
  --network REPLACE_NETWORK \
  --account REPLACE_ACCOUNT_ADDRESS_OR_LABEL \
  --input-file /ABSOLUTE/PATH/TO/REPLACE_MESSAGE.txt \
  --format text

# Finalize offline after collecting required detached signatures
ccd-signer finalize \
  --input-file /ABSOLUTE/PATH/TO/REPLACE_UNSIGNED_TRANSACTION.txt \
  --signatures-file /ABSOLUTE/PATH/TO/REPLACE_SIGNATURES.json \
  --signature-requirements 'REPLACE_WITH_BUILDER_SIGNATURE_REQUIREMENTS_JSON'
```

`sign` and `sign-message` require previously refreshed finalized account credentials; signer
does not fetch them. Message input is exactly one of UTF-8 text or exact hex and is not trimmed.
`describe`, `finalize`, and `list-keys` are offline/global and ignore network selection. Use a
leaf command's `--help` for exact JSON shapes and selection controls.
CLI help is available only through `-h` and `--help`; there is no help subcommand or help alias.

## Installation

Install the package from its project-specific GitHub Release asset. Follow
[Installing Release Assets](https://github.com/Concordium/ccd-agent-kit/blob/main/docs/release.md#installing-release-assets)
for checksum verification, installation, Node.js and native PC/SC prerequisites, and release
naming. Installation includes native `pcsclite`, even for software-only signing, and therefore
requires PC/SC development headers, `pkg-config`, and native build tools. Hardware-backed signing
also requires a working PC/SC service and supported device. The package includes the repository's
[Apache License 2.0](https://github.com/Concordium/ccd-agent-kit/blob/main/LICENSE) as
`LICENSE`.

## Setup

Signer reads shared XDG state under `ccd-agent-kit`. Network selection is explicit `--network`,
then `CCD_NETWORK`, then the configured default.

Replace every `REPLACE_*` placeholder below before use. Examples assume commands are available
on `PATH`; from a project-local installation, use `npx --no-install`.

| Variable          | Default base           | Purpose                                         |
| ----------------- | ---------------------- | ----------------------------------------------- |
| `XDG_CONFIG_HOME` | `~/.config`            | Configuration.                                  |
| `XDG_DATA_HOME`   | `~/.local/share`       | Persistent catalogs and protected key material. |
| `XDG_STATE_HOME`  | `~/.local/state`       | Cached credentials and operational state.       |
| `XDG_RUNTIME_DIR` | Under state when unset | Local MCP instance control.                     |

If you override these roots, give config manager, signer CLI, and the MCP host the same values.
Install `ccd-config-manager` separately and configure at least one backend. This software-key
example adds a custom network; use `mainnet` or `testnet` instead if already configured.

```sh
ccd-config-manager network add \
  --name REPLACE_NETWORK \
  --grpc-host REPLACE_NODE_HOST \
  --grpc-port REPLACE_NODE_PORT
ccd-config-manager network doctor --name REPLACE_NETWORK
ccd-config-manager network default set --name REPLACE_NETWORK
ccd-config-manager storage init --storage encrypted-file
ccd-config-manager service signer module enable --module software-signer
ccd-config-manager signing-key import --backend software \
  --file /ABSOLUTE/PATH/TO/REPLACE_WALLET_EXPORT.json \
  --label REPLACE_KEY_LABEL
ccd-config-manager account credentials refresh \
  --address REPLACE_ACCOUNT_ADDRESS \
  --network REPLACE_NETWORK
```

For a new software key, replace the import command with `ccd-config-manager signing-key generate
--backend software --label REPLACE_KEY_LABEL`. It writes only to encrypted-file storage and emits
no private key or intermediate key file.

For YubiKey custody, register and provision the device with `ccd-config-manager`, then enable
`yubikey-piv` with `ccd-config-manager service signer module enable --module yubikey-piv`.

### MCP launch configuration

`ccd-signer-mcp` is stdio-only. Use the absolute executable path in the MCP host configuration:

```json
{
  "mcpServers": {
    "ccd-signer": {
      "command": "/ABSOLUTE/PATH/TO/ccd-signer-mcp",
      "env": {
        "CCD_NETWORK": "REPLACE_NETWORK"
      }
    }
  }
}
```

For a project-local install, use `/ABSOLUTE/PATH/TO/PROJECT/node_modules/.bin/ccd-signer-mcp`.
If the host supports `cwd`, the equivalent command is `npx` with
`args: ["--no-install", "ccd-signer-mcp"]` and the absolute project directory as `cwd`.

## Common Workflows

### Transaction signing

1. Build unsigned `transactionHex` and signature requirements with `ccd-chain-client`.
2. Review with `describe_transaction` or the CLI `describe` command.
3. Sign each required `sender` or `sponsor` role with `sign_transaction`.
4. Complete and, only with separate broadcast authority, submit through chain client's
   `complete_transaction`.

### New-account opening

1. `ccd-id-manager` prepares `credDeploymentHex` using external public credential keys.
2. Signer `sign_credential` returns detached flat key-indexed signatures.
3. Chain client `complete_account_opening` verifies threshold signatures, finalizes, and
   optionally submits. Submission defaults to false.

Preparing or signing does not authorize disclosure or broadcast. Confirm authority for the exact
network, account, attributes, artifact, and effect before each sensitive step.

## Troubleshooting

Encrypted software storage is process-locked at MCP startup. Control it through authenticated
local config-manager commands; passwords never enter MCP inputs. See the canonical
[encrypted software-key storage design](https://github.com/Concordium/ccd-agent-kit/blob/main/docs/architecture.md#encrypted-software-key-storage)
for format, backup, password-change, and memory-clearing limits.

```sh
ccd-config-manager service signer instances
ccd-config-manager service signer unlock --instance REPLACE_INSTANCE_ID
ccd-config-manager service signer lock --instance REPLACE_INSTANCE_ID
```

- If no key is available, check `ccd-config-manager service signer module inspect --module
software-signer`, `ccd-signer list-keys`, account credential refresh, and software lock or device
  state. Inspect `yubikey-piv` instead when diagnosing that backend.
- Signer watches relevant device insertion and removal, not catalog or policy files. Restart if a
  config-manager best-effort refresh is not observed.
- On PC/SC failure, verify the service, device visibility, native prerequisites, and that
  `pcsclite` was built for the active Node version.
- MCP stdout is protocol-only; startup and transport diagnostics go to stderr.
