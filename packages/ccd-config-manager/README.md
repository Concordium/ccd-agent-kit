# @ccd-agent-kit/ccd-config-manager

Operator CLI for configuring Concordium networks, public catalogs and labels, signer and
identity-manager policy, software signing-key storage, YubiKey PIV provisioning, and local
runtime control. It does **not** sign and does not provide an MCP server.

`ccd-signer` owns runtime account signing, `ccd-id-manager` owns identity derivation and identity
objects, and `ccd-chain-client` owns node queries and submission. See the canonical
[architecture](https://github.com/Concordium/ccd-agent-kit/blob/main/docs/architecture.md) and
[security model](https://github.com/Concordium/ccd-agent-kit/blob/main/docs/security.md).

| Contents                                          |
| ------------------------------------------------- |
| [CLI commands](#cli-commands)                     |
| [CLI usage](#cli-usage)                           |
| [Installation](#installation)                     |
| [Setup](#setup)                                   |
| [Safety and diagnostics](#safety-and-diagnostics) |

## CLI Commands

| Object              | Subcommands                                                                                                    |
| ------------------- | -------------------------------------------------------------------------------------------------------------- |
| `signing-key`       | `list`, `inspect`, `generate`, `import`, `adopt`, `forget`, `label`, `locations`, `backend`                    |
| `identity-root`     | `list`, `inspect`, `generate`, `import`, `adopt`, `forget`, `label`, `default`, `backend`, `locations`         |
| `storage`           | `list`, `inspect`, `init`, `enable`, `disable`, `change-password`, `integrity`                                 |
| `device`            | `list`, `inspect`, `register`, `rename`, `unregister`, `pin-status`, `unlock`, `lock`, `defaults`, `integrity` |
| `account`           | `label list`, `inspect`, `find`, `set`, `remove`; `credentials list`, `inspect`, `refresh`, `remove`           |
| `contract-instance` | `label list`, `inspect`, `find`, `set`, `remove`                                                               |
| `network`           | `list`, `inspect`, `add`, `update`, `remove`, `default show`, `default set`, `doctor`                          |
| `service`           | Signer/identity-manager instances and module policy; chain-client settings; signer lock control                |
| `paths`             | Print shared configuration, state, and signer data paths.                                                      |

Run `ccd-config-manager --help` for the current command catalog or
`ccd-config-manager COMMAND --help` for a command's subcommands and options.
Help is available only through `-h` and `--help`; the command tree has no help subcommand or help
alias.

## CLI Usage

Signing-key and identity-root `list` commands show identifiers, labels, backend IDs, and default
status where applicable; `inspect` shows the full record and custody locations.

Replace every `REPLACE_*` placeholder before use. Examples assume commands are available on
`PATH`; from a project-local installation, use `npx --no-install`.

```sh
ccd-config-manager --help

# Protected operator labels (new labels default to hard)
ccd-config-manager account label set \
  --address REPLACE_ACCOUNT_ADDRESS \
  --label REPLACE_ACCOUNT_LABEL \
  --network REPLACE_NETWORK
ccd-config-manager contract-instance label set \
  --address REPLACE_INDEX,REPLACE_SUBINDEX \
  --label REPLACE_CONTRACT_LABEL \
  --network REPLACE_NETWORK

# Runtime discovery and encrypted software-store lock state
ccd-config-manager service signer instances
ccd-config-manager service signer unlock --instance REPLACE_INSTANCE_ID
ccd-config-manager service signer lock --instance REPLACE_INSTANCE_ID
ccd-config-manager service id-manager instances

# Chain-client startup cache policy
ccd-config-manager service chain-client startup-refresh set \
  --enabled true --max-age 24h --failure-retry 5m --concurrency 3
ccd-config-manager service chain-client inspect
```

Hard labels are operator-protected. Agent-facing servers can only create, replace, or remove soft
labels in their own domains. Labels are metadata, never signing or custody authority.

This is an object-first tree with no compatibility aliases for the former `software`, `yubikey`,
`account-label`, `account-credentials`, `signer`, `id-manager`, or `chain-client` paths. Provisioning
uses required `--backend software|yubikey-piv`; catalog location operations instead use persisted
backend IDs (`software-signer|yubikey-piv`). Software storage uses the separate
`--storage encrypted-file` selector where a storage target is required.

After covered catalog or policy changes, config manager best-effort refreshes active signer or
identity-manager instances. Restart the affected process if the new state is not observed.
Runtime module status reports persisted policy, not key or hardware readiness.

## Installation

Install the package from its project-specific GitHub Release asset. Follow
[Installing Release Assets](https://github.com/Concordium/ccd-agent-kit/blob/main/docs/release.md#installing-release-assets)
for checksum verification and installation. Node.js `>=22.23.4` is required.

Installation includes the native `pcsclite` dependency, even for software-key use, and therefore
requires PC/SC development headers, `pkg-config`, and a native build toolchain. On Debian/Ubuntu,
install `libpcsclite-dev pkg-config python3 make g++` before installing the package. Hardware
operations also require a working PC/SC service and a supported device. The package includes the
repository's [Apache License 2.0](https://github.com/Concordium/ccd-agent-kit/blob/main/LICENSE) as
`LICENSE`.

## Setup

### State and network selection

State is stored below the standard XDG roots in one `ccd-agent-kit` namespace:

```text
$XDG_CONFIG_HOME/ccd-agent-kit/  (default: ~/.config/ccd-agent-kit/)
$XDG_DATA_HOME/ccd-agent-kit/    (default: ~/.local/share/ccd-agent-kit/)
$XDG_STATE_HOME/ccd-agent-kit/   (default: ~/.local/state/ccd-agent-kit/)
$XDG_RUNTIME_DIR/ccd-agent-kit/  (runtime instance control when set)
```

Set the XDG variables to base directories, without the `ccd-agent-kit` suffix. Give all companion
tools and their hosts the same values when overriding them; GUI hosts may need explicit `env`
entries. Runtime instance control falls back under state when `XDG_RUNTIME_DIR` is unset.

Protected paths reject unsafe permissions and symlinks. `paths` is a local diagnostic that can
reveal sensitive locations; do not publish its output.

Network-aware commands use an explicit selector, then `CCD_NETWORK`, then the persisted default.
A selector can be a configured name, bare 32-hex CAIP-2 reference, or full `ccd:REFERENCE`.
Create and test an operator network first:

```sh
ccd-config-manager network add \
  --name REPLACE_NETWORK \
  --grpc-host REPLACE_NODE_HOST \
  --grpc-port REPLACE_NODE_PORT
ccd-config-manager network doctor --name REPLACE_NETWORK
ccd-config-manager network default set --name REPLACE_NETWORK
ccd-config-manager network inspect --name REPLACE_NETWORK
```

`network add` detects and records genesis identity and TLS mode from the endpoint. An update is
accepted only when the endpoint reports the same full genesis hash.

### Initial signer configuration

#### Encrypted software keys

Initialize encrypted storage, enable the runtime module, and import a key. Password and raw
private-key prompts are hidden; do not put either value in arguments or environment variables.

```sh
ccd-config-manager storage init --storage encrypted-file
ccd-config-manager service signer module enable --module software-signer
ccd-config-manager signing-key import --backend software \
  --file /ABSOLUTE/PATH/TO/REPLACE_WALLET_EXPORT.json \
  --label REPLACE_KEY_LABEL
ccd-config-manager signing-key list
```

To create a new key instead, run `ccd-config-manager signing-key generate --backend software
--label REPLACE_KEY_LABEL`. Generation writes fresh cryptographic key bytes directly to encrypted
storage and outputs only public metadata.

To catalog one existing managed encrypted key file, unlock its storage and verify its expected
public key explicitly:

```sh
ccd-config-manager signing-key adopt --backend software \
  --storage encrypted-file \
  --public-key REPLACE_64_HEX_ED25519_PUBLIC_KEY \
  --label REPLACE_KEY_LABEL
```

Omit `--label` if none is wanted. Adoption derives the only eligible path from the public key,
decrypts and verifies that file, and catalogs it without rewriting it. It has no arbitrary-path or
bulk form and does not use the PIV `TRUST` confirmation ceremony.

The imported file is an input source, not a durable account-to-key binding. Refresh finalized
public credentials before account signing:

```sh
ccd-config-manager account credentials refresh \
  --address REPLACE_ACCOUNT_ADDRESS \
  --network REPLACE_NETWORK
```

#### YubiKey signing keys

Register a friendly device name, enable the signer backend, then generate or adopt a signing key.
Ed25519 signing uses slot `9c` by default or explicit `9c`/`82` through `95`.

```sh
ccd-config-manager device list
ccd-config-manager device register \
  --name REPLACE_DEVICE_NAME \
  --serial REPLACE_DECIMAL_SERIAL
ccd-config-manager service signer module enable --module yubikey-piv
ccd-config-manager signing-key generate --backend yubikey-piv \
  --device REPLACE_DEVICE_NAME \
  --label REPLACE_KEY_LABEL
```

Use `signing-key adopt --backend yubikey-piv` only for an existing occupied Ed25519 slot after checking the
displayed fingerprint. Forgetting catalog metadata does not erase hardware.
Generation or import replacement requires `--force` plus exact interactive confirmation.

Catalog location order/forget commands take `--backend software-signer|yubikey-piv` and an exact
JSON location object (or exact JSON-array permutation for order). They preserve the existing
version-1 payloads. Forgetting metadata never deletes a software key file or changes hardware; a
final forgotten location prunes the now-empty public key/root record and a forgotten identity root
clears its matching default.

Signing-key catalog lookups use one required `--signing-key <public-key-or-label>` selector. In
`signing-key label set --signing-key CURRENT_KEY_LABEL --label REPLACEMENT_KEY_LABEL`, the selector
identifies the existing record while `--label` assigns its new label. Forget an entire record with
`signing-key forget --signing-key <public-key-or-label>`; private key material remains untouched.

### Initial identity-manager configuration

Identity roots are P-256 keys in fixed PIV slot `9d`. Config manager provisions and catalogs the
root; identity-provider configuration and identity workflows remain in `ccd-id-manager`.

For identity-only setup, register the device first. Skip this command if that device name is
already registered:

```sh
ccd-config-manager device register \
  --name REPLACE_DEVICE_NAME \
  --serial REPLACE_DECIMAL_SERIAL
```

```sh
ccd-config-manager service id-manager module enable --backend yubikey-piv
ccd-config-manager identity-root generate --backend yubikey-piv \
  --device REPLACE_DEVICE_NAME \
  --label REPLACE_SOURCE_LABEL
ccd-config-manager identity-root default set \
  --identity-root REPLACE_SOURCE_LABEL
ccd-config-manager identity-root list
```

To trust a root already in slot `9d`, use `identity-root adopt --backend yubikey-piv --device
REPLACE_DEVICE_NAME --label REPLACE_SOURCE_LABEL` and verify the exact fingerprint prompt. No
software identity-root backend exists. Continue with the
[`ccd-id-manager` provider setup](https://github.com/Concordium/ccd-agent-kit/blob/main/packages/ccd-id-manager/README.md#configure-an-identity-provider).

## Safety And Diagnostics

- Private keys, PINs, management keys, and passwords must be entered only through hidden
  interactive prompts. Never place them in shell arguments, environment variables, logs, or host
  configuration.
- Config manager may handle key material transiently during explicit import or provisioning, but
  it has no signing command and no MCP binary.
- `device inspect`, `device integrity`, `storage inspect`, and service module `inspect` are useful
  first checks. `device integrity --fix` requires one `--device` and only repairs confirmed
  catalog state; it never adopts or mutates hardware.
- `storage integrity --storage encrypted-file` reports healthy, missing, invalid, and adoptable
  orphan state after password unlock. Adding `--fix` only prunes confirmed missing catalog
  references; it never adopts an orphan or rewrites a key file. Use the targeted signing-key adopt
  command above for an adoptable orphan.
- If PC/SC loading fails, confirm the service is running, development libraries were present when
  npm installed `pcsclite`, the device is visible, and the native module matches the active Node
  version.
- If a network operation fails, run `network list`, `network doctor --name REPLACE_NETWORK`, and
  verify `CCD_NETWORK` is not overriding the intended default.
