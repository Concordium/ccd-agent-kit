# @ccd-agent-kit/ccd-id-manager

Concordium identity CLI and stdio MCP server for hardware-rooted identity derivation, issuance
and recovery, encrypted local storage, bounded discovery, identity proofs, and account-opening
preparation. It never derives account-signing keys, signs account transactions or credential
deployments, or submits them.

| Contents                                          |
| ------------------------------------------------- |
| [Installation](#installation)                     |
| [Setup](#setup)                                   |
| [MCP tools](#mcp-tools)                           |
| [MCP resources](#mcp-resources)                   |
| [CLI usage](#cli-usage)                           |
| [Account opening](#account-opening)               |
| [Diagnostics and safety](#diagnostics-and-safety) |
| [License](#license)                               |

`ccd-config-manager` provisions the PIV identity root and manages source-backend policy;
`ccd-signer` owns account signatures; `ccd-chain-client` owns completion and submission. See the
canonical
[identity architecture](https://github.com/Concordium/ccd-agent-kit/blob/main/docs/architecture.md#identity-manager)
and [security model](https://github.com/Concordium/ccd-agent-kit/blob/main/docs/security.md#identity-manager).

## Installation

```sh
# Global installation (recommended)
npm install --global @ccd-agent-kit/ccd-id-manager

# Project-local installation
npm install @ccd-agent-kit/ccd-id-manager
```

Node.js `>=22.23.4` is required. Identity operations require a YubiKey 5 Series device with PIV
enabled, firmware `>=5.3.0`, P-256 ECDH, and the Yubico GET METADATA extension used to read public
keys and PIN/touch policy; see the [Yubico PIV extensions](https://developers.yubico.com/PIV/Introduction/Yubico_extensions.html).

**(for full compatibility with the signer, firmware `>=5.7.4` is recommended.)**

A working PC/SC service and development headers, `pkg-config`, and native build tools for
`pcsclite` are required. Connect the device over USB/CCID. Older YubiKey 4/NEO and FIDO-only
Security Keys and Bio FIDO editions do not meet these requirements. Check the model and firmware
with `ykman info` (YubiKey Manager CLI).

## Setup

Replace every `REPLACE_*` placeholder below before use. Examples assume commands are available
on `PATH`; from a project-local installation, use `npx --no-install`.

Network selection is explicit global `--network`, then `CCD_NETWORK`, then the configured default.
PIN entry, root generation or adoption, device registration, and backend policy belong to
`ccd-config-manager`, not identity-manager CLI or MCP inputs.

### Bootstrap an identity source

Install `ccd-config-manager` separately, then prepare the hardware before configuring identities:

1. **Prepare YubiKey PIV.** Confirm PC/SC and PIV work. Before real use, use YubiKey tooling to set
   and securely store a non-default PIN, PUK, and management key. This application neither resets the
   device nor changes PIN/PUK. Provisioning needs the PIN and management key via hidden prompts—not
   arguments, environment variables, or MCP.

2. **Register the device.** Find its decimal serial and assign a local name; skip if already registered.

   ```sh
   ccd-config-manager device list
   ccd-config-manager device register --name REPLACE_DEVICE_NAME --serial REPLACE_DECIMAL_SERIAL
   ```

3. (a) **Creating and cataloging a new identity root on a new device.**

   Generate a hardware-only P-256 root in fixed slot `9d`.
   The `yubikey-piv` backend is enabled by default; no enable
   command is needed unless it was previously disabled.

   ```sh
   ccd-config-manager identity-root generate --backend yubikey-piv \
     --device REPLACE_DEVICE_NAME --pin-policy once \
     --label REPLACE_SOURCE_LABEL
   ```

   (b) **Adopting an existing identity root on a pre-initialised device.**
   If slot `9d` already contains the intended root, adopt it instead and verify the exact `TRUST`
   fingerprint prompt:

   ```sh
   ccd-config-manager identity-root adopt --backend yubikey-piv --device REPLACE_DEVICE_NAME \
     --label REPLACE_SOURCE_LABEL
   ```

   Select either root with `ccd-config-manager identity-root default set --identity-root REPLACE_SOURCE_LABEL`.

   Never overwrite or reset an existing root: losing it loses access to encrypted identity data;
   no software identity-root backend exists. The root is device-wide and global; select mainnet or
   testnet later. The same device may hold a separate signer Ed25519 key in slot `9c`.

4. **Unlock the device locally.** Run
   `ccd-config-manager device unlock --device REPLACE_DEVICE_NAME` and enter the hidden PIN prompt.

   With `--pin-policy once`, unlock again after a device reset or removal. MCP never accepts a PIN.

### Configuring identity providers

Replace `REPLACE_NETWORK` with the built-in `mainnet` or `testnet`, as appropriate. These commands
do not change the configured default network.

1. **Discover network provider configuration.** This reads finalized identity-provider (IP),
   anonymity-revoker (AR), and global cryptographic parameters from the configured node, validates
   them, and updates the local cache. It does not use the YubiKey, create a request, trust an
   endpoint, or enable a provider.

   ```sh
   ccd-id-manager idp discover --network REPLACE_NETWORK
   ```

2. **List and inspect providers.** These commands use the local cache without contacting the node.
   Inspect the intended provider and use its index or configured label rather than guessing.

   ```sh
   ccd-id-manager idp list --network REPLACE_NETWORK
   ccd-id-manager idp inspect \
     --idp REPLACE_IDP_INDEX_OR_LABEL \
     --network REPLACE_NETWORK
   ```

3. **Configure and enable the provider for the tool.** Choose trusted issuance and recovery
   endpoints independently; node-discovered descriptions do not grant endpoint trust. Labels are
   local selectors.

   ```sh
   ccd-id-manager idp configure \
     --idp REPLACE_IDP_INDEX \
     --label REPLACE_IDP_LABEL \
     --issuance https://REPLACE_ISSUANCE_ENDPOINT \
     --recovery https://REPLACE_RECOVERY_ENDPOINT \
     --issuance-method POST \
     --ars 1,3,5 \
     --ar-threshold 2 \
     --network REPLACE_NETWORK
   ccd-id-manager idp enable \
     --idp REPLACE_IDP_LABEL \
     --network REPLACE_NETWORK
   ```

   Replace `1,3,5` with actual finalized AR identity IDs, not array positions. Omitting `--ars`
   selects all fresh finalized ARs; the default threshold is selected-count minus one, while a
   single selected AR requires explicit `--ar-threshold 1`. POST issuance has a fixed body.

Enabling permits a future identity request; it does not create an identity. Continue with the
request or recovery commands in [CLI Usage](#cli-usage). Identity manager never signs an account
transaction or credential deployment.

### MCP launch configuration

`ccd-id-manager-mcp` is stdio-only. Use its absolute executable path:

```json
{
  "mcpServers": {
    "ccd-id-manager": {
      "command": "/ABSOLUTE/PATH/TO/ccd-id-manager-mcp",
      "env": {
        "CCD_NETWORK": "REPLACE_NETWORK"
      }
    }
  }
}
```

For a project-local install, use
`/ABSOLUTE/PATH/TO/PROJECT/node_modules/.bin/ccd-id-manager-mcp`. If the host supports `cwd`, the
equivalent command is `npx` with `args: ["--no-install", "ccd-id-manager-mcp"]` and the absolute
project directory as `cwd`.

### Customisation

Shared and protected state lives below the standard XDG roots in the `ccd-agent-kit` namespace.
Identity stores are network-scoped under `$XDG_DATA_HOME/ccd-agent-kit/id-manager/` and encrypted
with material derived from the cataloged P-256 root in fixed PIV slot `9d`.

| Variable          | Default base           | Purpose                                        |
| ----------------- | ---------------------- | ---------------------------------------------- |
| `XDG_CONFIG_HOME` | `~/.config`            | Network, provider, and backend configuration.  |
| `XDG_DATA_HOME`   | `~/.local/share`       | Protected identity stores and public catalogs. |
| `XDG_STATE_HOME`  | `~/.local/state`       | Indexes and operational state.                 |
| `XDG_RUNTIME_DIR` | Under state when unset | Local MCP instance control.                    |

If you override these roots, give config manager, identity CLI, and the MCP host the same values.

## MCP Tools

Use MCP tool discovery for complete input and output schemas.

| Tool                           | What it can do                                                                                                                                   |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `request_identity`             | Request an identity from an enabled provider, optionally assigning an agent-modifiable label.                                                    |
| `recover_identity`             | Recover an identity from an enabled provider and configured identity source.                                                                     |
| `prepare_account_opening`      | Prepare an unsigned new-account handoff using external public keys; selected identity attributes become public if submitted.                     |
| `reconcile_account_opening`    | Reconcile a pending account opening against one finalized block.                                                                                 |
| `discover_identities`          | Perform bounded identity discovery, recovery, and storage without exposing identity contents.                                                    |
| `discover_account_credentials` | Discover account credential indexes without signing.                                                                                             |
| `label_identity`               | Set or remove an agent-modifiable identity label.                                                                                                |
| `label_identity_source`        | Set or remove a soft identity-source label without changing hard labels or exposing hardware locations.                                          |
| `validate_proof_request`       | Validate a finalized Verify & Access request anchor and optionally return its exact requester context and claims; domain binding is not checked. |
| `find_proof_candidates`        | Find whole-request matches from local attributes and cached account associations without chain reads or attribute values.                        |
| `create_identity_proof`        | Create a Verify & Access presentation after exact request and disclosure approval; revalidate the anchor and never submit.                       |

Network-aware tools use the selected network; omission uses `CCD_NETWORK` and then the configured
default. MCP accepts no PIN and exposes no root, identity secret, full identity object, protected
path, or hardware locator.

## MCP Resources

Each network family has default, explicit, and wildcard registrations. The server registers eight
resources in total. Only the three identity-inventory forms support subscriptions.

| URI or template                            | What it shows                                                                             |
| ------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `ccd://identities`                         | Safe stored identity summaries on the default network.                                    |
| `ccd://{network}/identities`               | Safe stored identity summaries on one configured name or bare CAIP-2 reference.           |
| `ccd://*/identities`                       | Safe stored identity summaries across all configured networks.                            |
| `ccd://identity-providers`                 | Safe local identity-provider inventory on the default network.                            |
| `ccd://{network}/identity-providers`       | Safe local identity-provider inventory on one selected network.                           |
| `ccd://*/identity-providers`               | Safe local identity-provider inventory across all configured networks.                    |
| `ccd://identity-sources`                   | Safe global summaries of enrolled identity sources, availability, and the default source. |
| `skill://ccd-identity-management/SKILL.md` | Identity readiness, issuance, recovery, discovery, account opening, and proof workflows.  |

The skill resource is also available through the MCP Skills extension. Identity manager
intentionally does not serve the shared network-discovery skill.

## CLI Usage

```sh
ccd-id-manager --help
ccd-id-manager-mcp --help

# Request and monitor an identity
ccd-id-manager identity request \
  --idp REPLACE_IDP_LABEL \
  --source REPLACE_SOURCE_LABEL \
  --label REPLACE_IDENTITY_LABEL \
  --network REPLACE_NETWORK
ccd-id-manager identity list --network REPLACE_NETWORK
ccd-id-manager identity status \
  --identity REPLACE_IDENTITY_ID \
  --network REPLACE_NETWORK

# Recover or perform bounded discovery
ccd-id-manager identity recover \
  --idp REPLACE_IDP_LABEL \
  --source REPLACE_SOURCE_LABEL \
  --identity-index REPLACE_NONNEGATIVE_INDEX \
  --network REPLACE_NETWORK
ccd-id-manager identity discover \
  --source REPLACE_SOURCE_LABEL \
  --idp REPLACE_IDP_LABEL \
  --gap-limit 3 \
  --network REPLACE_NETWORK

# Prepare an unsigned new-account handoff
ccd-id-manager account prepare \
  --identity REPLACE_IDENTITY_ID_OR_LABEL \
  --public-keys '{"0":"REPLACE_64_HEX_ED25519_PUBLIC_KEY"}' \
  --credential-threshold 1 \
  --expiry-seconds REPLACE_UNIX_SECONDS \
  --network REPLACE_NETWORK
```

`account prepare` returns `credDeploymentHex`; it does not approve disclosure, sign, or submit.
`--reveal-attribute` makes selected values public on-chain if the completed artifact is submitted.
Never pass private keys, PINs, identity objects, or provider credentials on the command line.
Use a leaf command's `--help` for the complete option set.
CLI help is available only through `-h` and `--help`; there is no help subcommand or help alias.

## Account Opening

1. Prepare `credDeploymentHex` here using public keys controlled by `ccd-signer`.
2. Call signer MCP `sign_credential` with the handoff and required key indexes.
3. Call chain-client MCP `complete_account_opening` with the handoff and flat detached signatures.
   Leave `submit` false for review; set it true only with broadcast authority.
4. After finality, run `ccd-id-manager account reconcile --identity REPLACE_IDENTITY_ID
--network REPLACE_NETWORK`.

Signer and chain client are separate installs and MCP servers; identity manager does not invoke
or import them.

## Diagnostics And Safety

- `ccd-config-manager identity-root list`, `ccd-config-manager service id-manager module inspect
--backend yubikey-piv`, and `ccd-config-manager service id-manager instances` distinguish catalog,
  policy, and live-process state. None alone proves hardware readiness.
- Identity manager observes relevant device insertion and removal but does not watch source or
  policy files. Restart if a config-manager best-effort refresh is not observed.
- Provider operations use configured endpoints and fresh finalized context. Redirects, untrusted
  response URLs, and node errors do not grant endpoint authority or prove absence.
- On PC/SC failure, verify the service, device visibility, slot `9d`, native prerequisites, and
  that `pcsclite` was built for the active Node version.
- MCP stdout is protocol-only; startup errors are sanitized on stderr.

## License

The package includes the repository's
[Apache License 2.0](https://github.com/Concordium/ccd-agent-kit/blob/main/LICENSE) as `LICENSE`.
